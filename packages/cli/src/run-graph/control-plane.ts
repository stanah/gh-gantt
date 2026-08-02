import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonStringify,
  DispatchClaimProofSchema,
  RunGraphClaimAuditCommandSchema,
  RunGraphClaimAuditInputSchema,
  RunGraphProjectionSchema,
  RunGraphRunnerCommandInputSchema,
  RunGraphStartInputSchema,
  RunGraphViewSchema,
  type GraphContract,
  type DispatchClaimProof,
  type DispatchClaim,
  type DispatchClaimEventAuthorizationInput,
  type DispatchClaimReceipt,
  type RunGraphAcceptedEvent,
  type RunGraphArtifact,
  type RunGraphEvidence,
  type RunGraphProjection,
  type RunGraphRejectionCode,
  type RunGraphRunnerCommandInput,
  type RunGraphClaimAuditInput,
  type RunGraphStartInput,
  type RunGraphView,
  type RunGraphDispatchAuthorizationBinding,
} from "@gh-gantt/shared";
import { GraphContractStore } from "../store/graph-contract.js";
import { RunGraphEventStore } from "../store/run-graph.js";
import {
  DispatchClaimStore,
  type AbortPendingAuthorizationResult,
  type DispatchAuthorizedEventCommitContext,
  type PendingAuthorizationInspection,
} from "../store/dispatch-claims.js";
import { isNotGitRepositoryError } from "../util/git-errors.js";

export interface RunGraphControlPlaneDependencies {
  now: () => string;
  nextId: (kind: string) => string;
}

export interface DispatchClaimAuthority {
  abortPendingAuthorization(
    input: DispatchClaimEventAuthorizationInput,
    inspectCommittedEvent: (
      context: DispatchAuthorizedEventCommitContext,
    ) => Promise<PendingAuthorizationInspection>,
  ): Promise<AbortPendingAuthorizationResult>;
  commitAuthorizedEvent(
    input: DispatchClaimEventAuthorizationInput,
    commit: (context: {
      claim: DispatchClaim;
      binding: RunGraphDispatchAuthorizationBinding;
    }) => Promise<void>,
    options?: { persistRejection?: boolean; historicalReconciliation?: boolean },
  ): Promise<DispatchClaimReceipt>;
  isDispatchConfigured(): Promise<boolean>;
  isReceiptClaimCurrent(
    receipt: Extract<DispatchClaimReceipt, { accepted: true; operation: "authorize_event" }>,
  ): Promise<boolean>;
  verifyReceipt(receipt: DispatchClaimReceipt): Promise<boolean>;
  assertCurrentClaim(
    proof: DispatchClaimProof,
    expectedEntityVersion: number,
  ): Promise<DispatchClaim>;
}

export type RunGraphCommandResult =
  | {
      accepted: true;
      view: RunGraphView;
      claimAuthorization?: DispatchClaimAuthorizationResult;
    }
  | {
      accepted: false;
      code: RunGraphRejectionCode;
      message: string;
      stateUnchanged: true;
      view?: RunGraphView;
    };

export interface DispatchClaimAuthorizationResult {
  receipt: Extract<DispatchClaimReceipt, { accepted: true }>;
  proof: DispatchClaimProof;
  audit: { recorded: boolean; pending?: true; message?: string };
}

interface PreparedRunnerEvent {
  event: RunGraphAcceptedEvent;
  view: RunGraphView;
}

type PreparedRunnerEventResult =
  | { accepted: true; prepared: PreparedRunnerEvent }
  | Extract<RunGraphCommandResult, { accepted: false }>;

const defaultDependencies: RunGraphControlPlaneDependencies = {
  now: () => new Date().toISOString(),
  nextId: (kind) => `${kind}-${randomUUID()}`,
};

function actorForContractNode(contractNodeId: string) {
  const role = contractNodeId === "human-pr" ? "human" : contractNodeId;
  if (
    !(["planner", "implementer", "executor", "reviewer", "human"] as const).includes(role as never)
  ) {
    throw new Error(`未知の contract node です: ${contractNodeId}`);
  }
  return { id: `unassigned:${role}`, role } as {
    id: string;
    role: "planner" | "implementer" | "executor" | "reviewer" | "human";
  };
}

function referencedIds(command: RunGraphRunnerCommandInput["command"]): {
  artifactIds: string[];
  evidenceIds: string[];
} {
  if (command.type === "attempt_started") return { artifactIds: [], evidenceIds: [] };
  if (command.type === "run_paused" || command.type === "run_resumed") {
    return { artifactIds: [command.checkpointArtifactId], evidenceIds: command.evidenceIds };
  }
  if (command.type === "human_decision" || command.type === "pr_observed") {
    return { artifactIds: [], evidenceIds: command.evidenceIds };
  }
  return { artifactIds: command.artifactIds, evidenceIds: command.evidenceIds };
}

function boundedTailWithFocus<T>(
  items: T[],
  limit: number,
  matchesFocus: ((item: T) => boolean) | null,
): T[] {
  const tail = items.slice(-limit);
  if (!matchesFocus) return tail;
  const focused = items.filter(matchesFocus).slice(-limit);
  if (focused.length === 0) return tail;
  const focusedSet = new Set(focused);
  const remaining = Math.max(0, limit - focused.length);
  const tailCompanions =
    remaining === 0 ? [] : tail.filter((item) => !focusedSet.has(item)).slice(-remaining);
  const selected = new Set([...focused, ...tailCompanions]);
  return items.filter((item) => selected.has(item));
}

function contractSchemaKey(schemaId: string, schemaVersion: string): string {
  return `${schemaId}@${schemaVersion}`;
}

/**
 * version binding、transition、budget、authority、replay を一つの public seam に閉じ込める。
 * 外部 runner は start / applyEvent / inspect だけを使用する。
 */
export class RunGraphControlPlane {
  private readonly contracts: GraphContractStore;
  private readonly events: RunGraphEventStore;
  private readonly dependencies: RunGraphControlPlaneDependencies;
  private readonly claimAuthority: DispatchClaimAuthority;

  constructor(
    projectRoot: string,
    dependencies: RunGraphControlPlaneDependencies = defaultDependencies,
    claimAuthority?: DispatchClaimAuthority,
  ) {
    this.contracts = new GraphContractStore(projectRoot);
    this.events = new RunGraphEventStore(projectRoot);
    this.dependencies = dependencies;
    this.claimAuthority = claimAuthority ?? new DispatchClaimStore(projectRoot);
  }

  /**
   * repository registry で current proof を再検証してから completion/outcome event を受理する。
   * dispatch Config がない従来 repository は applyEvent を使い、この seam は bounded dispatch 専用とする。
   */
  async applyClaimedEvent(
    rawInput: RunGraphRunnerCommandInput,
    proof: DispatchClaimProof,
    expectedEntityVersion: number,
  ): Promise<RunGraphCommandResult> {
    const input = RunGraphRunnerCommandInputSchema.parse(rawInput);
    const parsedProof = DispatchClaimProofSchema.parse(proof);
    const view = await this.inspect(input.runId);
    if (
      input.command.type !== "attempt_finished" &&
      input.command.type !== "node_outcome_submitted"
    ) {
      return this.reject(
        input,
        "invalid_transition",
        "claim proof は completion/outcome event にだけ使用できます",
        view,
      );
    }
    const taskId = `${view.task.owner}/${view.task.repo}#${view.task.issueNumber}`.toLowerCase();
    const commandFingerprint = createHash("sha256")
      .update(canonicalJsonStringify(input))
      .digest("hex");
    const authorizationInput = {
      schemaVersion: "1",
      eventId: input.eventId,
      expectedEntityVersion,
      proof: parsedProof,
      runId: input.runId,
      taskId,
      actorId: input.actor.id,
      commandFingerprint,
    } as const;
    const existingJournal = await this.events.readJournal(input.runId);
    const existing = existingJournal.acceptedEvents.find(
      (event) => event.eventId === input.eventId,
    );
    if (existing) {
      const expectedBinding: RunGraphDispatchAuthorizationBinding = {
        claimId: parsedProof.claimId,
        fencingToken: parsedProof.fencingToken,
        ownerId: parsedProof.ownerId,
        runId: parsedProof.runId,
        taskId,
        commandFingerprint,
      };
      if (
        canonicalJsonStringify(existing.command) !== canonicalJsonStringify(input.command) ||
        canonicalJsonStringify(existing.dispatchAuthorization) !==
          canonicalJsonStringify(expectedBinding)
      ) {
        const reconciled = await this.reconcileOrAbortAuthorization(input, authorizationInput);
        if (reconciled) return reconciled;
        return this.reject(
          input,
          "duplicate_event",
          "completion event ID は異なる command に使用済みです",
          view,
        );
      }
      const replay = await this.claimAuthority.commitAuthorizedEvent(
        authorizationInput,
        async ({ binding }) => {
          if (canonicalJsonStringify(binding) !== canonicalJsonStringify(expectedBinding)) {
            throw new Error(
              "stored event の authorization binding が current claim と一致しません",
            );
          }
        },
        { persistRejection: false, historicalReconciliation: true },
      );
      // append 後・registry publish 前 crash の後に reclaim されても、既存 event だけは冪等に読む。
      if (!replay.accepted) return { accepted: true, view: await this.inspect(input.runId) };
      const audit = await this.reconcileCompletionAudit(replay);
      const claimIsCurrent =
        replay.operation === "authorize_event" &&
        (await this.claimAuthority.isReceiptClaimCurrent(replay));
      return {
        accepted: true,
        view: await this.inspect(input.runId),
        ...(claimIsCurrent
          ? { claimAuthorization: this.claimAuthorizationResult(replay, audit) }
          : {}),
      };
    }

    let receipt: DispatchClaimReceipt;
    let attemptedBinding: RunGraphDispatchAuthorizationBinding | undefined;
    try {
      await this.claimAuthority.assertCurrentClaim(parsedProof, expectedEntityVersion);
    } catch {
      const reconciled = await this.reconcileOrAbortAuthorization(input, authorizationInput);
      if (reconciled) return reconciled;
      return this.reject(input, "stale_claim", "current claim/fencing proof が一致しません", view);
    }
    const preparation = await this.validateAndBuildEvent(input);
    if (!preparation.accepted) {
      const reconciled = await this.reconcileOrAbortAuthorization(input, authorizationInput);
      if (reconciled) return reconciled;
      return preparation;
    }
    try {
      receipt = await this.claimAuthority.commitAuthorizedEvent(
        authorizationInput,
        async ({ binding }) => {
          attemptedBinding = binding;
          try {
            await this.events.appendAccepted({
              ...preparation.prepared.event,
              dispatchAuthorization: binding,
            });
          } catch (error) {
            if ((await this.inspectCommittedEvent(input, binding)) === "exact_committed") return;
            throw error;
          }
        },
      );
    } catch (error) {
      if (attemptedBinding) {
        const journal = await this.events.readJournal(input.runId);
        const committed = journal.acceptedEvents.find(
          (event) =>
            event.eventId === input.eventId &&
            canonicalJsonStringify(event.command) === canonicalJsonStringify(input.command) &&
            canonicalJsonStringify(event.dispatchAuthorization) ===
              canonicalJsonStringify(attemptedBinding),
        );
        if (committed) return { accepted: true, view: await this.inspect(input.runId) };
      }
      return {
        accepted: false,
        code: "stale_attempt",
        message: `claim transaction 内の event commit に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        stateUnchanged: true,
        view: await this.inspect(input.runId),
      };
    }
    if (!receipt.accepted) return this.reject(input, "stale_claim", receipt.message, view);
    const audit = await this.reconcileCompletionAudit(receipt);
    return {
      accepted: true,
      view: await this.inspect(input.runId),
      claimAuthorization: this.claimAuthorizationResult(receipt, audit),
    };
  }

  private async inspectCommittedEvent(
    input: RunGraphRunnerCommandInput,
    binding: RunGraphDispatchAuthorizationBinding,
  ): Promise<PendingAuthorizationInspection> {
    const journal = await this.events.readJournal(input.runId);
    const event = journal.acceptedEvents.find((candidate) => candidate.eventId === input.eventId);
    if (!event) return "absent";
    return canonicalJsonStringify(event.command) === canonicalJsonStringify(input.command) &&
      canonicalJsonStringify(event.dispatchAuthorization) === canonicalJsonStringify(binding)
      ? "exact_committed"
      : "conflict";
  }

  private async reconcileOrAbortAuthorization(
    input: RunGraphRunnerCommandInput,
    authorizationInput: DispatchClaimEventAuthorizationInput,
  ): Promise<RunGraphCommandResult | null> {
    const resolution = await this.claimAuthority.abortPendingAuthorization(
      authorizationInput,
      ({ binding }) => this.inspectCommittedEvent(input, binding),
    );
    if (resolution.status !== "exact_committed") return null;
    const receipt = resolution.receipt;
    const audit = await this.reconcileCompletionAudit(receipt);
    const claimIsCurrent = await this.claimAuthority.isReceiptClaimCurrent(receipt);
    return {
      accepted: true,
      view: await this.inspect(input.runId),
      ...(claimIsCurrent
        ? { claimAuthorization: this.claimAuthorizationResult(receipt, audit) }
        : {}),
    };
  }

  private claimAuthorizationResult(
    receipt: Extract<DispatchClaimReceipt, { accepted: true }>,
    audit: DispatchClaimAuthorizationResult["audit"],
  ): DispatchClaimAuthorizationResult {
    return {
      receipt,
      proof: {
        claimId: receipt.claim.claimId,
        fencingToken: receipt.claim.fencingToken,
        ownerId: receipt.claim.ownerId,
        runId: receipt.claim.runId,
      },
      audit,
    };
  }

  private async reconcileCompletionAudit(
    receipt: Extract<DispatchClaimReceipt, { accepted: true }>,
  ): Promise<DispatchClaimAuthorizationResult["audit"]> {
    try {
      const audit = await this.recordClaimAudit({
        schemaVersion: "1",
        eventId: `audit:${receipt.eventId}`,
        actor: { id: "registry:completion", role: "orchestrator" },
        receipt: { ...receipt, claim: receipt.claim },
      });
      if (!audit.accepted) throw new Error(audit.message);
      return { recorded: true };
    } catch (error) {
      return {
        recorded: false,
        pending: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** registry-first command を workspace-local Run Graph audit へ冪等に反映する。 */
  async recordClaimAudit(rawInput: RunGraphClaimAuditInput): Promise<RunGraphCommandResult> {
    const input = RunGraphClaimAuditInputSchema.parse(rawInput);
    const receipt = input.receipt;
    const runId = receipt.claim.runId;
    const journal = await this.events.readJournal(runId);
    const expectedAuditEventId = `audit:${receipt.eventId}`;
    if (input.eventId !== expectedAuditEventId) {
      return {
        accepted: false,
        code: "duplicate_event",
        message: `claim audit event ID は receipt から一意に導出する必要があります: ${expectedAuditEventId}`,
        stateUnchanged: true,
        view: await this.inspect(runId),
      };
    }
    const existing = journal.acceptedEvents.find((event) => event.eventId === input.eventId);
    const typeByOperation = {
      claim: "claim_acquired",
      heartbeat: "claim_heartbeat",
      release: "claim_released",
      reclaim: "claim_reclaimed",
      authorize_event: "claim_event_authorized",
    } as const;
    const command = RunGraphClaimAuditCommandSchema.parse({
      type: typeByOperation[receipt.operation],
      registryEventId: receipt.eventId,
      registryEntityVersion: receipt.entityVersion,
      claim: receipt.claim,
      ...(receipt.operation === "reclaim"
        ? {
            reclaimReason: receipt.reclaimReason,
            ...(receipt.reclaimReason === "owner_stopped"
              ? { evidenceId: receipt.evidenceId }
              : {}),
          }
        : {}),
      ...(receipt.operation === "authorize_event" ? { completion: receipt.completion } : {}),
    });
    const existingRegistryAudit = journal.acceptedEvents.find(
      (event) =>
        "registryEventId" in event.command &&
        event.command.registryEventId === receipt.eventId &&
        event.eventId !== expectedAuditEventId,
    );
    if (existingRegistryAudit) {
      return {
        accepted: false,
        code: "duplicate_event",
        message: `registry event は別の audit event ID で記録済みです: ${receipt.eventId}`,
        stateUnchanged: true,
        view: await this.inspect(runId),
      };
    }
    if (!(await this.claimAuthority.verifyReceipt(receipt))) {
      return {
        accepted: false,
        code: "stale_claim",
        message: "claim audit receipt は repository registry の durable receipt と一致しません",
        stateUnchanged: true,
        view: await this.inspect(runId),
      };
    }
    if (existing) {
      if (canonicalJsonStringify(existing.command) === canonicalJsonStringify(command)) {
        return { accepted: true, view: await this.inspect(runId) };
      }
      return {
        accepted: false,
        code: "duplicate_event",
        message: `Run Graph event ID は異なる audit に使用済みです: ${input.eventId}`,
        stateUnchanged: true,
        view: await this.inspect(runId),
      };
    }
    if (input.actor.role !== "orchestrator") {
      return {
        accepted: false,
        code: "authority_denied",
        message: "claim audit は orchestrator authority が必要です",
        stateUnchanged: true,
        view: await this.inspect(runId),
      };
    }
    const event: RunGraphAcceptedEvent = {
      recordType: "accepted",
      eventId: input.eventId,
      sequence: journal.acceptedEvents.length + 1,
      runId,
      acceptedAt: this.dependencies.now(),
      actor: input.actor,
      command,
      artifactIds: [],
      evidenceIds: [],
    };
    await this.events.appendAccepted(event);
    return { accepted: true, view: await this.inspect(runId) };
  }

  async start(rawInput: RunGraphStartInput): Promise<RunGraphCommandResult> {
    const input = RunGraphStartInputSchema.parse(rawInput);
    let contract: GraphContract;
    try {
      contract = await this.contracts.read(input.contract);
    } catch (error) {
      return {
        accepted: false,
        code: "unsupported_contract_binding",
        message: error instanceof Error ? error.message : String(error),
        stateUnchanged: true,
      };
    }
    if (!this.contractAllows(contract, "run_start", input.actor.role)) {
      return {
        accepted: false,
        code: "authority_denied",
        message: "Graph Contract が actor に run_start authority を許可していません",
        stateUnchanged: true,
      };
    }

    for (const runId of await this.events.listRunIds()) {
      const journal = await this.events.readJournal(runId);
      if (journal.acceptedEvents.some((event) => event.eventId === input.eventId)) {
        return {
          accepted: false,
          code: "duplicate_event",
          message: `受理済み event ID です: ${input.eventId}`,
          stateUnchanged: true,
          view: await this.inspect(runId),
        };
      }
    }

    const runId = this.dependencies.nextId("run");
    const firstNodeId = this.dependencies.nextId("node");
    const event: RunGraphAcceptedEvent = {
      recordType: "accepted",
      eventId: input.eventId,
      sequence: 1,
      runId,
      acceptedAt: this.dependencies.now(),
      actor: input.actor,
      command: {
        type: "run_started",
        task: input.task,
        contract: input.contract,
        firstNodeId,
      },
      artifactIds: [],
      evidenceIds: [],
    };
    await this.events.appendAccepted(event);
    return { accepted: true, view: await this.inspect(runId) };
  }

  async applyEvent(rawInput: RunGraphRunnerCommandInput): Promise<RunGraphCommandResult> {
    const input = RunGraphRunnerCommandInputSchema.parse(rawInput);
    if (
      input.command.type === "attempt_finished" ||
      input.command.type === "node_outcome_submitted"
    ) {
      try {
        if (await this.claimAuthority.isDispatchConfigured()) {
          return this.rejectAndRecord(
            input,
            "stale_claim",
            "dispatch 有効 repository の completion/outcome は claim authorization が必要です",
            await this.inspect(input.runId),
          );
        }
      } catch (error) {
        if (!isNotGitRepositoryError(error)) throw error;
      }
    }
    const prepared = await this.validateAndBuildEvent(input);
    if (!prepared.accepted) {
      return this.rejectAndRecord(input, prepared.code, prepared.message, prepared.view!);
    }
    await this.events.appendAccepted(prepared.prepared.event);
    return { accepted: true, view: await this.inspect(input.runId) };
  }

  /** domain validation と event materialize を永続化から分離した explicit seam。 */
  private async validateAndBuildEvent(
    rawInput: RunGraphRunnerCommandInput,
  ): Promise<PreparedRunnerEventResult> {
    const input = RunGraphRunnerCommandInputSchema.parse(rawInput);
    const journal = await this.events.readJournal(input.runId);
    const projection = this.replay(journal);
    const view = await this.inspect(input.runId);
    if (journal.acceptedEvents.some((event) => event.eventId === input.eventId)) {
      return this.reject(
        input,
        "duplicate_event",
        `受理済み event ID です: ${input.eventId}`,
        view,
      );
    }
    const currentNode = projection.nodes.find((node) => node.id === projection.run.currentNodeId);
    if (!currentNode) {
      return this.reject(input, "invalid_transition", "current node が存在しません", view);
    }
    const contract = await this.contracts.read(projection.run.contract);
    if (!this.hasAuthority(input, currentNode.actor.role, contract)) {
      return this.reject(
        input,
        "authority_denied",
        "actor に command authority がありません",
        view,
      );
    }

    if ("nodeId" in input.command && input.command.nodeId !== currentNode.id) {
      return this.reject(
        input,
        "stale_attempt",
        "command の node は current node ではありません",
        view,
      );
    }
    if (input.command.type === "attempt_started") {
      const { attemptId } = input.command;
      if (projection.attempts.some((attempt) => attempt.id === attemptId)) {
        return this.reject(
          input,
          "stale_attempt",
          `attempt ID は Run 内で受理済みです: ${attemptId}`,
          view,
        );
      }
    }
    const activeAttempt = currentNode.activeAttemptId
      ? projection.attempts.find((attempt) => attempt.id === currentNode.activeAttemptId)
      : undefined;
    if (
      (input.command.type === "run_paused" || input.command.type === "run_resumed") &&
      !activeAttempt
    ) {
      return this.reject(
        input,
        "stale_attempt",
        "pause/resume に対応する active attempt がありません",
        view,
      );
    }
    if (
      (input.command.type === "attempt_finished" ||
        input.command.type === "node_outcome_submitted") &&
      (!activeAttempt || input.command.attemptId !== activeAttempt.id)
    ) {
      return this.reject(
        input,
        "stale_attempt",
        "command の attempt は current attempt ではありません",
        view,
      );
    }
    const attemptBoundCommand =
      input.command.type === "attempt_finished" || input.command.type === "node_outcome_submitted";
    const contractNode = contract.nodes.find((node) => node.id === currentNode.contractNodeId);
    if (
      attemptBoundCommand &&
      activeAttempt &&
      (!contractNode ||
        activeAttempt.actor.id !== input.actor.id ||
        activeAttempt.actor.role !== input.actor.role ||
        activeAttempt.actor.role !== contractNode.role)
    ) {
      return this.reject(
        input,
        "authority_denied",
        "command actor は active attempt と Graph Contract の authority に一致しません",
        view,
      );
    }

    const transitionError = this.validateTransition(
      input,
      projection,
      currentNode.contractNodeId,
      currentNode.state,
      activeAttempt?.state,
    );
    if (transitionError) {
      return this.reject(input, transitionError.code, transitionError.message, view);
    }

    const artifactSubmissionIds = (input.artifacts ?? []).map((artifact) => artifact.id);
    const evidenceSubmissionIds = (input.evidence ?? []).map((item) => item.id);
    if (
      new Set(artifactSubmissionIds).size !== artifactSubmissionIds.length ||
      artifactSubmissionIds.some((id) =>
        projection.artifacts.some((artifact) => artifact.id === id),
      )
    ) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "artifact ID は Run 内で一意である必要があります",
        view,
      );
    }
    if (
      new Set(evidenceSubmissionIds).size !== evidenceSubmissionIds.length ||
      evidenceSubmissionIds.some((id) => projection.evidence.some((item) => item.id === id))
    ) {
      return this.reject(
        input,
        "evidence_required",
        "evidence ID は Run 内で一意である必要があります",
        view,
      );
    }
    const knownArtifactSchemas = new Set(
      contract.artifactSchemas.map((schema) => contractSchemaKey(schema.id, schema.version)),
    );
    if (
      (input.artifacts ?? []).some(
        (artifact) =>
          !knownArtifactSchemas.has(contractSchemaKey(artifact.schemaId, artifact.schemaVersion)),
      )
    ) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "Graph Contract にない artifact schema です",
        view,
      );
    }
    if ((input.evidence ?? []).some((item) => !contract.evidenceKinds.includes(item.kind))) {
      return this.reject(
        input,
        "evidence_required",
        "Graph Contract にない evidence kind です",
        view,
      );
    }

    if ((input.artifacts?.length ?? 0) > 0 && !activeAttempt) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "artifact を生成した active attempt がありません",
        view,
      );
    }

    const acceptedAt = this.dependencies.now();
    const artifacts = activeAttempt
      ? this.materializeArtifacts(input, projection, currentNode.id, activeAttempt.id, acceptedAt)
      : [];
    const evidence = this.materializeEvidence(
      input,
      projection,
      currentNode.id,
      activeAttempt?.id,
      acceptedAt,
    );
    const references = referencedIds(input.command);
    const allArtifactIds = new Set([
      ...projection.artifacts.map((artifact) => artifact.id),
      ...artifacts.map((artifact) => artifact.id),
    ]);
    const allEvidenceIds = new Set([
      ...projection.evidence.map((item) => item.id),
      ...evidence.map((item) => item.id),
    ]);
    if (references.artifactIds.some((id) => !allArtifactIds.has(id))) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "参照 artifact が登録されていません",
        view,
      );
    }
    if (references.evidenceIds.some((id) => !allEvidenceIds.has(id))) {
      return this.reject(input, "evidence_required", "参照 evidence が登録されていません", view);
    }
    const allArtifacts = [...projection.artifacts, ...artifacts];
    const allEvidence = [...projection.evidence, ...evidence];
    if (
      artifacts.some((artifact) =>
        artifact.derivedFromArtifactIds.some((id) => !allArtifactIds.has(id)),
      ) ||
      evidence.some((item) => item.artifactIds.some((id) => !allArtifactIds.has(id)))
    ) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "artifact lineage の参照先が登録されていません",
        view,
      );
    }

    const artifactsForCommand = references.artifactIds
      .map((id) => allArtifacts.find((artifact) => artifact.id === id))
      .filter((artifact): artifact is RunGraphArtifact => artifact !== undefined);
    const evidenceForCommand = references.evidenceIds
      .map((id) => allEvidence.find((item) => item.id === id))
      .filter((item): item is RunGraphEvidence => item !== undefined);
    if (attemptBoundCommand) {
      if (!activeAttempt) {
        return this.reject(
          input,
          "stale_attempt",
          "attempt-bound command に対応する active attempt がありません",
          view,
        );
      }
      if (
        artifactsForCommand.some(
          (artifact) =>
            artifact.nodeId !== currentNode.id ||
            artifact.producerAttemptId !== activeAttempt.id ||
            artifact.actor.id !== activeAttempt.actor.id ||
            artifact.actor.role !== activeAttempt.actor.role,
        ) ||
        evidenceForCommand.some(
          (item) =>
            item.nodeId !== currentNode.id ||
            item.producerAttemptId !== activeAttempt.id ||
            item.actor.id !== activeAttempt.actor.id ||
            item.actor.role !== activeAttempt.actor.role,
        )
      ) {
        return this.reject(
          input,
          "stale_attempt",
          "attempt-bound command の artifact/evidence は active attempt の lineage に属していません",
          view,
        );
      }
    }
    if (
      input.command.type === "attempt_finished" &&
      evidenceForCommand.some((item) => item.kind !== "command_execution")
    ) {
      return this.reject(
        input,
        "evidence_required",
        "attempt result には command_execution evidence が必要です",
        view,
      );
    }
    if (input.command.type === "run_paused" || input.command.type === "run_resumed") {
      const checkpointArtifactId = input.command.checkpointArtifactId;
      const checkpoint = allArtifacts.find((artifact) => artifact.id === checkpointArtifactId);
      if (
        !checkpoint ||
        contractSchemaKey(checkpoint.schemaId, checkpoint.schemaVersion) !== "run.checkpoint@1"
      ) {
        return this.reject(
          input,
          "artifact_schema_mismatch",
          "pause/resume には run.checkpoint@1 が必要です",
          view,
        );
      }
      if (
        !evidenceForCommand.some(
          (item) => item.kind === "checkpoint" && item.artifactIds.includes(checkpoint.id),
        ) ||
        evidenceForCommand.some(
          (item) => !["checkpoint", "side_effect_reconciliation"].includes(item.kind),
        )
      ) {
        return this.reject(
          input,
          "evidence_required",
          "checkpoint evidence が checkpoint artifact を参照していません",
          view,
        );
      }
      const checkpointEvidence = evidenceForCommand.filter(
        (item) => item.kind === "checkpoint" && item.artifactIds.includes(checkpoint.id),
      );
      if (
        input.command.type === "run_paused" &&
        (!activeAttempt ||
          checkpoint.nodeId !== currentNode.id ||
          checkpoint.producerAttemptId !== activeAttempt.id ||
          checkpoint.actor.id !== activeAttempt.actor.id ||
          checkpoint.actor.role !== activeAttempt.actor.role ||
          checkpointEvidence.some(
            (item) =>
              item.nodeId !== currentNode.id ||
              item.producerAttemptId !== activeAttempt.id ||
              item.actor.id !== activeAttempt.actor.id ||
              item.actor.role !== activeAttempt.actor.role,
          ))
      ) {
        return this.reject(
          input,
          "stale_attempt",
          "checkpoint artifact/evidence は active attempt の lineage に属していません",
          view,
        );
      }
      if (input.command.type === "run_resumed") {
        const resumeCommand = input.command;
        const latestPause = [...journal.acceptedEvents]
          .reverse()
          .find((event) => event.command.type === "run_paused");
        const latestPauseCommand =
          latestPause?.command.type === "run_paused" ? latestPause.command : undefined;
        const latestCheckpointEvidenceIds =
          latestPause && latestPauseCommand
            ? latestPause.evidenceIds.filter((id) => {
                const item = allEvidence.find((evidenceItem) => evidenceItem.id === id);
                return (
                  item?.kind === "checkpoint" &&
                  item.artifactIds.includes(latestPauseCommand.checkpointArtifactId)
                );
              })
            : [];
        if (
          !activeAttempt ||
          !latestPauseCommand ||
          latestPauseCommand.checkpointArtifactId !== checkpoint.id ||
          latestCheckpointEvidenceIds.length === 0 ||
          latestCheckpointEvidenceIds.some((id) => !resumeCommand.evidenceIds.includes(id)) ||
          checkpoint.nodeId !== currentNode.id ||
          checkpoint.producerAttemptId !== activeAttempt.id ||
          checkpoint.actor.id !== activeAttempt.actor.id ||
          checkpoint.actor.role !== activeAttempt.actor.role ||
          checkpointEvidence.some(
            (item) =>
              item.nodeId !== currentNode.id ||
              item.producerAttemptId !== activeAttempt.id ||
              item.actor.id !== activeAttempt.actor.id ||
              item.actor.role !== activeAttempt.actor.role,
          )
        ) {
          return this.reject(
            input,
            "stale_attempt",
            "resume checkpoint は最新 pause と active attempt の lineage に一致していません",
            view,
          );
        }
        if (input.command.sideEffectState === "unknown") {
          return this.reject(
            input,
            "evidence_required",
            "外部副作用の状態が unknown の Run は自動再開できません",
            view,
          );
        }
        if (
          (input.command.sideEffectState === "committed" ||
            input.command.sideEffectState === "reconciled") &&
          !evidenceForCommand.some((item) => item.kind === "side_effect_reconciliation")
        ) {
          return this.reject(
            input,
            "evidence_required",
            "実行済み外部副作用には reconciliation evidence が必要です",
            view,
          );
        }
      }
    }
    if (
      input.command.type === "human_decision" &&
      evidenceForCommand.some((item) => item.kind !== "human_decision")
    ) {
      return this.reject(input, "evidence_required", "human decision evidence が必要です", view);
    }
    if (input.command.type === "pr_observed") {
      const expectedRepository = `${projection.run.task.owner}/${projection.run.task.repo}`;
      if (input.command.repository.toLowerCase() !== expectedRepository.toLowerCase()) {
        return this.reject(
          input,
          "pr_not_linked_to_task",
          `PR evidence の repository は ${expectedRepository} である必要があります`,
          view,
        );
      }
      if (!input.command.linkedIssue) {
        return this.reject(
          input,
          input.command.linkageComplete ? "pr_not_linked_to_task" : "github_live_state_unavailable",
          input.command.linkageComplete
            ? `PR #${input.command.pullRequestNumber} は Run 対象 Issue #${projection.run.task.issueNumber} に紐づいていません`
            : "PR と Run 対象 Issue の live linkage を確定できません",
          view,
        );
      }
      if (
        input.command.linkedIssue.owner.toLowerCase() !== projection.run.task.owner.toLowerCase() ||
        input.command.linkedIssue.repo.toLowerCase() !== projection.run.task.repo.toLowerCase() ||
        input.command.linkedIssue.issueNumber !== projection.run.task.issueNumber
      ) {
        return this.reject(
          input,
          "pr_not_linked_to_task",
          "PR の live linkage が Run 対象 Issue と一致しません",
          view,
        );
      }
      if (
        evidenceForCommand.length === 0 ||
        evidenceForCommand.some((item) => item.kind !== "github_pr_live")
      ) {
        return this.reject(
          input,
          "evidence_required",
          "GitHub から取得した PR live evidence が必要です",
          view,
        );
      }
    }

    let nextNodeId: string | undefined;
    let nextContractNodeId: string | undefined;
    let waitReason: string | undefined;
    if (
      input.command.type === "attempt_finished" &&
      input.command.outcome !== "succeeded" &&
      input.command.outcome !== "cancelled"
    ) {
      waitReason = `attempt_${input.command.outcome}`;
    }
    if (input.command.type === "node_outcome_submitted") {
      const expectedSchemas =
        contract.nodes.find((node) => node.id === currentNode.contractNodeId)
          ?.outputArtifactSchemas ?? [];
      if (
        artifactsForCommand.length === 0 ||
        artifactsForCommand.some(
          (artifact) =>
            !expectedSchemas.includes(contractSchemaKey(artifact.schemaId, artifact.schemaVersion)),
        )
      ) {
        return this.reject(
          input,
          "artifact_schema_mismatch",
          `node ${currentNode.contractNodeId} の output artifact schema と一致しません`,
          view,
        );
      }
      if (references.evidenceIds.length === 0) {
        return this.reject(
          input,
          "evidence_required",
          "node outcome には evidence が必要です",
          view,
        );
      }
      const requiredEvidenceKind =
        currentNode.contractNodeId === "reviewer" ? "independent_review" : "artifact_validation";
      if (evidenceForCommand.some((item) => item.kind !== requiredEvidenceKind)) {
        return this.reject(
          input,
          "evidence_required",
          `node outcome には ${requiredEvidenceKind} evidence が必要です`,
          view,
        );
      }
      const transition = this.resolveNodeOutcome(
        contract,
        currentNode.contractNodeId,
        input.command.outcome,
        projection,
      );
      if (!transition) {
        return this.reject(input, "invalid_transition", "contract にない node outcome です", view);
      }
      nextNodeId = this.dependencies.nextId("node");
      nextContractNodeId = transition.target;
      waitReason = transition.waitReason;
    }
    if (input.command.type === "human_decision") {
      const currentWaitReason = [...journal.acceptedEvents]
        .reverse()
        .find((event) => event.waitReason)?.waitReason;
      if (
        input.command.decision === "approved" &&
        currentWaitReason !== "human_approval_required"
      ) {
        return this.reject(
          input,
          "invalid_transition",
          "budget/blocked gate を解除するには理由付き override が必要です",
          view,
        );
      }
      if (
        input.command.decision === "override" &&
        currentWaitReason !== "human_approval_required"
      ) {
        const overrideEdge = contract.edges.find(
          (edge) => edge.from === currentNode.contractNodeId && edge.condition === "human_override",
        );
        if (!overrideEdge || overrideEdge.to === "terminal") {
          return this.reject(
            input,
            "invalid_transition",
            `node ${currentNode.contractNodeId} に human_override edge がありません`,
            view,
          );
        }
        nextNodeId = this.dependencies.nextId("node");
        nextContractNodeId = overrideEdge.to;
      }
    }

    const event: RunGraphAcceptedEvent = {
      recordType: "accepted",
      eventId: input.eventId,
      sequence: journal.acceptedEvents.length + 1,
      runId: input.runId,
      acceptedAt,
      actor: input.actor,
      command: input.command,
      artifactIds: references.artifactIds,
      evidenceIds: references.evidenceIds,
      artifacts,
      evidence,
      ...(nextNodeId ? { nextNodeId } : {}),
      ...(nextContractNodeId ? { nextContractNodeId } : {}),
      ...(waitReason ? { waitReason } : {}),
    };
    return { accepted: true, prepared: { event, view } };
  }

  async inspect(runId: string, limit = 20, focusNodeId?: string): Promise<RunGraphView> {
    const journal = await this.events.readJournal(runId);
    const projection = this.replay(journal);
    const currentNode =
      projection.nodes.find((node) => node.id === projection.run.currentNodeId) ?? null;
    const activeAttempt = currentNode?.activeAttemptId
      ? (projection.attempts.find((attempt) => attempt.id === currentNode.activeAttemptId) ?? null)
      : null;
    const nodes = boundedTailWithFocus(
      projection.nodes,
      limit,
      focusNodeId ? (node) => node.id === focusNodeId : null,
    );
    const attempts = boundedTailWithFocus(
      projection.attempts,
      limit,
      focusNodeId ? (attempt) => attempt.nodeId === focusNodeId : null,
    );
    const artifacts = boundedTailWithFocus(
      projection.artifacts,
      limit,
      focusNodeId ? (artifact) => artifact.nodeId === focusNodeId : null,
    );
    const evidence = boundedTailWithFocus(
      projection.evidence,
      limit,
      focusNodeId ? (item) => item.nodeId === focusNodeId : null,
    );
    const allClaimAudits = journal.acceptedEvents
      .filter((event) =>
        (
          [
            "claim_acquired",
            "claim_heartbeat",
            "claim_released",
            "claim_reclaimed",
            "claim_event_authorized",
          ] as const
        ).includes(event.command.type as never),
      )
      .map((event) => ({
        eventId: event.eventId,
        acceptedAt: event.acceptedAt,
        actor: event.actor,
        command: event.command,
      }));
    const claimAudits = allClaimAudits.slice(-limit);
    return RunGraphViewSchema.parse({
      schemaVersion: "1",
      runId: projection.run.id,
      task: projection.run.task,
      contract: projection.run.contract,
      revision: projection.revision,
      state: projection.run.state,
      createdAt: projection.run.createdAt,
      updatedAt: projection.run.updatedAt,
      currentNode,
      activeAttempt,
      waitReason:
        projection.run.state === "waiting_human"
          ? ([...journal.acceptedEvents].reverse().find((event) => event.waitReason)?.waitReason ??
            "human_gate_required")
          : null,
      budgets: projection.budgets,
      allowedNextTransitions: this.allowedNextTransitions(projection, currentNode, activeAttempt),
      nodes: {
        total: projection.nodes.length,
        limit,
        truncated: projection.nodes.length > nodes.length,
        items: nodes,
      },
      attempts: {
        total: projection.attempts.length,
        limit,
        truncated: projection.attempts.length > attempts.length,
        items: attempts,
      },
      artifacts: {
        total: projection.artifacts.length,
        limit,
        truncated: projection.artifacts.length > artifacts.length,
        items: artifacts,
      },
      evidence: {
        total: projection.evidence.length,
        limit,
        truncated: projection.evidence.length > evidence.length,
        items: evidence,
      },
      claimAudits: {
        total: allClaimAudits.length,
        limit,
        truncated: allClaimAudits.length > claimAudits.length,
        items: claimAudits,
      },
    });
  }

  private async reject(
    input: RunGraphRunnerCommandInput,
    code: RunGraphRejectionCode,
    message: string,
    view: RunGraphView,
  ): Promise<Extract<RunGraphCommandResult, { accepted: false }>> {
    return { accepted: false, code, message, stateUnchanged: true, view };
  }

  private async rejectAndRecord(
    input: RunGraphRunnerCommandInput,
    code: RunGraphRejectionCode,
    message: string,
    view: RunGraphView,
  ): Promise<Extract<RunGraphCommandResult, { accepted: false }>> {
    await this.events.appendRejection({
      recordType: "rejected",
      rejectionId: this.dependencies.nextId("rejection"),
      eventId: input.eventId,
      runId: input.runId,
      rejectedAt: this.dependencies.now(),
      actor: input.actor,
      command: input.command,
      code,
      message,
      stateUnchanged: true,
    });
    return { accepted: false, code, message, stateUnchanged: true, view };
  }

  private hasAuthority(
    input: RunGraphRunnerCommandInput,
    currentRole: string,
    contract: GraphContract,
  ): boolean {
    if (input.command.type === "human_decision") {
      return this.contractAllows(contract, "human_decision", input.actor.role);
    }
    if (input.command.type === "pr_observed") {
      return this.contractAllows(contract, "pr_observe", input.actor.role);
    }
    if (input.command.type === "run_paused" || input.command.type === "run_resumed") {
      return (
        this.contractAllows(contract, "run_checkpoint", input.actor.role) &&
        (input.actor.role === currentRole || input.actor.role === "orchestrator")
      );
    }
    return (
      this.contractAllows(contract, "node_attempt", input.actor.role) &&
      input.actor.role === currentRole
    );
  }

  private contractAllows(contract: GraphContract, action: string, role: string): boolean {
    return (
      contract.authorities
        .find((authority) => authority.action === action)
        ?.roles.includes(role as GraphContract["roles"][number]["id"]) ?? false
    );
  }

  private validateTransition(
    input: RunGraphRunnerCommandInput,
    projection: RunGraphProjection,
    contractNodeId: string,
    nodeState: string,
    attemptState: string | undefined,
  ): { code: RunGraphRejectionCode; message: string } | null {
    const type = input.command.type;
    if (type === "attempt_started" && nodeState === "ready") return null;
    if (type === "attempt_finished" && nodeState === "running" && attemptState === "running") {
      if (input.command.evidenceIds.length === 0) {
        return { code: "evidence_required", message: "attempt result には evidence が必要です" };
      }
      return null;
    }
    if (
      type === "node_outcome_submitted" &&
      nodeState === "running" &&
      attemptState === "succeeded"
    ) {
      return null;
    }
    if (type === "run_paused" && projection.run.state === "running" && nodeState === "running") {
      return null;
    }
    if (type === "run_resumed" && projection.run.state === "paused" && nodeState === "paused") {
      return null;
    }
    if (type === "human_decision" && projection.run.state === "waiting_human") {
      return input.command.evidenceIds.length > 0
        ? null
        : { code: "evidence_required", message: "human decision には evidence が必要です" };
    }
    if (
      type === "pr_observed" &&
      projection.run.state === "running" &&
      contractNodeId === "human-pr" &&
      nodeState === "running"
    ) {
      return null;
    }
    return { code: "invalid_transition", message: `${type} は現在の state では受理できません` };
  }

  private materializeArtifacts(
    input: RunGraphRunnerCommandInput,
    projection: RunGraphProjection,
    nodeId: string,
    attemptId: string,
    createdAt: string,
  ): RunGraphArtifact[] {
    const producerActor =
      input.command.type === "run_paused"
        ? (projection.attempts.find((attempt) => attempt.id === attemptId)?.actor ?? input.actor)
        : input.actor;
    return (input.artifacts ?? []).map((artifact) => ({
      ...artifact,
      runId: input.runId,
      nodeId,
      producerAttemptId: attemptId,
      actor: producerActor,
      createdAt,
    }));
  }

  private allowedNextTransitions(
    projection: RunGraphProjection,
    currentNode: RunGraphProjection["nodes"][number] | null,
    activeAttempt: RunGraphProjection["attempts"][number] | null,
  ): RunGraphView["allowedNextTransitions"] {
    if (projection.run.state === "paused") return ["run_resumed"];
    if (projection.run.state === "waiting_human") return ["human_decision"];
    if (currentNode?.contractNodeId === "human-pr" && currentNode.state === "running") {
      return ["pr_observed"];
    }
    if (currentNode?.state === "ready") return ["attempt_started"];
    if (currentNode?.state === "running" && activeAttempt?.state === "running") {
      return ["attempt_finished", "run_paused"];
    }
    if (currentNode?.state === "running" && activeAttempt?.state === "succeeded") {
      return ["node_outcome_submitted", "run_paused"];
    }
    return [];
  }

  private materializeEvidence(
    input: RunGraphRunnerCommandInput,
    projection: RunGraphProjection,
    nodeId: string,
    attemptId: string | undefined,
    createdAt: string,
  ): RunGraphEvidence[] {
    const producerActor =
      input.command.type === "run_paused" && attemptId
        ? (projection.attempts.find((attempt) => attempt.id === attemptId)?.actor ?? input.actor)
        : input.actor;
    return (input.evidence ?? []).map((item) => ({
      ...item,
      runId: input.runId,
      nodeId,
      producerAttemptId: attemptId ?? null,
      actor: producerActor,
      createdAt,
    }));
  }

  private resolveNodeOutcome(
    contract: GraphContract,
    contractNodeId: string,
    outcome: string,
    projection: RunGraphProjection,
  ): { target: string; waitReason?: string } | null {
    const target = (condition: string): string | null =>
      contract.edges.find((edge) => edge.from === contractNodeId && edge.condition === condition)
        ?.to ?? null;
    if (contractNodeId === "planner") {
      const next = target(outcome);
      return outcome === "plan_valid" && next
        ? { target: next }
        : outcome === "plan_invalid" && next
          ? { target: next, waitReason: "plan_invalid" }
          : null;
    }
    if (contractNodeId === "implementer") {
      const next = target(outcome);
      return outcome === "implementation_valid" && next
        ? { target: next }
        : outcome === "implementation_invalid" && next
          ? { target: next, waitReason: "implementation_invalid" }
          : null;
    }
    if (contractNodeId === "executor") {
      if (outcome === "verify_passed") {
        const next = target(outcome);
        return next ? { target: next } : null;
      }
      if (outcome === "verify_failed") {
        const budgetAvailable =
          projection.budgets.executorRetries < contract.budgets.maxExecutorRetries;
        const condition = budgetAvailable ? outcome : "verify_budget_exhausted";
        const next = target(condition);
        return next
          ? budgetAvailable
            ? { target: next }
            : { target: next, waitReason: "verify_budget_exhausted" }
          : null;
      }
      return null;
    }
    if (contractNodeId === "reviewer") {
      if (outcome === "approve" || outcome === "comment") {
        const next = target(outcome);
        return next ? { target: next, waitReason: "human_approval_required" } : null;
      }
      if (outcome === "request_changes") {
        const budgetAvailable =
          projection.budgets.improvementIterations < contract.budgets.maxImprovementIterations;
        const condition = budgetAvailable ? outcome : "review_budget_exhausted";
        const next = target(condition);
        return next
          ? budgetAvailable
            ? { target: next }
            : { target: next, waitReason: "review_budget_exhausted" }
          : null;
      }
      if (outcome === "block" || outcome === "critical") {
        const next = target(outcome);
        return next
          ? { target: next, waitReason: outcome === "critical" ? "escalated" : "blocked" }
          : null;
      }
    }
    return null;
  }

  private replay(journal: { acceptedEvents: RunGraphAcceptedEvent[] }): RunGraphProjection {
    const first = journal.acceptedEvents[0];
    if (!first || first.command.type !== "run_started") {
      throw new Error("Run Graph の先頭 event は run_started である必要があります");
    }
    const timestamp = first.acceptedAt;
    const projection: RunGraphProjection = {
      schemaVersion: "1",
      revision: 1,
      run: {
        id: first.runId,
        state: "running",
        task: first.command.task,
        contract: first.command.contract,
        actor: first.actor,
        createdAt: timestamp,
        updatedAt: timestamp,
        currentNodeId: first.command.firstNodeId,
        parentRunId: null,
        inputArtifactIds: [],
        outputArtifactIds: [],
      },
      nodes: [
        {
          id: first.command.firstNodeId,
          runId: first.runId,
          contractNodeId: "planner",
          state: "ready",
          actor: actorForContractNode("planner"),
          createdAt: timestamp,
          updatedAt: timestamp,
          activeAttemptId: null,
          previousNodeId: null,
          inputArtifactIds: [],
          outputArtifactIds: [],
        },
      ],
      attempts: [],
      artifacts: [],
      evidence: [],
      budgets: { executorRetries: 0, improvementIterations: 0 },
    };

    for (const event of journal.acceptedEvents.slice(1)) {
      const command = event.command;
      if (command.type === "run_started") {
        throw new Error("run_started は journal の先頭にだけ置けます");
      }
      projection.revision = event.sequence;
      projection.run.updatedAt = event.acceptedAt;
      projection.artifacts.push(...(event.artifacts ?? []));
      projection.evidence.push(...(event.evidence ?? []));
      for (const artifact of event.artifacts ?? []) {
        if (!projection.run.outputArtifactIds.includes(artifact.id)) {
          projection.run.outputArtifactIds.push(artifact.id);
        }
      }

      const currentNode = projection.nodes.find((node) => node.id === projection.run.currentNodeId);
      if (!currentNode) throw new Error("current node が projection に存在しません");

      if (
        command.type === "claim_acquired" ||
        command.type === "claim_heartbeat" ||
        command.type === "claim_released" ||
        command.type === "claim_reclaimed" ||
        command.type === "claim_event_authorized"
      ) {
        continue;
      }

      if (command.type === "attempt_started") {
        const previous = projection.attempts
          .filter((attempt) => attempt.nodeId === currentNode.id)
          .at(-1);
        projection.attempts.push({
          id: command.attemptId,
          runId: projection.run.id,
          nodeId: currentNode.id,
          ordinal: (previous?.ordinal ?? 0) + 1,
          state: "running",
          actor: event.actor,
          createdAt: event.acceptedAt,
          updatedAt: event.acceptedAt,
          previousAttemptId: previous?.id ?? null,
          inputArtifactIds: [...currentNode.inputArtifactIds],
          outputArtifactIds: [],
        });
        currentNode.state = "running";
        currentNode.actor = event.actor;
        currentNode.activeAttemptId = command.attemptId;
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }

      const activeAttempt = currentNode.activeAttemptId
        ? projection.attempts.find((attempt) => attempt.id === currentNode.activeAttemptId)
        : undefined;

      if (command.type === "attempt_finished") {
        if (!activeAttempt)
          throw new Error("attempt result に対応する active attempt がありません");
        activeAttempt.state = command.outcome;
        activeAttempt.updatedAt = event.acceptedAt;
        activeAttempt.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !activeAttempt.outputArtifactIds.includes(id)),
        );
        currentNode.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !currentNode.outputArtifactIds.includes(id)),
        );
        currentNode.updatedAt = event.acceptedAt;
        if (command.outcome === "cancelled") {
          currentNode.state = "cancelled";
          projection.run.state = "cancelled";
        } else if (command.outcome !== "succeeded") {
          currentNode.state = "waiting_human";
          projection.run.state = "waiting_human";
        }
        continue;
      }

      if (command.type === "node_outcome_submitted") {
        if (!activeAttempt) throw new Error("node outcome に対応する active attempt がありません");
        activeAttempt.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !activeAttempt.outputArtifactIds.includes(id)),
        );
        currentNode.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !currentNode.outputArtifactIds.includes(id)),
        );
        currentNode.state = "completed";
        currentNode.updatedAt = event.acceptedAt;
        if (
          currentNode.contractNodeId === "executor" &&
          command.outcome === "verify_failed" &&
          !event.waitReason
        ) {
          projection.budgets.executorRetries += 1;
        }
        if (
          currentNode.contractNodeId === "reviewer" &&
          command.outcome === "request_changes" &&
          !event.waitReason
        ) {
          projection.budgets.improvementIterations += 1;
        }
        if (!event.nextNodeId || !event.nextContractNodeId) {
          throw new Error("node outcome accepted event に next node binding がありません");
        }
        const targetContractNodeId = event.nextContractNodeId;
        const waitingHuman = targetContractNodeId === "human-pr";
        projection.nodes.push({
          id: event.nextNodeId,
          runId: projection.run.id,
          contractNodeId: targetContractNodeId,
          state: waitingHuman ? "waiting_human" : "ready",
          actor: actorForContractNode(targetContractNodeId),
          createdAt: event.acceptedAt,
          updatedAt: event.acceptedAt,
          activeAttemptId: null,
          previousNodeId: currentNode.id,
          inputArtifactIds: [...new Set(projection.run.outputArtifactIds)],
          outputArtifactIds: [],
        });
        projection.run.currentNodeId = event.nextNodeId;
        projection.run.state = waitingHuman ? "waiting_human" : "running";
        continue;
      }

      if (command.type === "run_paused") {
        projection.run.state = "paused";
        currentNode.state = "paused";
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }
      if (command.type === "run_resumed") {
        projection.run.state = "running";
        currentNode.state = "running";
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }
      if (command.type === "human_decision") {
        if (command.decision === "rejected") {
          projection.run.state = "cancelled";
          currentNode.state = "cancelled";
        } else if (event.nextNodeId) {
          if (!event.nextContractNodeId) {
            throw new Error("human override event に next contract node ID がありません");
          }
          currentNode.state = "completed";
          currentNode.updatedAt = event.acceptedAt;
          projection.nodes.push({
            id: event.nextNodeId,
            runId: projection.run.id,
            contractNodeId: event.nextContractNodeId,
            state: "ready",
            actor: actorForContractNode(event.nextContractNodeId),
            createdAt: event.acceptedAt,
            updatedAt: event.acceptedAt,
            activeAttemptId: null,
            previousNodeId: currentNode.id,
            inputArtifactIds: [...currentNode.inputArtifactIds],
            outputArtifactIds: [],
          });
          projection.run.currentNodeId = event.nextNodeId;
          projection.run.state = "running";
        } else {
          projection.run.state = "running";
          currentNode.state = "running";
        }
        currentNode.actor = event.actor;
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }
      if (command.type === "pr_observed") {
        const linkedIssue = command.linkedIssue;
        const hasExactTaskLinkage =
          linkedIssue !== null &&
          linkedIssue.owner.toLowerCase() === projection.run.task.owner.toLowerCase() &&
          linkedIssue.repo.toLowerCase() === projection.run.task.repo.toLowerCase() &&
          linkedIssue.issueNumber === projection.run.task.issueNumber;
        if (hasExactTaskLinkage && (command.state === "merged" || command.state === "closed")) {
          projection.run.state = "completed";
          currentNode.state = "completed";
          projection.run.outputArtifactIds.push(
            ...event.artifactIds.filter((id) => !projection.run.outputArtifactIds.includes(id)),
          );
        }
        currentNode.updatedAt = event.acceptedAt;
      }
    }
    return RunGraphProjectionSchema.parse(projection);
  }
}
