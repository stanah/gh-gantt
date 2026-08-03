import type { graphql } from "@octokit/graphql";
import {
  mutationCommandFingerprint,
  type Config,
  type MutationPrimitiveStep,
  type MutationProposal,
  type MutationSuccessorPlanRevision,
  type RunGraphAcceptedEvent,
  type SyncState,
  type Task,
  type TasksFile,
} from "@gh-gantt/shared";
import { createGraphQLClient } from "../github/client.js";
import { GitHubLiveApprovalEvidenceAdapter } from "../github/approval-evidence.js";
import { fetchIssueRelationships } from "../github/sub-issues.js";
import {
  MUTATION_CORRELATION_ISSUES_QUERY,
  MUTATION_ISSUE_PROJECT_ITEMS_QUERY,
  MUTATION_POSTCONDITION_QUERY,
  MUTATION_PROJECT_ITEM_FIELDS_QUERY,
} from "../github/queries.js";
import { RunGraphControlPlane } from "../run-graph/control-plane.js";
import { RunGraphEventStore } from "../store/run-graph.js";
import { RunActivityInspector } from "../run-graph/run-activity-inspector.js";
import { MutationProposalStore } from "../store/mutation-proposals.js";
import {
  DispatchClaimStore,
  type MutationReservationProof,
  type MutationReservationResult,
} from "../store/dispatch-claims.js";
import { withProjectStorage } from "../store/project-storage.js";
import { hasUnresolvedMarkers } from "../sync/conflict-marker.js";
import { extractSyncFields } from "../sync/hash.js";
import { canonicalBlockedBy } from "../sync/mutation-remote-projection.js";
import { resolveTaskTypeBinding } from "../sync/type-resolver.js";
import {
  executePush,
  reifyDraftTask,
  type PushStepOutcome,
  type PushStepReservation,
} from "../sync/push-executor.js";
import { WorkGraphCommandEngine } from "./command-engine.js";
import { HumanApprovalAuthority } from "./human-approval-authority.js";
import type {
  GitHubApprovalCommentRef,
  HumanApprovalVerification,
  MutationBoundDecision,
} from "./human-approval-authority.js";
import type {
  MutationApplyValidation,
  MutationCoordinationCapability,
  MutationFenceContext,
  MutationOriginResolution,
  MutationProposalAuditEvent,
  MutationProposalEnvironment,
  MutationSnapshot,
  MutationStepOutcome,
  MutationStepPreparation,
  MutationStepReconciliation,
} from "./mutation-control-plane.js";

export interface ProductionMutationEnvironmentDependencies {
  createGraphQLClient?: () => Promise<typeof graphql>;
  inspector?: RunActivityInspector;
  runControlPlane?: RunGraphControlPlane;
  createRunControlPlane?: (projectRoot: string) => RunGraphControlPlane;
  now?: () => string;
  storageRunner?: typeof withProjectStorage;
  pushExecutor?: typeof executePush;
  /** テスト専用: 永続的なlocal preparation記録後のプロセス境界を模擬する。 */
  afterLocalPreparationRecorded?: () => Promise<void>;
  claimStore?: DispatchClaimStore;
  applicationStore?: Pick<MutationProposalStore, "assertApplication" | "withApplicationLease">;
  readAcceptedRunEvent?: (
    projectRoot: string,
    runId: string,
    eventId: string,
  ) => Promise<RunGraphAcceptedEvent | undefined>;
}

interface CorrelatedIssue {
  id: string;
  number: number;
  body: string | null;
  createdAt: string;
  repository: { nameWithOwner: string };
  projectItems: { nodes: Array<{ id: string; project: { id: string } }> };
}

interface CorrelatedIssueQueryResult {
  repository: null | {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: CorrelatedIssue[];
    };
  };
}

/** createの再送可否を断定するため、作成境界またはcursor終端まで走査する。 */
export async function scanMutationCorrelationIssues(
  gql: typeof graphql,
  owner: string,
  repo: string,
  marker: string,
  createdAtBoundary: string,
  maxPages = 20,
): Promise<{ complete: boolean; matches: CorrelatedIssue[] }> {
  const matches: CorrelatedIssue[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result: CorrelatedIssueQueryResult = await gql<CorrelatedIssueQueryResult>(
      MUTATION_CORRELATION_ISSUES_QUERY,
      { owner, repo, cursor },
    );
    const connection = result.repository?.issues;
    if (!connection) return { complete: false, matches };
    matches.push(
      ...connection.nodes.filter(
        (issue) =>
          issue.repository.nameWithOwner.toLowerCase() === `${owner}/${repo}`.toLowerCase() &&
          issue.body?.includes(marker),
      ),
    );
    const crossedBoundary = connection.nodes.some(
      (issue) => Date.parse(issue.createdAt) < Date.parse(createdAtBoundary),
    );
    if (!connection.pageInfo.hasNextPage || crossedBoundary) return { complete: true, matches };
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
      return { complete: false, matches };
    }
    cursor = connection.pageInfo.endCursor;
  }
  return { complete: false, matches };
}

/** 予約済みcreateだけが付与する末尾markerを除き、利用者bodyのdriftは保持する。 */
function normalizeCorrelationBody(body: string | null, marker: string): string | null {
  if (body === marker) return null;
  const suffix = `\n\n${marker}`;
  if (body?.endsWith(suffix)) return body.slice(0, -suffix.length) || null;
  return body;
}

interface MutationProjectItemState {
  complete: boolean;
  projectItemId: string | null;
  fields: Record<string, unknown>;
}

interface MutationIssueState {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  issueType: null | { name: string };
  assignees: string[];
  labels: string[];
  milestone: null | { title: string };
  parent: null | { number: number; repository: { nameWithOwner: string } };
}

interface MutationIssueStateQueryResult {
  repository: null | {
    issue: null | {
      id: string;
      number: number;
      title: string;
      body: string | null;
      state: "OPEN" | "CLOSED";
      stateReason: string | null;
      issueType: null | { name: string };
      assignees: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ login: string }>;
      };
      labels: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ name: string }>;
      };
      milestone: null | { title: string };
      parent: null | { number: number; repository: { nameWithOwner: string } };
    };
  };
}

async function fetchMutationIssueState(
  gql: typeof graphql,
  owner: string,
  repo: string,
  number: number,
  maxPages = 20,
): Promise<{ complete: boolean; issue: MutationIssueState | null }> {
  const assignees = new Set<string>();
  const labels = new Set<string>();
  let assigneesCursor: string | null = null;
  let labelsCursor: string | null = null;
  let assigneesComplete = false;
  let labelsComplete = false;
  let observed: Omit<MutationIssueState, "assignees" | "labels"> | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result: MutationIssueStateQueryResult = await gql<MutationIssueStateQueryResult>(
      MUTATION_POSTCONDITION_QUERY,
      { owner, repo, number, assigneesCursor, labelsCursor },
    );
    const issue:
      | NonNullable<NonNullable<MutationIssueStateQueryResult["repository"]>["issue"]>
      | undefined = result.repository?.issue ?? undefined;
    if (!issue) return { complete: false, issue: null };
    if (observed && (observed.id !== issue.id || observed.number !== issue.number)) {
      return { complete: false, issue: null };
    }
    observed = {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      issueType: issue.issueType,
      milestone: issue.milestone,
      parent: issue.parent,
    };
    if (!assigneesComplete) {
      for (const assignee of issue.assignees.nodes) assignees.add(assignee.login);
      if (!issue.assignees.pageInfo.hasNextPage) assigneesComplete = true;
      else if (
        !issue.assignees.pageInfo.endCursor ||
        issue.assignees.pageInfo.endCursor === assigneesCursor
      ) {
        return { complete: false, issue: null };
      } else assigneesCursor = issue.assignees.pageInfo.endCursor;
    }
    if (!labelsComplete) {
      for (const label of issue.labels.nodes) labels.add(label.name);
      if (!issue.labels.pageInfo.hasNextPage) labelsComplete = true;
      else if (
        !issue.labels.pageInfo.endCursor ||
        issue.labels.pageInfo.endCursor === labelsCursor
      ) {
        return { complete: false, issue: null };
      } else labelsCursor = issue.labels.pageInfo.endCursor;
    }
    if (assigneesComplete && labelsComplete) {
      return {
        complete: true,
        issue: { ...observed, assignees: [...assignees], labels: [...labels] },
      };
    }
  }
  return { complete: false, issue: null };
}

interface MutationIssueProjectItemsResult {
  repository: null | {
    issue: null | {
      projectItems: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ id: string; project: null | { id: string } }>;
      };
    };
  };
}

interface MutationProjectItemFieldsResult {
  node: null | {
    fieldValues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        field?: { name?: string };
        name?: string | null;
        text?: string | null;
        date?: string | null;
        number?: number | null;
        title?: string | null;
      }>;
    };
  };
}

async function fetchMutationProjectItemState(
  gql: typeof graphql,
  owner: string,
  repo: string,
  number: number,
  projectId: string,
  maxPages = 20,
): Promise<MutationProjectItemState> {
  const matches: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result: MutationIssueProjectItemsResult = await gql<MutationIssueProjectItemsResult>(
      MUTATION_ISSUE_PROJECT_ITEMS_QUERY,
      {
        owner,
        repo,
        number,
        cursor,
      },
    );
    const connection = result.repository?.issue?.projectItems;
    if (!connection) return { complete: false, projectItemId: null, fields: {} };
    for (const item of connection.nodes) {
      if (item.project?.id === projectId) matches.push(item.id);
    }
    if (!connection.pageInfo.hasNextPage) break;
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
      return { complete: false, projectItemId: null, fields: {} };
    }
    cursor = connection.pageInfo.endCursor;
    if (page === maxPages - 1) return { complete: false, projectItemId: null, fields: {} };
  }
  if (matches.length !== 1) return { complete: true, projectItemId: null, fields: {} };

  const fields: Record<string, unknown> = {};
  cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result: MutationProjectItemFieldsResult = await gql<MutationProjectItemFieldsResult>(
      MUTATION_PROJECT_ITEM_FIELDS_QUERY,
      { itemId: matches[0], cursor },
    );
    const connection = result.node?.fieldValues;
    if (!connection) return { complete: false, projectItemId: matches[0]!, fields };
    for (const value of connection.nodes) {
      if (!value.field?.name) continue;
      fields[value.field.name] =
        value.name ?? value.text ?? value.date ?? value.number ?? value.title ?? null;
    }
    if (!connection.pageInfo.hasNextPage) {
      return { complete: true, projectItemId: matches[0]!, fields };
    }
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
      return { complete: false, projectItemId: matches[0]!, fields };
    }
    cursor = connection.pageInfo.endCursor;
  }
  return { complete: false, projectItemId: matches[0]!, fields };
}

function normalizeComparableValue(key: string, value: unknown, config: Config): unknown {
  if (key === "blocked_by") return canonicalBlockedBy((value as Task["blocked_by"]) ?? []);
  if (key === "assignees" || key === "labels") return [...((value as string[]) ?? [])].sort();
  if (key === "project_fields" && value && typeof value === "object") {
    const fields = { ...(value as Record<string, unknown>) };
    const priorityField = config.sync.field_mapping.priority;
    if (priorityField && typeof fields[priorityField] === "string") {
      fields[priorityField] = fields[priorityField].toLowerCase();
    }
    return Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value;
}

function cloneTask(task: Task): Task {
  return structuredClone(task);
}

function issueNumber(taskId: string): number {
  const value = Number(taskId.split("#").at(-1));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`origin task IDからIssue番号を解決できません: ${taskId}`);
  }
  return value;
}

function replaceLogicalIds(value: unknown, logicalTaskIds: Record<string, string>): unknown {
  if (typeof value === "string") return logicalTaskIds[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceLogicalIds(item, logicalTaskIds));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceLogicalIds(item, logicalTaskIds)]),
    );
  }
  return value;
}

function taskFromProjection(projection: Record<string, unknown>, now: string): Task {
  return {
    id: String(projection.id),
    type: String(projection.type),
    github_issue: null,
    github_repo: String(projection.github_repo),
    parent: (projection.parent as string | null) ?? null,
    sub_tasks: (projection.sub_tasks as string[]) ?? [],
    title: String(projection.title),
    body: (projection.body as string | null) ?? null,
    state: projection.state === "closed" ? "closed" : "open",
    state_reason: (projection.state_reason as string | null) ?? null,
    assignees: (projection.assignees as string[] | undefined) ?? [],
    labels: (projection.labels as string[] | undefined) ?? [],
    milestone: (projection.milestone as string | null | undefined) ?? null,
    linked_prs: (projection.linked_prs as Task["linked_prs"] | undefined) ?? [],
    created_at: (projection.created_at as string | undefined) ?? now,
    updated_at: (projection.updated_at as string | undefined) ?? now,
    closed_at:
      (projection.closed_at as string | null | undefined) ??
      (projection.state === "closed" ? now : null),
    acceptance_criteria:
      (projection.acceptance_criteria as Task["acceptance_criteria"] | undefined) ?? [],
    acceptance_criteria_slot: (projection.acceptance_criteria_slot as boolean | undefined) ?? false,
    implementer: (projection.implementer as string | null | undefined) ?? null,
    reviewer: (projection.reviewer as string | null | undefined) ?? null,
    require_review: (projection.require_review as boolean | undefined) ?? false,
    review_approved_by: (projection.review_approved_by as string | null | undefined) ?? null,
    review_approved_at: (projection.review_approved_at as string | null | undefined) ?? null,
    custom_fields: (projection.custom_fields as Record<string, unknown> | undefined) ?? {},
    start_date: (projection.start_date as string | null | undefined) ?? null,
    end_date: (projection.end_date as string | null | undefined) ?? null,
    date: (projection.date as string | null | undefined) ?? null,
    blocked_by: (projection.blocked_by as Task["blocked_by"]) ?? [],
  };
}

/**
 * proposal control planeを既存storage/push/Run Graph adapterへ接続するproduction境界。
 * 各leaseは短時間で閉じ、proposal storeのLOCKと重ねない。
 */
export class ProductionMutationEnvironment implements MutationProposalEnvironment {
  private readonly inspector: RunActivityInspector;
  private readonly runControlPlane: RunGraphControlPlane;
  private readonly createGql: () => Promise<typeof graphql>;
  private readonly now: () => string;
  private readonly storageRunner: typeof withProjectStorage;
  private readonly pushExecutor: typeof executePush;
  private readonly createRunControlPlane: (projectRoot: string) => RunGraphControlPlane;
  private readonly afterLocalPreparationRecorded?: () => Promise<void>;
  private readonly claimStore: DispatchClaimStore;
  private readonly applicationStore: Pick<
    MutationProposalStore,
    "assertApplication" | "withApplicationLease"
  >;
  readonly mutationCoordination: MutationCoordinationCapability;
  private readonly readAcceptedRunEvent: NonNullable<
    ProductionMutationEnvironmentDependencies["readAcceptedRunEvent"]
  >;

  constructor(
    private readonly projectRoot: string,
    private readonly engine: WorkGraphCommandEngine,
    dependencies: ProductionMutationEnvironmentDependencies = {},
  ) {
    this.inspector = dependencies.inspector ?? new RunActivityInspector(projectRoot);
    this.runControlPlane = dependencies.runControlPlane ?? new RunGraphControlPlane(projectRoot);
    this.createGql = dependencies.createGraphQLClient ?? createGraphQLClient;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.storageRunner = dependencies.storageRunner ?? withProjectStorage;
    this.pushExecutor = dependencies.pushExecutor ?? executePush;
    this.createRunControlPlane =
      dependencies.createRunControlPlane ?? ((root) => new RunGraphControlPlane(root));
    this.afterLocalPreparationRecorded = dependencies.afterLocalPreparationRecorded;
    this.claimStore = dependencies.claimStore ?? new DispatchClaimStore(projectRoot);
    for (const method of [
      "reserveMutation",
      "beginMutationSideEffect",
      "completeMutationSideEffect",
      "releaseMutationReservation",
      "assertMutationReservation",
      "withMutationReservation",
    ] as const) {
      if (typeof this.claimStore[method] !== "function") {
        throw new Error(`mutation coordination adapterが不完全です: ${method}`);
      }
    }
    this.mutationCoordination = {
      reserveMutation: this.reserveMutation.bind(this),
      beginMutationSideEffect: this.beginMutationSideEffect.bind(this),
      completeMutationSideEffect: this.completeMutationSideEffect.bind(this),
      releaseMutationReservation: this.releaseMutationReservation.bind(this),
      withMutationReservation: this.claimStore.withMutationReservation.bind(this.claimStore),
    };
    this.applicationStore = dependencies.applicationStore ?? new MutationProposalStore(projectRoot);
    for (const method of ["assertApplication", "withApplicationLease"] as const) {
      if (typeof this.applicationStore[method] !== "function") {
        throw new Error(`application fence adapterが不完全です: ${method}`);
      }
    }
    this.readAcceptedRunEvent =
      dependencies.readAcceptedRunEvent ??
      (async (root, runId, eventId) =>
        (await new RunGraphEventStore(root).readJournal(runId)).acceptedEvents.find(
          (event) => event.eventId === eventId,
        ));
  }

  async loadSnapshot(): Promise<MutationSnapshot> {
    return this.storageRunner(
      this.projectRoot,
      { mode: "read", scope: "shared-cache" },
      async ({ configStore, tasksStore, stateStore }) => {
        const [config, tasksFile, syncState] = await Promise.all([
          configStore.read(),
          tasksStore.read(),
          stateStore.read(),
        ]);
        return {
          config,
          tasks: tasksFile.tasks.map(cloneTask),
          sourceRevision: syncState.last_synced_at || mutationCommandFingerprint(syncState),
          snapshotFingerprint: mutationCommandFingerprint({ tasks: tasksFile.tasks, syncState }),
          syncConflicts:
            tasksFile.has_conflicts === true ||
            tasksFile.tasks.some((task) =>
              hasUnresolvedMarkers(task as unknown as Record<string, unknown>),
            ),
        };
      },
    );
  }

  async resolveOrigin(runId: string): Promise<MutationOriginResolution> {
    return this.inspector.resolveOrigin(runId);
  }

  async validateApply(proposal: MutationProposal): Promise<MutationApplyValidation> {
    return this.inspector.validateApply(proposal);
  }

  private async reserveMutation(
    proposal: MutationProposal,
    expectedEntityVersion: number,
    ownerNonce: string,
  ): Promise<MutationReservationResult> {
    return this.claimStore.reserveMutation({
      proposalId: proposal.proposalId,
      ownerNonce,
      expectedEntityVersion,
      affectedTaskIds: [
        ...new Set([
          proposal.origin.taskId,
          ...proposal.targetTaskIds,
          ...proposal.affectedDownstream,
        ]),
      ],
      leaseDurationSeconds: 60,
    });
  }

  private async releaseMutationReservation(proof: MutationReservationProof): Promise<boolean> {
    return this.claimStore.releaseMutationReservation(proof);
  }

  private async beginMutationSideEffect(
    proof: MutationReservationProof,
  ): Promise<MutationReservationProof> {
    return this.claimStore.beginMutationSideEffect(proof, 60);
  }

  private async completeMutationSideEffect(
    proof: MutationReservationProof,
  ): Promise<MutationReservationProof> {
    return this.claimStore.completeMutationSideEffect(proof, 60);
  }

  async validateAdvancedBaseline(
    proposal: MutationProposal,
    snapshot: MutationSnapshot,
  ): Promise<boolean> {
    if (!this.engine.validateGraph(snapshot.tasks).ok) return false;
    const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
    const durablyPreparedStepId = proposal.steps.find(
      (step) =>
        step.state === "not_started" &&
        step.localPreparation?.preparedFingerprint === snapshot.snapshotFingerprint,
    )?.stepId;
    for (const step of proposal.steps) {
      const actualTargetId = proposal.logicalTaskIds[step.targetTaskId] ?? step.targetTaskId;
      const current = byId.get(actualTargetId);
      if (step.state === "unknown") return false;
      if (step.state === "not_started") {
        if (step.stepId === durablyPreparedStepId) {
          if (!current) return false;
          const expected = replaceLogicalIds(
            step.operation === "create"
              ? ((step.payload.task as Record<string, unknown>) ?? step.expectedPostcondition)
              : step.expectedPostcondition,
            proposal.logicalTaskIds,
          ) as Record<string, unknown>;
          if (!this.matchesTaskProjection(current, expected)) return false;
          continue;
        }
        if (step.operation === "create") {
          if (current) return false;
          continue;
        }
        if (!current || !step.beforeImage) return false;
        const before = replaceLogicalIds(step.beforeImage, proposal.logicalTaskIds) as Record<
          string,
          unknown
        >;
        if (!this.matchesTaskProjection(current, before)) return false;
        continue;
      }
      if (!current) return false;
      const expected = replaceLogicalIds(
        step.operation === "create"
          ? ((step.payload.task as Record<string, unknown>) ?? step.expectedPostcondition)
          : step.expectedPostcondition,
        proposal.logicalTaskIds,
      ) as Record<string, unknown>;
      if (!this.matchesTaskProjection(current, expected)) return false;
    }
    return true;
  }

  private matchesTaskProjection(task: Task, expected: Record<string, unknown>): boolean {
    if ("github_issue" in expected) {
      return (
        mutationCommandFingerprint(extractSyncFields(task)) ===
        mutationCommandFingerprint(extractSyncFields(taskFromProjection(expected, task.updated_at)))
      );
    }
    const current = task as unknown as Record<string, unknown>;
    return Object.entries(expected).every(
      ([key, value]) =>
        key === "id" ||
        key === "github_repo" ||
        mutationCommandFingerprint(current[key]) === mutationCommandFingerprint(value),
    );
  }

  private projectStep(
    tasksFile: TasksFile,
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
  ):
    | { ok: true; resolvedPostcondition: Record<string, unknown> }
    | { ok: false; diagnostic: string } {
    const actualTargetId = proposal.logicalTaskIds[step.targetTaskId] ?? step.targetTaskId;
    const resolvedPostcondition = replaceLogicalIds(
      step.expectedPostcondition,
      proposal.logicalTaskIds,
    ) as Record<string, unknown>;
    const targetIndex = tasksFile.tasks.findIndex((task) => task.id === actualTargetId);
    if (step.operation === "create") {
      if (targetIndex >= 0) {
        return { ok: false, diagnostic: "予約済みcreate targetが既に存在します" };
      }
      const projection = replaceLogicalIds(
        (step.payload.task as Record<string, unknown>) ?? resolvedPostcondition,
        proposal.logicalTaskIds,
      ) as Record<string, unknown>;
      const created = taskFromProjection(projection, this.now());
      tasksFile.tasks.push(created);
      if (created.parent) {
        const parent = tasksFile.tasks.find((task) => task.id === created.parent);
        if (!parent) {
          return { ok: false, diagnostic: `create parentが存在しません: ${created.parent}` };
        }
        if (!parent.sub_tasks.includes(created.id)) parent.sub_tasks.push(created.id);
        parent.updated_at = this.now();
      }
    } else {
      if (targetIndex < 0) {
        return { ok: false, diagnostic: `対象taskが存在しません: ${actualTargetId}` };
      }
      const current = tasksFile.tasks[targetIndex]!;
      let next: Task;
      if (step.operation === "cancel") {
        const result = this.engine.cancel(current, { trustedHumanApproval: true });
        if (!result.ok) return { ok: false, diagnostic: result.error };
        next = result.task;
      } else if (step.operation === "recover_cancel") {
        const beforeFingerprint = String(step.payload.beforeFingerprint ?? "");
        const result = this.engine.recoverCancelled(current, beforeFingerprint);
        if (!result.ok) return { ok: false, diagnostic: result.error };
        next = result.task;
      } else if (step.operation === "complete_close") {
        const result = this.engine.complete(current);
        if (!result.ok) return { ok: false, diagnostic: result.error };
        next = result.task;
      } else {
        next = {
          ...cloneTask(current),
          ...resolvedPostcondition,
          id: current.id,
          updated_at: this.now(),
        } as Task;
      }
      tasksFile.tasks[targetIndex] = next;
    }
    const graphValidation = this.engine.validateGraph(tasksFile.tasks);
    if (!graphValidation.ok) return { ok: false, diagnostic: graphValidation.error };
    return { ok: true, resolvedPostcondition };
  }

  async prepareStep(
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
    fence: MutationFenceContext,
  ): Promise<MutationStepPreparation> {
    const { applicationLease, mutationReservation } = fence;
    return this.storageRunner(
      this.projectRoot,
      { mode: "write", scope: "shared-cache" },
      async ({ tasksStore, stateStore }) => {
        await this.claimStore.assertMutationReservation(mutationReservation);
        await this.applicationStore.assertApplication(applicationLease);
        const [tasksFile, syncState] = await Promise.all([tasksStore.read(), stateStore.read()]);
        const sourceFingerprint = mutationCommandFingerprint({
          tasks: tasksFile.tasks,
          syncState,
        });
        const projectionAlreadyFlushed =
          step.localPreparation?.preparedFingerprint === sourceFingerprint;
        const expectedSourceFingerprint =
          proposal.applyBaseline?.snapshotFingerprint ?? proposal.snapshotFingerprint;
        if (
          expectedSourceFingerprint &&
          sourceFingerprint !== expectedSourceFingerprint &&
          !projectionAlreadyFlushed
        ) {
          return {
            ok: false as const,
            code: "source_drift" as const,
            diagnostic:
              "source_drift: prepare lease内のWork Graphがproposal baselineから変化しました",
          };
        }
        if (
          tasksFile.has_conflicts === true ||
          tasksFile.tasks.some((task) =>
            hasUnresolvedMarkers(task as unknown as Record<string, unknown>),
          )
        ) {
          return {
            ok: false as const,
            code: "source_drift" as const,
            diagnostic: "source_drift: 未解決sync conflictがあります",
          };
        }
        const projected: TasksFile = {
          ...structuredClone(tasksFile),
          tasks: tasksFile.tasks.map(cloneTask),
        };
        const projection = this.projectStep(projected, step, proposal);
        if (!projection.ok) {
          return {
            ok: false as const,
            code: "invalid_projection" as const,
            diagnostic: projection.diagnostic,
          };
        }
        return {
          ok: true as const,
          preparation: {
            sourceRevision: syncState.last_synced_at || mutationCommandFingerprint(syncState),
            sourceFingerprint,
            preparedFingerprint: mutationCommandFingerprint({
              tasks: projected.tasks,
              syncState,
            }),
            preparedAt: this.now(),
          },
        };
      },
    );
  }

  async verifyHumanApproval(
    boundDecision: MutationBoundDecision,
    commentRef: GitHubApprovalCommentRef,
  ): Promise<HumanApprovalVerification> {
    const snapshot = await this.loadSnapshot();
    const proposal = await new MutationProposalStore(this.projectRoot).get(
      boundDecision.proposalId,
    );
    if (!proposal) {
      return {
        ok: false,
        code: "human_gate_required",
        diagnostic: "approval対象proposalが見つかりません",
      };
    }
    const gql = await this.createGql();
    return new HumanApprovalAuthority(
      snapshot.config.mutation_approval,
      {
        repository: proposal.origin.repository,
        issueNumber: issueNumber(proposal.origin.taskId),
      },
      new GitHubLiveApprovalEvidenceAdapter(gql),
      this.now,
    ).verify(boundDecision, commentRef);
  }

  async executeStep(
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
    fence: MutationFenceContext,
    recordRemoteOutcome?: (outcome: MutationStepOutcome) => Promise<void>,
  ): Promise<MutationStepOutcome> {
    const { applicationLease, mutationReservation } = fence;
    const actualTargetId = proposal.logicalTaskIds[step.targetTaskId] ?? step.targetTaskId;
    const prepared = await this.storageRunner(
      this.projectRoot,
      { mode: "write", scope: "shared-cache" },
      async (storage) => {
        await this.claimStore.assertMutationReservation(mutationReservation);
        await this.applicationStore.assertApplication(applicationLease);
        const { configStore, tasksStore, stateStore } = storage;
        const [config, tasksFile, syncState] = await Promise.all([
          configStore.read(),
          tasksStore.read(),
          stateStore.read(),
        ]);
        const sourceFingerprint = mutationCommandFingerprint({
          tasks: tasksFile.tasks,
          syncState,
        });
        const projectionAlreadyFlushed =
          step.localPreparation?.preparedFingerprint === sourceFingerprint;
        const expectedSourceFingerprint =
          proposal.applyBaseline?.snapshotFingerprint ?? proposal.snapshotFingerprint;
        if (
          expectedSourceFingerprint &&
          sourceFingerprint !== expectedSourceFingerprint &&
          !projectionAlreadyFlushed
        ) {
          return {
            ok: false as const,
            diagnostic:
              "source_drift: prepare lease内のWork Graphがproposal baselineから変化しました",
          };
        }
        if (
          tasksFile.has_conflicts === true ||
          tasksFile.tasks.some((task) =>
            hasUnresolvedMarkers(task as unknown as Record<string, unknown>),
          )
        ) {
          return { ok: false as const, diagnostic: "未解決sync conflictがあります" };
        }

        const resolvedPostcondition = replaceLogicalIds(
          step.expectedPostcondition,
          proposal.logicalTaskIds,
        ) as Record<string, unknown>;
        if (!projectionAlreadyFlushed) {
          const projection = this.projectStep(tasksFile, step, proposal);
          if (!projection.ok) return { ok: false as const, diagnostic: projection.diagnostic };
          const preparedFingerprint = mutationCommandFingerprint({
            tasks: tasksFile.tasks,
            syncState,
          });
          if (
            step.localPreparation &&
            preparedFingerprint !== step.localPreparation.preparedFingerprint
          ) {
            return {
              ok: false as const,
              diagnostic: "source_drift: durable preparationとlocal projectionが一致しません",
            };
          }
          await this.withFence(fence, async () => {
            await tasksStore.write(tasksFile);
            await storage.flush();
          });
        }
        return {
          ok: true as const,
          config,
          tasksFile: structuredClone(tasksFile) as TasksFile,
          syncState: structuredClone(syncState) as SyncState,
          resolvedPostcondition,
          preparedFingerprint: mutationCommandFingerprint({
            tasks: tasksFile.tasks,
            syncState,
          }),
          sourceFingerprint,
          sourceRevision: syncState.last_synced_at || mutationCommandFingerprint(syncState),
        };
      },
    );
    if (!prepared.ok) return { state: "unknown", diagnostic: prepared.diagnostic };

    let expectedPublishFingerprint = prepared.preparedFingerprint;
    const publish = async (tasksFile: TasksFile, syncState: SyncState): Promise<void> => {
      await this.storageRunner(
        this.projectRoot,
        { mode: "write", scope: "shared-cache" },
        async ({ tasksStore, stateStore, flush }) => {
          const [currentTasksFile, currentSyncState] = await Promise.all([
            tasksStore.read(),
            stateStore.read(),
          ]);
          const currentFingerprint = mutationCommandFingerprint({
            tasks: currentTasksFile.tasks,
            syncState: currentSyncState,
          });
          if (currentFingerprint !== expectedPublishFingerprint) {
            throw new Error("prepared snapshot drift: concurrent Work Graph updateを検出しました");
          }
          await this.withFence(fence, async () => {
            await tasksStore.write(tasksFile);
            await stateStore.write(syncState);
            await flush();
            expectedPublishFingerprint = mutationCommandFingerprint({
              tasks: tasksFile.tasks,
              syncState,
            });
          });
        },
      );
    };
    const reservation: PushStepReservation = {
      stepId: step.stepId,
      operation: step.operation,
      targetTaskId: actualTargetId,
      correlationToken: step.correlationToken,
      expectedPostcondition: prepared.resolvedPostcondition,
    };
    const reportedOutcomes: PushStepOutcome[] = [];
    try {
      if (!step.localPreparation) {
        await recordRemoteOutcome?.({
          state: "unknown",
          diagnostic: "local preparationは永続化済み、remote side effectは未開始です",
          localPreparation: {
            sourceRevision: prepared.sourceRevision,
            sourceFingerprint: prepared.sourceFingerprint,
            preparedFingerprint: prepared.preparedFingerprint,
            preparedAt: this.now(),
          },
        });
        await this.afterLocalPreparationRecorded?.();
      }
      // Work Graph leaseを解放した後にのみリモートI/Oへ進む。
      await this.applicationStore.assertApplication(applicationLease);
      await this.claimStore.assertMutationReservation(mutationReservation);
      const gql = await this.createGql();
      const result = await this.pushExecutor(
        gql,
        prepared.config as Config,
        prepared.tasksFile,
        prepared.syncState,
        {
          targetTaskIds: [actualTargetId],
          reservations: [reservation],
          saveProgress: publish,
          onStepOutcome: async (outcome) => {
            reportedOutcomes.push(outcome);
            const resolvedTaskId = outcome.remoteIdentifiers?.issueNumber
              ? `${prepared.config.project.github.owner}/${prepared.config.project.github.repo}#${outcome.remoteIdentifiers.issueNumber}`
              : undefined;
            await recordRemoteOutcome?.({
              state: "unknown",
              diagnostic:
                outcome.state === "unknown"
                  ? outcome.diagnostic
                  : "remote side effect committed; local finalizeは未確認です",
              resolvedTaskId,
              remoteIdentifiers: outcome.remoteIdentifiers ?? null,
            });
          },
        },
      );
      await publish(result.tasksFile, result.syncState);
      const outcome = reportedOutcomes.at(-1) ?? result.stepOutcomes.at(-1);
      if (!outcome) {
        return { state: "unknown", diagnostic: "push executorがstep outcomeを返しませんでした" };
      }
      const resolvedTaskId = outcome.remoteIdentifiers?.issueNumber
        ? `${prepared.config.project.github.owner}/${prepared.config.project.github.repo}#${outcome.remoteIdentifiers.issueNumber}`
        : undefined;
      return {
        state: outcome.state,
        diagnostic: outcome.diagnostic,
        resolvedTaskId,
        remoteIdentifiers: outcome.remoteIdentifiers ?? null,
      };
    } catch (error) {
      return {
        state: "unknown",
        diagnostic:
          error instanceof Error
            ? `push結果を確定できません: ${error.message}`
            : "push結果を確定できません",
        remoteIdentifiers: reportedOutcomes.at(-1)?.remoteIdentifiers ?? null,
      };
    }
  }

  async reconcileStep(
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
    fence: MutationFenceContext,
  ): Promise<MutationStepReconciliation> {
    const { applicationLease, mutationReservation } = fence;
    const snapshot = await this.loadSnapshot();
    const { owner, repo } = snapshot.config.project.github;
    await this.applicationStore.assertApplication(applicationLease);
    await this.claimStore.assertMutationReservation(mutationReservation);
    const gql = await this.createGql();
    if (step.operation === "create") {
      if (!step.correlationToken) {
        return { state: "unknown", diagnostic: "create correlation tokenがありません" };
      }
      const marker = `<!-- gh-gantt:mutation-correlation:v1 ${step.correlationToken} -->`;
      const scan = await scanMutationCorrelationIssues(
        gql,
        owner,
        repo,
        marker,
        proposal.createdAt,
      );
      if (!scan.complete) {
        return { state: "unknown", diagnostic: "correlation queryをcursor終端まで確認できません" };
      }
      const matches = scan.matches;
      if (matches.length === 0) {
        await this.restoreLocalBeforeImage(step, proposal, fence);
        return {
          state: "not_started",
          diagnostic: "correlation markerに一致するIssueはありません",
        };
      }
      if (matches.length !== 1) {
        return { state: "unknown", diagnostic: "correlation markerに複数Issueが一致しました" };
      }
      const match = matches[0]!;
      const resolvedTaskId = `${owner}/${repo}#${match.number}`;
      const postcondition = await fetchMutationIssueState(gql, owner, repo, match.number);
      const issue = postcondition.issue;
      if (
        !postcondition.complete ||
        !issue ||
        issue.id !== match.id ||
        issue.number !== match.number
      ) {
        return {
          state: "unknown",
          diagnostic: "correlation Issueのlive postconditionを取得できません",
        };
      }
      let relationships;
      try {
        relationships = await fetchIssueRelationships(gql, owner, repo, match.number);
      } catch (error) {
        return {
          state: "unknown",
          diagnostic: error instanceof Error ? error.message : String(error),
        };
      }
      const projectNodeId = await this.storageRunner(
        this.projectRoot,
        { mode: "read", scope: "shared-cache" },
        async ({ stateStore }) => (await stateStore.read()).project_node_id,
      );
      const projectState = await fetchMutationProjectItemState(
        gql,
        owner,
        repo,
        match.number,
        projectNodeId,
      );
      if (!projectState.complete || !projectState.projectItemId) {
        return {
          state: "unknown",
          diagnostic:
            "correlation IssueのProject item/field valuesをcursor終端まで一意に確認できません",
        };
      }
      const normalizedBody = normalizeCorrelationBody(issue.body, marker);
      const liveLabels = issue.labels;
      const liveType = resolveTaskTypeBinding(
        liveLabels,
        projectState.fields,
        snapshot.config.task_types,
        snapshot.config.sync.field_mapping.type,
        issue.issueType?.name ?? null,
      );
      const remote = {
        state: issue.state === "CLOSED" ? "closed" : "open",
        state_reason: issue.stateReason,
        title: issue.title,
        body: normalizedBody,
        type: liveType,
        assignees: issue.assignees,
        labels: liveLabels,
        milestone: issue.milestone?.title ?? null,
        parent: issue.parent
          ? `${issue.parent.repository.nameWithOwner.toLowerCase()}#${issue.parent.number}`
          : null,
        sub_tasks: relationships.subIssues.map(
          (child) => `${child.repository.toLowerCase()}#${child.number}`,
        ),
        blocked_by: relationships.blockedBy.map((blocker) => ({
          task: `${blocker.repository.toLowerCase()}#${blocker.number}`,
          type: "finish-to-start",
          lag: 0,
        })),
        project_fields: projectState.fields,
      };
      const expected = replaceLogicalIds(
        step.expectedPostcondition,
        proposal.logicalTaskIds,
      ) as Record<string, unknown>;
      const remotelyObservableKeys = [
        "state",
        "state_reason",
        "title",
        "body",
        "type",
        "assignees",
        "labels",
        "milestone",
        "parent",
        "sub_tasks",
        "blocked_by",
        "project_fields",
      ];
      if (
        remotelyObservableKeys.some(
          (key) =>
            key in expected &&
            mutationCommandFingerprint(
              normalizeComparableValue(
                key,
                key === "project_fields"
                  ? Object.fromEntries(
                      Object.keys(expected.project_fields as Record<string, unknown>).map(
                        (field) => [field, projectState.fields[field] ?? null],
                      ),
                    )
                  : remote[key as keyof typeof remote],
                snapshot.config,
              ),
            ) !==
              mutationCommandFingerprint(
                normalizeComparableValue(key, expected[key], snapshot.config),
              ),
        )
      ) {
        return {
          state: "unknown",
          diagnostic:
            "correlation Issueはexpected state/parent/dependency/order postconditionと一致しません",
        };
      }
      await this.applicationStore.assertApplication(applicationLease);
      await this.claimStore.assertMutationReservation(mutationReservation);
      let projectItemId: string | null = null;
      try {
        await this.storageRunner(
          this.projectRoot,
          { mode: "write", scope: "shared-cache" },
          async ({ tasksStore, stateStore, flush }) => {
            const [tasksFile, syncState] = await Promise.all([
              tasksStore.read(),
              stateStore.read(),
            ]);
            if (syncState.project_node_id !== projectNodeId) {
              throw new Error("correlation照合中にProject identityが変化しました");
            }
            await this.withFence(fence, async () => {
              projectItemId = projectState.projectItemId;
              reifyDraftTask(tasksFile, syncState, {
                draftTaskId: step.targetTaskId,
                repository: `${owner}/${repo}`,
                issueNumber: match.number,
                issueId: match.id,
                projectItemId: projectItemId!,
                syncedAt: this.now(),
              });
              const graph = this.engine.validateGraph(tasksFile.tasks);
              if (!graph.ok) throw new Error(graph.error);
              await tasksStore.write(tasksFile);
              await stateStore.write(syncState);
              await flush();
            });
          },
        );
      } catch (error) {
        return {
          state: "unknown",
          diagnostic: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        state: "reconciled",
        diagnostic: null,
        resolvedTaskId,
        remoteIdentifiers: {
          issueId: match.id,
          issueNumber: match.number,
          projectItemId: projectItemId!,
        },
      };
    }

    const actualTargetId = proposal.logicalTaskIds[step.targetTaskId] ?? step.targetTaskId;
    const number = issueNumber(actualTargetId);
    const postcondition = await fetchMutationIssueState(gql, owner, repo, number);
    const issue = postcondition.issue;
    if (!postcondition.complete || !issue) {
      return { state: "unknown", diagnostic: "target Issueをcursor終端までlive取得できません" };
    }
    let relationships;
    try {
      relationships = await fetchIssueRelationships(gql, owner, repo, number);
    } catch (error) {
      return {
        state: "unknown",
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
    const remote = {
      state: issue.state === "CLOSED" ? "closed" : "open",
      state_reason: issue.stateReason,
      title: issue.title,
      body: issue.body,
      parent: issue.parent
        ? `${issue.parent.repository.nameWithOwner.toLowerCase()}#${issue.parent.number}`
        : null,
      sub_tasks: relationships.subIssues.map(
        (child) => `${child.repository.toLowerCase()}#${child.number}`,
      ),
      blocked_by: relationships.blockedBy.map((blocker) => ({
        task: `${blocker.repository.toLowerCase()}#${blocker.number}`,
        type: "finish-to-start",
        lag: 0,
      })),
    };
    const expected = replaceLogicalIds(
      step.expectedPostcondition,
      proposal.logicalTaskIds,
    ) as Record<string, unknown>;
    const matchesExpected = Object.entries(expected).every(
      ([key, value]) =>
        mutationCommandFingerprint(
          normalizeComparableValue(key, remote[key as keyof typeof remote], snapshot.config),
        ) === mutationCommandFingerprint(normalizeComparableValue(key, value, snapshot.config)),
    );
    if (matchesExpected) {
      return this.withFence(fence, async () => ({
        state: "reconciled" as const,
        diagnostic: null,
        remoteIdentifiers: { issueId: issue.id, issueNumber: issue.number },
      }));
    }
    const remoteBeforeImage =
      (step.payload?.remoteBeforeImage as Record<string, unknown> | undefined) ?? step.beforeImage;
    const before = replaceLogicalIds(remoteBeforeImage, proposal.logicalTaskIds) as Record<
      string,
      unknown
    > | null;
    const matchesBefore =
      before !== null &&
      Object.entries(before).every(
        ([key, value]) =>
          key === "id" ||
          key === "type" ||
          key === "github_repo" ||
          mutationCommandFingerprint(
            normalizeComparableValue(key, remote[key as keyof typeof remote], snapshot.config),
          ) === mutationCommandFingerprint(normalizeComparableValue(key, value, snapshot.config)),
      );
    if (matchesBefore) {
      await this.restoreLocalBeforeImage(step, proposal, fence);
      return {
        state: "not_started",
        diagnostic: "remoteは予約済みbefore imageと一致します",
        remoteIdentifiers: { issueId: issue.id, issueNumber: issue.number },
      };
    }
    return {
      state: "unknown",
      diagnostic: "remoteはexpected postcondition/before imageのどちらにも一致しません",
      remoteIdentifiers: { issueId: issue.id, issueNumber: issue.number },
    };
  }

  private async restoreLocalBeforeImage(
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
    fence: MutationFenceContext,
  ): Promise<void> {
    const { applicationLease, mutationReservation } = fence;
    await this.applicationStore.assertApplication(applicationLease);
    await this.claimStore.assertMutationReservation(mutationReservation);
    await this.storageRunner(
      this.projectRoot,
      { mode: "write", scope: "shared-cache" },
      async (storage) => {
        const { tasksStore, stateStore } = storage;
        const [tasksFile, syncState] = await Promise.all([tasksStore.read(), stateStore.read()]);
        const actualTargetId = proposal.logicalTaskIds[step.targetTaskId] ?? step.targetTaskId;
        await this.withFence(fence, async () => {
          if (step.operation === "create") {
            const removedIds = new Set([step.targetTaskId, actualTargetId]);
            tasksFile.tasks = tasksFile.tasks
              .filter((task) => !removedIds.has(task.id))
              .map((task) => ({
                ...task,
                parent: task.parent && removedIds.has(task.parent) ? null : task.parent,
                sub_tasks: task.sub_tasks.filter((id) => !removedIds.has(id)),
                blocked_by: task.blocked_by.filter(
                  (dependency) => !removedIds.has(dependency.task),
                ),
              }));
            for (const id of removedIds) {
              delete syncState.id_map[id];
              delete syncState.snapshots[id];
            }
          } else {
            const index = tasksFile.tasks.findIndex((task) => task.id === actualTargetId);
            if (index < 0 || !step.beforeImage) {
              throw new Error("before imageをlocal mirrorへ復元できません");
            }
            const before = replaceLogicalIds(step.beforeImage, proposal.logicalTaskIds) as Record<
              string,
              unknown
            >;
            const current = tasksFile.tasks[index]!;
            tasksFile.tasks[index] = {
              ...current,
              ...before,
              id: current.id,
              updated_at: current.updated_at,
            } as Task;
          }
          await tasksStore.write(tasksFile);
          await stateStore.write(syncState);
          await storage.flush();
        });
      },
    );
  }

  /** dual fenceを照合し、operation完了まで両coordination registry lockを保持する。 */
  private async withFence<T>(fence: MutationFenceContext, operation: () => Promise<T>): Promise<T> {
    return this.applicationStore.withApplicationLease(fence.applicationLease, (assertApplication) =>
      this.claimStore.withMutationReservation(fence.mutationReservation, async () => {
        assertApplication();
        return operation();
      }),
    );
  }

  async appendAudit(event: MutationProposalAuditEvent): Promise<void> {
    const auditCommand =
      event.type === "work_graph_invalidated"
        ? null
        : {
            type: "work_graph_mutation_audit" as const,
            auditType: event.type,
            proposalId: event.proposalId,
            proposalRevision: event.proposalRevision,
            detailFingerprint: mutationCommandFingerprint(event.detail),
          };
    const targets =
      event.type === "work_graph_invalidated"
        ? ((event.detail.affectedRuns as MutationProposal["invalidationTargets"] | undefined) ?? [])
        : [{ projectRoot: this.projectRoot, runId: event.originRunId }];
    const uniqueTargets = [
      ...new Map(
        targets.map((target) => [`${target.projectRoot}\0${target.runId}`, target]),
      ).values(),
    ];
    for (const target of uniqueTargets) {
      const command =
        event.type === "work_graph_invalidated"
          ? {
              type: "work_graph_invalidated" as const,
              proposalId: event.proposalId,
              proposalRevision: event.proposalRevision,
              coverageFingerprint: String(event.detail.coverageFingerprint),
              affectedTaskIds: event.detail.affectedTaskIds as string[],
              successorPlanRevision: (target as MutationProposal["invalidationTargets"][number])
                .successorPlanRevision,
            }
          : auditCommand!;
      const control =
        target.projectRoot === this.projectRoot
          ? this.runControlPlane
          : this.createRunControlPlane(target.projectRoot);
      const result = await control.applyMutationAudit({
        schemaVersion: "1",
        eventId: event.eventId,
        runId: target.runId,
        actor: { id: event.actorId, role: event.actorRole },
        command,
      });
      if (!result.accepted) throw new Error(`${result.code}: ${result.message}`);
    }
  }

  async acceptReplan(
    proposal: MutationProposal,
    approval: Extract<HumanApprovalVerification, { ok: true }>["receipt"],
    successorPlanRevision: MutationSuccessorPlanRevision,
    successorNodeId: string,
    target: MutationProposal["invalidationTargets"][number],
  ): Promise<{ ok: true } | { ok: false; code: string; diagnostic: string }> {
    const receiptFingerprint = mutationCommandFingerprint(approval);
    const control = new RunGraphControlPlane(target.projectRoot, {
      now: this.now,
      nextId: (kind) => `${kind}:mutation:${proposal.proposalId}`,
      verifyReplanApproval: async (command) =>
        command.proposalId === proposal.proposalId &&
        command.verifiedHumanDecision.evidenceId ===
          `github-comment:${approval.commentId}:${approval.bodyHash}` &&
        command.verifiedHumanDecision.authorNodeId === approval.actor.id &&
        command.verifiedHumanDecision.proposalFingerprint ===
          approval.boundDecision.proposalFingerprint &&
        command.verifiedHumanDecision.authorityConfigFingerprint ===
          approval.authorityConfigFingerprint &&
        command.verifiedHumanDecision.receiptFingerprint === receiptFingerprint,
    });
    try {
      const auditInput = {
        schemaVersion: "1" as const,
        eventId: `mutation:${proposal.proposalId}:replan:${proposal.revision}`,
        runId: target.runId,
        actor: approval.actor,
        command: {
          type: "work_graph_replan_accepted" as const,
          proposalId: proposal.proposalId,
          proposalRevision: proposal.revision,
          verifiedHumanDecision: {
            decision: "approved" as const,
            evidenceId: `github-comment:${approval.commentId}:${approval.bodyHash}`,
            authorNodeId: approval.actor.id,
            proposalFingerprint: approval.boundDecision.proposalFingerprint,
            authorityConfigFingerprint: approval.authorityConfigFingerprint,
            receiptFingerprint,
          },
          graphContractBinding: {
            planId: target.planId,
            planVersion: target.planVersion,
            schemaVersion: target.schemaVersion,
          },
          successorPlanRevision,
          successorNodeId,
        },
      };
      const existing = await this.readAcceptedRunEvent(
        target.projectRoot,
        target.runId,
        auditInput.eventId,
      );
      if (existing) {
        return mutationCommandFingerprint({ actor: existing.actor, command: existing.command }) ===
          mutationCommandFingerprint({ actor: auditInput.actor, command: auditInput.command })
          ? { ok: true }
          : {
              ok: false,
              code: "duplicate_event",
              diagnostic: "stable replan event IDに異なるpayloadが記録されています",
            };
      }
      const view = await control.inspect(target.runId);
      if (
        view.contract.planId !== target.planId ||
        view.contract.planVersion !== target.planVersion ||
        view.contract.schemaVersion !== target.schemaVersion ||
        view.currentNode?.id !== target.currentNodeId
      ) {
        return {
          ok: false,
          code: "origin_binding_drift",
          diagnostic: "target Runのfrozen Graph Contract/Planが変化しました",
        };
      }
      const result = await control.applyMutationAudit(auditInput);
      return result.accepted
        ? { ok: true }
        : { ok: false, code: result.code, diagnostic: result.message };
    } catch (error) {
      return {
        ok: false,
        code: "run_state_unknown",
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
