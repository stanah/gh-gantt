import {
  MutationProposalCommandSchema,
  MutationProposalFullViewSchema,
  MutationProposalInspectQuerySchema,
  MutationProposalReceiptSchema,
  MutationProposalViewSchema,
  mutationCommandFingerprint,
  type Config,
  type MutationActor,
  type MutationOrigin,
  type MutationPolicyRule,
  type MutationPrimitiveStep,
  type MutationProposal,
  type MutationProposalCommand,
  type MutationProposalFullView,
  type MutationProposalInspectQuery,
  type MutationProposalReceipt,
  type MutationSuccessorPlanRevision,
  type MutationProposalView,
  type Task,
} from "@gh-gantt/shared";
import { randomUUID } from "node:crypto";
import type {
  MutationApplicationClaimInput,
  MutationApplicationLease,
  MutationApplicationLeaseResult,
  MutationProposalRecordOptions,
  MutationProposalRecordResult,
  MutationProposalRegistry,
} from "../store/mutation-proposals.js";
import type {
  MutationReservationProof,
  MutationReservationResult,
} from "../store/dispatch-claims.js";
import type {
  GitHubApprovalCommentRef,
  HumanApprovalVerification,
  MutationBoundDecision,
} from "./human-approval-authority.js";
import { renderMutationApprovalMachineBlock } from "./human-approval-authority.js";
import { WorkGraphCommandEngine } from "./command-engine.js";

const INTERNAL_MUTATION_ORCHESTRATOR: MutationActor = {
  id: "gh-gantt:mutation-control-plane",
  role: "orchestrator",
};

export interface MutationProposalRepository {
  readAll(): Promise<MutationProposalRegistry>;
  recordReceipt(
    proposal: MutationProposal,
    receipt: MutationProposalReceipt,
    options?: MutationProposalRecordOptions,
  ): Promise<MutationProposalRecordResult | void>;
  acknowledgeAudit(
    proposalId: string,
    eventId: string,
    expectedProposalRevision: number,
  ): Promise<boolean>;
  claimApplication(input: MutationApplicationClaimInput): Promise<MutationApplicationLeaseResult>;
  fenceApplication(input: {
    lease: MutationApplicationLease;
    stepId: string;
    leaseDurationSeconds: number;
  }): Promise<MutationApplicationLeaseResult>;
  releaseApplication(lease: MutationApplicationLease): Promise<boolean>;
}

export interface MutationSnapshot {
  config: Config;
  tasks: Task[];
  sourceRevision: string;
  snapshotFingerprint: string;
  syncConflicts: boolean;
}

export type MutationOriginResolution =
  | { ok: true; origin: MutationOrigin; coverageFingerprint?: string }
  | { ok: false; code: "origin_binding_drift" | "run_state_unknown"; diagnostic: string };

export type MutationApplyValidation =
  | {
      ok: true;
      coverageFingerprint: string;
      claimEntityVersion?: number;
      affectedRuns?: Array<{
        workspaceId: string;
        projectRoot: string;
        runId: string;
        taskId: string;
        planId: string;
        planVersion: string;
        schemaVersion: string;
        currentNodeId: string;
        successorPlanRevision: MutationSuccessorPlanRevision;
      }>;
    }
  | {
      ok: false;
      code:
        | "origin_binding_drift"
        | "active_claim"
        | "unfinished_run"
        | "run_state_unknown"
        | "review_gate"
        | "sync_conflict"
        | "active_attempt_conflict";
      diagnostic: string;
    };

export interface MutationStepOutcome {
  state: "committed" | "unknown" | "reconciled";
  diagnostic: string | null;
  resolvedTaskId?: string;
  remoteIdentifiers?: MutationPrimitiveStep["remoteIdentifiers"];
  localPreparation?: MutationPrimitiveStep["localPreparation"];
}

export type MutationStepPreparation =
  | { ok: true; preparation: NonNullable<MutationPrimitiveStep["localPreparation"]> }
  | {
      ok: false;
      code: "source_drift" | "invalid_projection";
      diagnostic: string;
    };

export interface MutationStepReconciliation {
  state: "reconciled" | "not_started" | "unknown";
  diagnostic: string | null;
  resolvedTaskId?: string;
  remoteIdentifiers?: MutationPrimitiveStep["remoteIdentifiers"];
}

/** remote照合とlocal publishを同一ownerへ拘束する二重fence。 */
export interface MutationFenceContext {
  applicationLease: MutationApplicationLease;
  mutationReservation: MutationReservationProof;
}

/** mutation reservationの全遷移を不可分なcapabilityとして提供する。 */
export interface MutationCoordinationCapability {
  reserveMutation(
    proposal: MutationProposal,
    expectedEntityVersion: number,
    ownerNonce: string,
  ): Promise<MutationReservationResult>;
  beginMutationSideEffect(proof: MutationReservationProof): Promise<MutationReservationProof>;
  completeMutationSideEffect(proof: MutationReservationProof): Promise<MutationReservationProof>;
  releaseMutationReservation(proof: MutationReservationProof): Promise<boolean>;
  withMutationReservation<T>(
    proof: MutationReservationProof,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface MutationProposalAuditEvent {
  eventId: string;
  type:
    | "proposal_created"
    | "proposal_approved"
    | "proposal_rejected"
    | "proposal_expired"
    | "proposal_superseded"
    | "proposal_apply_step"
    | "proposal_applied"
    | "proposal_reconciled"
    | "proposal_compensated"
    | "work_graph_invalidated";
  proposalId: string;
  proposalRevision: number;
  originRunId: string;
  actorId: string;
  actorRole: MutationActor["role"];
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface MutationProposalEnvironment {
  loadSnapshot(): Promise<MutationSnapshot>;
  resolveOrigin(runId: string): Promise<MutationOriginResolution>;
  validateApply(proposal: MutationProposal): Promise<MutationApplyValidation>;
  validateAdvancedBaseline?(
    proposal: MutationProposal,
    snapshot: MutationSnapshot,
  ): Promise<boolean>;
  verifyHumanApproval(
    boundDecision: MutationBoundDecision,
    commentRef: GitHubApprovalCommentRef,
  ): Promise<HumanApprovalVerification>;
  prepareStep?(
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
    fence: MutationFenceContext,
  ): Promise<MutationStepPreparation>;
  executeStep(
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
    fence: MutationFenceContext,
    recordRemoteOutcome?: (outcome: MutationStepOutcome) => Promise<void>,
  ): Promise<MutationStepOutcome>;
  reconcileStep?(
    step: MutationPrimitiveStep,
    proposal: MutationProposal,
    fence: MutationFenceContext,
  ): Promise<MutationStepReconciliation>;
  acceptReplan?(
    proposal: MutationProposal,
    approval: Extract<HumanApprovalVerification, { ok: true }>["receipt"],
    successorPlanRevision: MutationSuccessorPlanRevision,
    successorNodeId: string,
    target: MutationProposal["invalidationTargets"][number],
  ): Promise<{ ok: true } | { ok: false; code: string; diagnostic: string }>;
  appendAudit(event: MutationProposalAuditEvent): Promise<void>;
  mutationCoordination: MutationCoordinationCapability;
}

export interface MutationProposalControlPlaneDependencies {
  now?: () => string;
  nextId?: () => string;
  /** テスト専用: proposal preparationをCAS永続化した直後のプロセス境界を模擬する。 */
  afterPreparationPersisted?: () => Promise<void>;
  /** テスト専用: リモート副作用intentをCAS永続化した直後のプロセス境界を模擬する。 */
  afterRemoteIntentPersisted?: () => Promise<void>;
  /** テスト専用: reconcile lifecycleをCAS永続化した直後のプロセス境界を模擬する。 */
  afterReconcilePhasePersisted?: () => Promise<void>;
  /** テスト専用: reconcile reservationを取得した直後のプロセス境界を模擬する。 */
  afterReconcileReservationPersisted?: () => Promise<void>;
  /** テスト専用: reconcile live観測後かつstep CAS前のプロセス境界を模擬する。 */
  afterReconciliationObserved?: () => Promise<void>;
  /** テスト専用: reconcileのライブ観測をCAS永続化した直後のプロセス境界を模擬する。 */
  afterReconciliationPersisted?: () => Promise<void>;
}

const riskRank = { low: 0, medium: 1, high: 2, destructive: 3 } as const;

function policyRuleMatches(
  proposal: Pick<
    MutationProposal,
    | "intent"
    | "origin"
    | "steps"
    | "targetTaskIds"
    | "affectedUpstream"
    | "affectedDownstream"
    | "risk"
  >,
  rule: MutationPolicyRule,
  tasks: Task[],
): boolean {
  if (proposal.risk === "destructive") return false;
  if (!rule.mutation_kinds.includes(proposal.intent.kind as never)) return false;
  if (!rule.repositories.includes(proposal.origin.repository)) return false;
  if (!rule.root_task_ids.includes(proposal.origin.taskId)) return false;
  if (proposal.steps.length > rule.max_operations) return false;
  if (
    new Set([
      ...proposal.targetTaskIds,
      ...proposal.affectedUpstream,
      ...proposal.affectedDownstream,
    ]).size > rule.max_affected_tasks
  )
    return false;
  if (riskRank[proposal.risk] > riskRank[rule.max_risk]) return false;
  const affectedTypes = proposal.targetTaskIds.flatMap((id) => {
    const existing = tasks.find((task) => task.id === id);
    if (existing) return [existing.type];
    if (
      proposal.intent.kind === "add" &&
      id.endsWith(`#draft-mutation-${proposal.intent.task.clientId}`)
    ) {
      return [proposal.intent.task.type];
    }
    if (proposal.intent.kind === "split") {
      const child = proposal.intent.children.find((item) =>
        id.endsWith(`#draft-mutation-${item.clientId}`),
      );
      return child ? [child.type] : [];
    }
    return [];
  });
  return affectedTypes.length > 0 && affectedTypes.every((type) => rule.task_types.includes(type));
}

function summary(proposal: MutationProposal) {
  return {
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    status: proposal.status,
    mutationKind: proposal.intent.kind,
    targetTaskIds: proposal.targetTaskIds,
    risk: proposal.risk,
    proposedBy: proposal.proposedBy,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
  };
}

function approvalBinding(
  proposal: MutationProposal,
  purpose: MutationBoundDecision["purpose"],
  options: {
    stepId?: string;
    targetRunId?: string;
    targetProjectRoot?: string;
    successorPlanRevision?: MutationSuccessorPlanRevision;
  } = {},
): MutationBoundDecision {
  return {
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    proposalFingerprint: proposal.planFingerprint,
    expiresAt: proposal.expiresAt,
    purpose,
    stepId: options.stepId ?? null,
    targetRunId: options.targetRunId ?? null,
    targetProjectRoot: options.targetProjectRoot ?? null,
    successorDescriptorFingerprint: options.successorPlanRevision
      ? mutationCommandFingerprint(options.successorPlanRevision)
      : null,
  };
}

function storedApprovalBinding(proposal: MutationProposal): MutationBoundDecision | null {
  const trusted = proposal.trustedApproval;
  if (!trusted) return null;
  return {
    proposalId: proposal.proposalId,
    revision: trusted.boundRevision,
    proposalFingerprint: trusted.boundProposalFingerprint,
    expiresAt: trusted.boundExpiresAt,
    purpose: trusted.boundPurpose,
    stepId: trusted.boundStepId,
    targetRunId: trusted.boundTargetRunId,
    targetProjectRoot: trusted.boundTargetProjectRoot,
    successorDescriptorFingerprint: trusted.boundSuccessorDescriptorFingerprint,
  };
}

function storedTrustedApproval(
  trusted: Extract<HumanApprovalVerification, { ok: true }>["receipt"],
): NonNullable<MutationProposal["trustedApproval"]> {
  return {
    decision: trusted.decision,
    boundRevision: trusted.boundDecision.revision,
    boundProposalFingerprint: trusted.boundDecision.proposalFingerprint,
    boundExpiresAt: trusted.boundDecision.expiresAt,
    boundPurpose: trusted.boundDecision.purpose,
    boundStepId: trusted.boundDecision.stepId,
    boundTargetRunId: trusted.boundDecision.targetRunId,
    boundTargetProjectRoot: trusted.boundDecision.targetProjectRoot,
    boundSuccessorDescriptorFingerprint: trusted.boundDecision.successorDescriptorFingerprint,
    authorNodeId: trusted.actor.id,
    commentId: trusted.commentId,
    bodyHash: trusted.bodyHash,
    commentUpdatedAt: trusted.commentUpdatedAt,
    authorityConfigFingerprint: trusted.authorityConfigFingerprint,
  };
}

/** propose/decide/apply/reconcile lifecycleをexecute + inspectの2入口へ閉じ込める。 */
export class MutationProposalControlPlane {
  private readonly now: () => string;
  private readonly nextId: () => string;
  private readonly afterPreparationPersisted?: () => Promise<void>;
  private readonly afterRemoteIntentPersisted?: () => Promise<void>;
  private readonly afterReconcilePhasePersisted?: () => Promise<void>;
  private readonly afterReconcileReservationPersisted?: () => Promise<void>;
  private readonly afterReconciliationObserved?: () => Promise<void>;
  private readonly afterReconciliationPersisted?: () => Promise<void>;

  constructor(
    private readonly repository: MutationProposalRepository,
    private readonly engine: WorkGraphCommandEngine,
    private readonly environment: MutationProposalEnvironment,
    dependencies: MutationProposalControlPlaneDependencies = {},
  ) {
    for (const method of [
      "reserveMutation",
      "beginMutationSideEffect",
      "completeMutationSideEffect",
      "releaseMutationReservation",
      "withMutationReservation",
    ] as const) {
      if (typeof environment.mutationCoordination?.[method] !== "function") {
        throw new Error(`mutation coordination capabilityが不完全です: ${method}`);
      }
    }
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.nextId = dependencies.nextId ?? (() => `proposal-${randomUUID()}`);
    this.afterPreparationPersisted = dependencies.afterPreparationPersisted;
    this.afterRemoteIntentPersisted = dependencies.afterRemoteIntentPersisted;
    this.afterReconcilePhasePersisted = dependencies.afterReconcilePhasePersisted;
    this.afterReconcileReservationPersisted = dependencies.afterReconcileReservationPersisted;
    this.afterReconciliationObserved = dependencies.afterReconciliationObserved;
    this.afterReconciliationPersisted = dependencies.afterReconciliationPersisted;
  }

  async execute(rawCommand: unknown): Promise<MutationProposalReceipt> {
    const parsed = MutationProposalCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      const fallback = rawCommand as { commandId?: string };
      return this.rejection(
        fallback.commandId ?? "invalid-command",
        mutationCommandFingerprint(rawCommand),
        null,
        0,
        "invalid_command",
        parsed.error.issues[0]?.message ?? "invalid command",
      );
    }
    const command = parsed.data;
    const fingerprint = mutationCommandFingerprint(command);
    const registry = await this.repository.readAll();
    const prior = registry.commandReceipts.find((item) => item.commandId === command.commandId);
    if (prior && prior.commandFingerprint !== fingerprint) {
      const proposal =
        command.type === "propose"
          ? null
          : (registry.proposals.find((item) => item.proposalId === command.proposalId) ?? null);
      return this.rejection(
        command.commandId,
        fingerprint,
        proposal,
        proposal?.revision ?? 0,
        "command_payload_mismatch",
        "同じcommandIdに異なるpayloadは使用できません",
      );
    }
    const resumeReservedApply = prior?.receipt.status === "applying" && command.type === "apply";
    const resumePendingAudit =
      prior?.receipt.status === "pending_audit" && command.type === "apply";
    const resumeReservedReplan =
      prior?.receipt.status === "accepting_replan" && command.type === "accept_replan";
    const resumeReservedCompensation =
      prior?.receipt.status === "compensating" &&
      command.type === "reconcile" &&
      command.resolution === "reopen_cancelled_task";
    const resumeReservedReconcile =
      prior?.receipt.status === "reconciling" &&
      command.type === "reconcile" &&
      command.resolution !== "reopen_cancelled_task";
    if (
      prior &&
      !resumeReservedApply &&
      !resumePendingAudit &&
      !resumeReservedReplan &&
      !resumeReservedReconcile &&
      !resumeReservedCompensation
    ) {
      const proposal =
        prior.receipt.proposalId === null
          ? undefined
          : registry.proposals.find((item) => item.proposalId === prior.receipt.proposalId);
      if (proposal?.pendingAudits.length) {
        await this.drainPendingAudits(proposal).catch(() => undefined);
      }
      return prior.receipt;
    }
    if (resumePendingAudit && command.type === "apply") {
      const proposal = registry.proposals.find((item) => item.proposalId === command.proposalId);
      if (!proposal || proposal.status !== "pending_audit") return prior!.receipt;
      return this.finalizePendingAudit(command, fingerprint, proposal);
    }

    switch (command.type) {
      case "propose":
        return this.propose(command, fingerprint);
      case "decide":
        return this.decide(command, fingerprint, registry);
      case "apply":
        return this.apply(command, fingerprint, registry, resumeReservedApply);
      case "reconcile":
        return this.reconcile(
          command,
          fingerprint,
          registry,
          resumeReservedCompensation,
          resumeReservedReconcile,
        );
      case "expire":
        return this.expire(command, fingerprint, registry);
      case "supersede":
        return this.supersede(command, fingerprint, registry);
      case "accept_replan":
        return this.acceptReplan(command, fingerprint, registry, resumeReservedReplan);
    }
  }

  async inspect(
    rawQuery: MutationProposalInspectQuery,
  ): Promise<MutationProposalView | MutationProposalFullView> {
    const query = MutationProposalInspectQuerySchema.parse(rawQuery);
    const registry = await this.repository.readAll();
    const selected = query.proposalId
      ? registry.proposals.filter((proposal) => proposal.proposalId === query.proposalId)
      : [...registry.proposals].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        );
    const items = selected.slice(query.offset, query.offset + query.limit);
    if (query.full) {
      return MutationProposalFullViewSchema.parse({
        schemaVersion: "1",
        total: selected.length,
        limit: query.limit,
        offset: query.offset,
        truncated: query.offset + items.length < selected.length,
        items,
        approvalRequests: items.flatMap((proposal) => this.approvalRequests(proposal)),
      });
    }
    return MutationProposalViewSchema.parse({
      schemaVersion: "1",
      total: selected.length,
      limit: query.limit,
      truncated: selected.length > items.length,
      items: items.map(summary),
    });
  }

  private async propose(
    command: Extract<MutationProposalCommand, { type: "propose" }>,
    fingerprint: string,
  ): Promise<MutationProposalReceipt> {
    const snapshot = await this.environment.loadSnapshot();
    if (snapshot.syncConflicts) {
      return this.rejection(
        command.commandId,
        fingerprint,
        null,
        0,
        "sync_conflict",
        "未解決sync conflictがあります",
      );
    }
    const origin = await this.environment.resolveOrigin(command.originRunId);
    if (!origin.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        null,
        0,
        origin.code,
        origin.diagnostic,
      );
    }
    const plan = this.engine.executeCommand({
      type: "proposal_intent",
      tasks: snapshot.tasks,
      intent: command.intent,
      scopeRootTaskId: origin.origin.taskId,
    });
    if (!plan.ok) {
      return this.rejection(command.commandId, fingerprint, null, 0, plan.code, plan.error);
    }
    if (!("steps" in plan)) throw new Error("proposal planning resultが不正です");
    const now = this.now();
    const proposalId = this.nextId();
    const policyFingerprint = snapshot.config.mutation_policy
      ? mutationCommandFingerprint(snapshot.config.mutation_policy)
      : null;
    const draft = {
      intent: command.intent,
      origin: origin.origin,
      steps: plan.steps,
      targetTaskIds: plan.targetTaskIds,
      affectedUpstream: plan.affectedUpstream,
      affectedDownstream: plan.affectedDownstream,
      risk: plan.risk,
    };
    const matchedRule = snapshot.config.mutation_policy?.rules.find((rule) =>
      policyRuleMatches(draft, rule, snapshot.tasks),
    );
    const approval = matchedRule
      ? {
          kind: "policy" as const,
          policyId: snapshot.config.mutation_policy!.policy_id,
          policyVersion: snapshot.config.mutation_policy!.version,
          ruleId: matchedRule.id,
          evidenceId: `policy:${snapshot.config.mutation_policy!.policy_id}:${matchedRule.id}`,
          decidedAt: now,
        }
      : null;
    const planFingerprint = mutationCommandFingerprint({
      sourceRevision: snapshot.sourceRevision,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      coverageFingerprint: origin.coverageFingerprint ?? mutationCommandFingerprint(origin.origin),
      ...draft,
      diff: plan.diff,
      upstream: plan.affectedUpstream,
      downstream: plan.affectedDownstream,
    });
    for (const step of plan.steps) {
      if (step.operation === "create") {
        step.correlationToken = `mutation:${proposalId}:${planFingerprint}:${step.stepId}`;
      }
    }
    const proposal: MutationProposal = {
      schemaVersion: "1",
      proposalId,
      revision: 1,
      status: approval ? "approved" : "awaiting_human",
      commandId: command.commandId,
      commandFingerprint: fingerprint,
      sourceRevision: snapshot.sourceRevision,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      proposeCoverageFingerprint:
        origin.coverageFingerprint ?? mutationCommandFingerprint(origin.origin),
      planFingerprint,
      policyFingerprint,
      origin: origin.origin,
      intent: command.intent,
      targetTaskIds: plan.targetTaskIds,
      evidence: command.evidence,
      diff: plan.diff,
      affectedUpstream: plan.affectedUpstream,
      affectedDownstream: plan.affectedDownstream,
      risk: plan.risk,
      proposedBy: command.actor,
      approval,
      approvalCommentRef: null,
      trustedApproval: null,
      steps: plan.steps,
      logicalTaskIds: {},
      successorProposalId: null,
      applyCoverageFingerprint: null,
      applyBaseline: null,
      invalidationTargets: [],
      pendingAuditEventIds: [],
      pendingAudits: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: command.expiresAt,
    };
    const machineBlock = renderMutationApprovalMachineBlock({
      ...approvalBinding(proposal, "decision"),
      decision: "approve",
    });
    const receipt = this.accepted(command.commandId, fingerprint, proposal, {
      approvalRequest: approval
        ? null
        : {
            issueUrl: `https://github.com/${proposal.origin.repository}/issues/${proposal.origin.taskId.split("#").at(-1)}`,
            machineBlock,
          },
    });
    this.enqueueAudit(proposal, "proposal_created", command.actor, {
      policyApproved: Boolean(approval),
    });
    const conflict = await this.persist(proposal, receipt, { expectedProposalRevision: null });
    if (conflict) return conflict;
    await this.drainPendingAudits(proposal).catch(() => undefined);
    return receipt;
  }

  private async decide(
    command: Extract<MutationProposalCommand, { type: "decide" }>,
    fingerprint: string,
    registry: MutationProposalRegistry,
  ): Promise<MutationProposalReceipt> {
    const proposal = registry.proposals.find((item) => item.proposalId === command.proposalId);
    const gate = this.mutableProposal(command, fingerprint, proposal, ["awaiting_human"]);
    if (gate) return gate;
    const current = proposal!;
    const verification = await this.environment.verifyHumanApproval(
      approvalBinding(current, "decision"),
      command.approvalCommentRef,
    );
    if (!verification.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        verification.code,
        verification.diagnostic,
      );
    }
    const trusted = verification.receipt;
    current.revision += 1;
    current.updatedAt = this.now();
    current.status = trusted.decision === "approve" ? "approved" : "rejected";
    current.approvalCommentRef = { ...command.approvalCommentRef };
    current.trustedApproval = storedTrustedApproval(trusted);
    current.approval = {
      kind: "human",
      actor: trusted.actor,
      evidenceId: `github-comment:${trusted.commentId}:${trusted.bodyHash}`,
      decidedAt: trusted.verifiedAt,
    };
    const receipt = this.accepted(command.commandId, fingerprint, current);
    this.enqueueAudit(
      current,
      trusted.decision === "approve" ? "proposal_approved" : "proposal_rejected",
      trusted.actor,
      { commentId: trusted.commentId, bodyHash: trusted.bodyHash },
    );
    const conflict = await this.persist(current, receipt, {
      expectedProposalRevision: command.expectedRevision,
      allowedStatuses: ["awaiting_human"],
    });
    if (conflict) return conflict;
    await this.drainPendingAudits(current).catch(() => undefined);
    return receipt;
  }

  private async apply(
    command: Extract<MutationProposalCommand, { type: "apply" }>,
    fingerprint: string,
    registry: MutationProposalRegistry,
    resumeReservedApply = false,
  ): Promise<MutationProposalReceipt> {
    const proposal = registry.proposals.find((item) => item.proposalId === command.proposalId);
    const gate = resumeReservedApply
      ? proposal?.status === "applying"
        ? null
        : this.rejection(
            command.commandId,
            fingerprint,
            proposal ?? null,
            proposal?.revision ?? 0,
            "invalid_lifecycle",
            "予約済みapplyのproposal stateが一致しません",
          )
      : this.mutableProposal(command, fingerprint, proposal, ["approved"]);
    if (gate) return gate;
    const current = proposal!;
    if (command.actor.role !== "orchestrator") {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        "applyはRun invalidation authorityを持つorchestratorだけが実行できます",
      );
    }
    let coverageFingerprint = "reserved-apply";
    let reservationReceipt = this.accepted(command.commandId, fingerprint, current);
    const snapshot = await this.environment.loadSnapshot();
    if (snapshot.syncConflicts) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "sync_conflict",
        "未解決sync conflictがあります",
      );
    }
    const baseline = current.applyBaseline ?? {
      sourceRevision: current.sourceRevision,
      snapshotFingerprint: current.snapshotFingerprint,
      afterStepId: "proposal",
    };
    if (
      (snapshot.sourceRevision !== baseline.sourceRevision ||
        snapshot.snapshotFingerprint !== baseline.snapshotFingerprint) &&
      !(await this.environment.validateAdvancedBaseline?.(current, snapshot))
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "source_drift",
        "Work Graph source revisionまたはreserved step postconditionが変化しました",
      );
    }
    const policyFingerprint = snapshot.config.mutation_policy
      ? mutationCommandFingerprint(snapshot.config.mutation_policy)
      : null;
    if (policyFingerprint !== current.policyFingerprint) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "policy_drift",
        "mutation policy revisionが変化しました",
      );
    }
    if (current.approval?.kind === "human") {
      if (!current.approvalCommentRef || !current.trustedApproval) {
        return this.rejection(
          command.commandId,
          fingerprint,
          current,
          current.revision,
          "human_gate_required",
          "trusted approval receiptがありません",
        );
      }
      const verified = await this.environment.verifyHumanApproval(
        storedApprovalBinding(current)!,
        current.approvalCommentRef,
      );
      if (
        !verified.ok ||
        verified.receipt.bodyHash !== current.trustedApproval.bodyHash ||
        verified.receipt.boundDecision.revision !== current.trustedApproval.boundRevision ||
        verified.receipt.boundDecision.proposalFingerprint !==
          current.trustedApproval.boundProposalFingerprint ||
        verified.receipt.boundDecision.expiresAt !== current.trustedApproval.boundExpiresAt ||
        verified.receipt.authorityConfigFingerprint !==
          current.trustedApproval.authorityConfigFingerprint ||
        verified.receipt.actor.id !== current.trustedApproval.authorNodeId
      ) {
        return this.rejection(
          command.commandId,
          fingerprint,
          current,
          current.revision,
          "human_gate_required",
          "approval comment/configがdecide後に変化しました",
        );
      }
    }
    const validation = await this.environment.validateApply(current);
    if (!validation.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        validation.code,
        validation.diagnostic,
      );
    }
    coverageFingerprint = validation.coverageFingerprint;
    current.applyCoverageFingerprint = coverageFingerprint;
    current.invalidationTargets = validation.affectedRuns ?? [];
    if (!resumeReservedApply) {
      current.status = "applying";
      current.revision += 1;
      current.updatedAt = this.now();
      reservationReceipt = this.accepted(command.commandId, fingerprint, current);
      const conflict = await this.persist(current, reservationReceipt, {
        expectedProposalRevision: command.expectedRevision,
        allowedStatuses: ["approved"],
      });
      if (conflict) return conflict;
    }

    const ownerNonce = randomUUID();
    const applicationClaim = await this.repository.claimApplication({
      proposalId: current.proposalId,
      commandId: command.commandId,
      commandFingerprint: fingerprint,
      ownerNonce,
      leaseDurationSeconds: 60,
    });
    if (!applicationClaim.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "active_claim",
        "同じproposalのremote applyは別processが実行中です",
      );
    }
    let applicationLease = applicationClaim.lease;
    let mutationReservation: MutationReservationProof | undefined;
    const reservation = await this.environment.mutationCoordination.reserveMutation(
      current,
      validation.claimEntityVersion ?? 0,
      ownerNonce,
    );
    if (!reservation.accepted) {
      await this.repository.releaseApplication(applicationLease).catch(() => false);
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        reservation.code,
        reservation.message,
      );
    }
    mutationReservation = reservation.reservation;

    try {
      for (const step of current.steps) {
        if (step.state === "committed" || step.state === "reconciled") continue;
        if (step.state === "unknown") {
          current.status = "partially_applied";
          current.revision += 1;
          current.updatedAt = this.now();
          this.enqueueAudit(current, "proposal_apply_step", command.actor, {
            stepId: step.stepId,
            state: step.state,
          });
          const partial = this.rejection(
            command.commandId,
            fingerprint,
            current,
            current.revision,
            "side_effect_unknown",
            step.diagnostic ?? "side effect stateがunknownです",
            false,
          );
          const persisted = await this.persistFenced(
            current,
            partial,
            {
              expectedProposalRevision: current.revision - 1,
              allowedStatuses: ["applying"],
            },
            { applicationLease, mutationReservation },
          );
          if (persisted) return persisted;
          await this.drainPendingAudits(current).catch(() => undefined);
          return partial;
        }
        if (!step.localPreparation && this.environment.prepareStep) {
          const preparation = await this.environment.prepareStep(step, current, {
            applicationLease,
            mutationReservation,
          });
          if (!preparation.ok) {
            return this.rejection(
              command.commandId,
              fingerprint,
              current,
              current.revision,
              preparation.code,
              preparation.diagnostic,
            );
          }
          step.localPreparation = preparation.preparation;
          current.revision += 1;
          current.updatedAt = this.now();
          const persisted = await this.persistFenced(
            current,
            this.accepted(command.commandId, fingerprint, current),
            {
              expectedProposalRevision: current.revision - 1,
              allowedStatuses: ["applying"],
            },
            { applicationLease, mutationReservation },
          );
          if (persisted) return persisted;
          await this.afterPreparationPersisted?.();
        }
        let outcome: MutationStepOutcome;
        if (step.remoteExecution?.state === "side_effect_in_flight") {
          const reconciled = this.environment.reconcileStep
            ? await this.environment.reconcileStep(step, current, {
                applicationLease,
                mutationReservation,
              })
            : {
                state: "unknown" as const,
                diagnostic: "in-flight takeoverにはreconcile adapterが必要です",
              };
          if (reconciled.state === "not_started") {
            outcome = {
              state: "unknown",
              diagnostic:
                "expired in-flight ownerのtakeoverはreconcile-onlyです。明示的な再試行が必要です",
            };
          } else {
            outcome = {
              state: reconciled.state,
              diagnostic: reconciled.diagnostic,
              resolvedTaskId: reconciled.resolvedTaskId,
              remoteIdentifiers: reconciled.remoteIdentifiers,
            };
          }
        } else {
          let preparationBoundaryCrash = false;
          try {
            const fenced = await this.repository.fenceApplication({
              lease: applicationLease,
              stepId: step.stepId,
              leaseDurationSeconds: 60,
            });
            if (!fenced.ok) throw new Error("application_fence_lost");
            applicationLease = fenced.lease;
            step.remoteExecution = {
              state: "side_effect_in_flight",
              ownerNonce: applicationLease.ownerNonce,
              fencingToken: applicationLease.fencingToken,
              startedAt: this.now(),
            };
            current.revision += 1;
            current.updatedAt = this.now();
            const intentPersisted = await this.persistFenced(
              current,
              this.accepted(command.commandId, fingerprint, current),
              {
                expectedProposalRevision: current.revision - 1,
                allowedStatuses: ["applying"],
              },
              { applicationLease, mutationReservation },
            );
            if (intentPersisted) return intentPersisted;
            preparationBoundaryCrash = true;
            await this.afterRemoteIntentPersisted?.();
            preparationBoundaryCrash = false;
            if (mutationReservation) {
              mutationReservation =
                await this.environment.mutationCoordination.beginMutationSideEffect(
                  mutationReservation,
                );
            }
            outcome = await this.environment.executeStep(
              step,
              current,
              { applicationLease, mutationReservation },
              async (remoteOutcome) => {
                step.state = remoteOutcome.state;
                step.diagnostic = remoteOutcome.diagnostic;
                step.remoteIdentifiers = remoteOutcome.remoteIdentifiers ?? null;
                if (remoteOutcome.localPreparation)
                  step.localPreparation = remoteOutcome.localPreparation;
                if (remoteOutcome.resolvedTaskId) {
                  current.logicalTaskIds[step.targetTaskId] = remoteOutcome.resolvedTaskId;
                }
                current.revision += 1;
                current.updatedAt = this.now();
                const persisted = await this.persistFenced(
                  current,
                  this.accepted(command.commandId, fingerprint, current),
                  {
                    expectedProposalRevision: current.revision - 1,
                    allowedStatuses: ["applying"],
                  },
                  { applicationLease, mutationReservation: mutationReservation! },
                );
                if (persisted)
                  throw new Error(persisted.diagnostic ?? persisted.errorCode ?? "CAS失敗");
              },
            );
          } catch (error) {
            if (preparationBoundaryCrash) throw error;
            outcome = {
              state: "unknown",
              diagnostic: error instanceof Error ? error.message : String(error),
              remoteIdentifiers: step.remoteIdentifiers ?? null,
            };
          }
        }
        step.state = outcome.state;
        step.diagnostic = outcome.diagnostic;
        step.remoteIdentifiers = outcome.remoteIdentifiers ?? null;
        if (outcome.localPreparation) step.localPreparation = outcome.localPreparation;
        if (outcome.resolvedTaskId)
          current.logicalTaskIds[step.targetTaskId] = outcome.resolvedTaskId;
        if (outcome.state === "committed" || outcome.state === "reconciled") {
          step.remoteExecution = null;
          const advanced = await this.environment.loadSnapshot();
          current.applyBaseline = {
            sourceRevision: advanced.sourceRevision,
            snapshotFingerprint: advanced.snapshotFingerprint,
            afterStepId: step.stepId,
          };
        }
        current.revision += 1;
        current.updatedAt = this.now();
        this.enqueueAudit(current, "proposal_apply_step", command.actor, {
          stepId: step.stepId,
          state: step.state,
        });
        if (step.state === "unknown") {
          current.status = "partially_applied";
          const partial = this.rejection(
            command.commandId,
            fingerprint,
            current,
            current.revision,
            "side_effect_unknown",
            step.diagnostic ?? "side effect stateがunknownです",
            false,
          );
          const persisted = await this.persistFenced(
            current,
            partial,
            {
              expectedProposalRevision: current.revision - 1,
              allowedStatuses: ["applying"],
            },
            { applicationLease, mutationReservation },
          );
          if (persisted) return persisted;
          await this.drainPendingAudits(current).catch(() => undefined);
          return partial;
        }
        reservationReceipt = this.accepted(command.commandId, fingerprint, current);
        const persisted = await this.persistFenced(
          current,
          reservationReceipt,
          {
            expectedProposalRevision: current.revision - 1,
            allowedStatuses: ["applying"],
          },
          { applicationLease, mutationReservation },
        );
        if (persisted) return persisted;
        if (mutationReservation?.sideEffectState === "in_flight") {
          mutationReservation =
            await this.environment.mutationCoordination.completeMutationSideEffect(
              mutationReservation,
            );
        }
        await this.drainPendingAudits(current).catch(() => undefined);
      }

      if (mutationReservation?.sideEffectState === "in_flight") {
        mutationReservation =
          await this.environment.mutationCoordination.completeMutationSideEffect(
            mutationReservation,
          );
      }
      if (mutationReservation) {
        const released =
          await this.environment.mutationCoordination.releaseMutationReservation(
            mutationReservation,
          );
        if (!released) throw new Error("mutation reservationを解除できません");
        mutationReservation = undefined;
      }

      current.status = "pending_audit";
      current.revision += 1;
      current.updatedAt = this.now();
      this.enqueueAudit(
        current,
        "work_graph_invalidated",
        command.actor,
        this.invalidationDetail(current, coverageFingerprint),
      );
      this.enqueueAudit(current, "proposal_applied", command.actor, {});
      const pendingReceipt = this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "audit_pending",
        "Run Graph auditを完了していません",
        false,
      );
      const pendingConflict = await this.persist(current, pendingReceipt, {
        expectedProposalRevision: current.revision - 1,
        allowedStatuses: ["applying"],
      });
      if (pendingConflict) return pendingConflict;
      try {
        await this.drainPendingAudits(current);
      } catch (error) {
        const failed = this.rejection(
          command.commandId,
          fingerprint,
          current,
          current.revision,
          "audit_pending",
          error instanceof Error ? error.message : String(error),
          false,
        );
        return failed;
      }
      current.status = "applied";
      current.revision += 1;
      current.updatedAt = this.now();
      const receipt = this.accepted(command.commandId, fingerprint, current, {
        changedTaskIds: current.targetTaskIds,
        successorPlanRevision: {
          planId: current.origin.planId,
          fromVersion: current.origin.planVersion,
          proposedVersion: `${current.origin.planVersion}+proposal.${current.proposalId}`,
          reasonProposalId: current.proposalId,
        },
      });
      const conflict = await this.persist(current, receipt, {
        expectedProposalRevision: current.revision - 1,
        allowedStatuses: ["pending_audit"],
      });
      if (conflict) return conflict;
      return receipt;
    } finally {
      if (mutationReservation) {
        await this.environment.mutationCoordination
          .releaseMutationReservation(mutationReservation)
          .catch(() => false);
      }
      await this.repository.releaseApplication(applicationLease).catch(() => false);
    }
  }

  private async reconcile(
    command: Extract<MutationProposalCommand, { type: "reconcile" }>,
    fingerprint: string,
    registry: MutationProposalRegistry,
    resumeReservedCompensation = false,
    resumeReservedReconcile = false,
  ): Promise<MutationProposalReceipt> {
    const proposal = registry.proposals.find((item) => item.proposalId === command.proposalId);
    const isCompensation = command.resolution === "reopen_cancelled_task";
    const gate = resumeReservedCompensation
      ? proposal?.status === "compensating"
        ? null
        : this.rejection(
            command.commandId,
            fingerprint,
            proposal ?? null,
            proposal?.revision ?? 0,
            "invalid_lifecycle",
            "予約済みcompensationのproposal stateが一致しません",
          )
      : resumeReservedReconcile
        ? proposal?.status === "reconciling"
          ? null
          : this.rejection(
              command.commandId,
              fingerprint,
              proposal ?? null,
              proposal?.revision ?? 0,
              "invalid_lifecycle",
              "予約済みreconcileのproposal stateが一致しません",
            )
        : this.mutableProposal(
            command,
            fingerprint,
            proposal,
            isCompensation
              ? ["partially_applied", "applied"]
              : ["partially_applied", "pending_audit"],
          );
    if (gate) return gate;
    const current = proposal!;
    if (isCompensation) {
      return this.compensateCancel(command, fingerprint, current, resumeReservedCompensation);
    }
    const step = command.stepId
      ? current.steps.find((item) => item.stepId === command.stepId)
      : undefined;
    if (current.status === "partially_applied" || current.status === "reconciling") {
      return this.reconcileUnknownStep(
        command,
        fingerprint,
        current,
        step,
        resumeReservedReconcile,
      );
    } else {
      if (!current.applyCoverageFingerprint) {
        return this.rejection(
          command.commandId,
          fingerprint,
          current,
          current.revision,
          "audit_pending",
          "apply coverage fingerprintがありません",
          false,
        );
      }
      try {
        await this.drainPendingAudits(current);
      } catch (error) {
        return this.rejection(
          command.commandId,
          fingerprint,
          current,
          current.revision,
          "audit_pending",
          error instanceof Error ? error.message : String(error),
          false,
        );
      }
      current.status = "applied";
    }
    current.evidence.push(command.evidence);
    current.revision += 1;
    current.updatedAt = this.now();
    this.enqueueAudit(current, "proposal_reconciled", command.actor, {
      stepId: command.stepId ?? null,
    });
    const receipt = this.accepted(command.commandId, fingerprint, current);
    const conflict = await this.persist(current, receipt, {
      expectedProposalRevision: command.expectedRevision,
      allowedStatuses: ["partially_applied", "pending_audit", "applied"],
    });
    if (conflict) return conflict;
    await this.drainPendingAudits(current).catch(() => undefined);
    return receipt;
  }

  private async reconcileUnknownStep(
    command: Extract<MutationProposalCommand, { type: "reconcile" }>,
    fingerprint: string,
    current: MutationProposal,
    step: MutationPrimitiveStep | undefined,
    resumed: boolean,
  ): Promise<MutationProposalReceipt> {
    const expectedState = command.resolution === "confirm_committed" ? "reconciled" : "not_started";
    if (
      !step ||
      (!resumed && step.state !== "unknown") ||
      (resumed && step.state !== expectedState && step.state !== "unknown")
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "invalid_lifecycle",
        resumed
          ? "永続化済みreconcile結果がcommandと一致しません"
          : "unknown stepを指定してください",
      );
    }
    if (command.evidence.sideEffectState !== expectedState) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "invalid_lifecycle",
        `${expectedState} evidenceが必要です`,
      );
    }
    const validation = await this.environment.validateApply(current);
    if (!validation.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        validation.code,
        validation.diagnostic,
      );
    }
    if (!resumed) {
      current.status = "reconciling";
      current.revision += 1;
      current.updatedAt = this.now();
      const conflict = await this.persist(
        current,
        this.accepted(command.commandId, fingerprint, current),
        {
          expectedProposalRevision: command.expectedRevision,
          allowedStatuses: ["partially_applied"],
        },
      );
      if (conflict) return conflict;
      await this.afterReconcilePhasePersisted?.();
    }

    const ownerNonce = randomUUID();
    const claim = await this.repository.claimApplication({
      proposalId: current.proposalId,
      commandId: command.commandId,
      commandFingerprint: fingerprint,
      ownerNonce,
      leaseDurationSeconds: 60,
    });
    if (!claim.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "active_claim",
        "同じproposalのremote reconcileは別processが実行中です",
      );
    }
    const applicationLease = claim.lease;
    let reservation: MutationReservationProof | undefined;
    const reserved = await this.environment.mutationCoordination.reserveMutation(
      current,
      validation.claimEntityVersion ?? 0,
      ownerNonce,
    );
    if (!reserved.accepted) {
      await this.repository.releaseApplication(applicationLease).catch(() => false);
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        reserved.code,
        reserved.message,
      );
    }
    reservation = reserved.reservation;
    await this.afterReconcileReservationPersisted?.();

    try {
      if (step.state === "unknown") {
        let observed: MutationStepReconciliation;
        try {
          observed = this.environment.reconcileStep
            ? await this.environment.reconcileStep(step, current, {
                applicationLease,
                mutationReservation: reservation,
              })
            : { state: "unknown", diagnostic: "reconcile adapterがありません" };
        } catch (error) {
          observed = {
            state: "unknown",
            diagnostic: `reconcile live queryに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (observed.state !== expectedState) {
          current.status = "partially_applied";
          current.revision += 1;
          current.updatedAt = this.now();
          const receipt = this.rejection(
            command.commandId,
            fingerprint,
            current,
            current.revision,
            "side_effect_unknown",
            observed.diagnostic ?? "remote side effectをexactに照合できません",
            false,
          );
          const conflict = await this.persistFenced(
            current,
            receipt,
            {
              expectedProposalRevision: current.revision - 1,
              allowedStatuses: ["reconciling"],
            },
            { applicationLease, mutationReservation: reservation },
          );
          return conflict ?? receipt;
        }
        await this.afterReconciliationObserved?.();
        step.state = expectedState;
        step.diagnostic = observed.diagnostic;
        step.remoteIdentifiers = observed.remoteIdentifiers ?? null;
        if (observed.resolvedTaskId) {
          current.logicalTaskIds[step.targetTaskId] = observed.resolvedTaskId;
        }
        current.revision += 1;
        current.updatedAt = this.now();
        const conflict = await this.persistFenced(
          current,
          this.accepted(command.commandId, fingerprint, current),
          {
            expectedProposalRevision: current.revision - 1,
            allowedStatuses: ["reconciling"],
          },
          { applicationLease, mutationReservation: reservation },
        );
        if (conflict) return conflict;
        await this.afterReconciliationPersisted?.();
      }

      if (reservation?.sideEffectState === "in_flight") {
        reservation =
          await this.environment.mutationCoordination.completeMutationSideEffect(reservation);
      }
      if (reservation) {
        const released =
          await this.environment.mutationCoordination.releaseMutationReservation(reservation);
        if (released === false) throw new Error("mutation reservationを解除できません");
        reservation = undefined;
      }
      step.diagnostic = null;
      step.remoteExecution = null;
      current.status = "approved";
      current.evidence.push(command.evidence);
      current.revision += 1;
      current.updatedAt = this.now();
      this.enqueueAudit(current, "proposal_reconciled", command.actor, { stepId: step.stepId });
      const receipt = this.accepted(command.commandId, fingerprint, current);
      const conflict = await this.persist(current, receipt, {
        expectedProposalRevision: current.revision - 1,
        allowedStatuses: ["reconciling"],
      });
      if (conflict) return conflict;
      await this.drainPendingAudits(current).catch(() => undefined);
      return receipt;
    } finally {
      if (reservation) {
        await this.environment.mutationCoordination
          .releaseMutationReservation(reservation)
          .catch(() => false);
      }
      await this.repository.releaseApplication(applicationLease).catch(() => false);
    }
  }

  private async finalizePendingAudit(
    command: Extract<MutationProposalCommand, { type: "apply" }>,
    fingerprint: string,
    proposal: MutationProposal,
  ): Promise<MutationProposalReceipt> {
    try {
      await this.drainPendingAudits(proposal);
    } catch (error) {
      return this.rejection(
        command.commandId,
        fingerprint,
        proposal,
        proposal.revision,
        "audit_pending",
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
    proposal.status = "applied";
    proposal.revision += 1;
    proposal.updatedAt = this.now();
    const originTarget = proposal.invalidationTargets.find(
      (target) => target.runId === proposal.origin.runId,
    );
    const receipt = this.accepted(command.commandId, fingerprint, proposal, {
      changedTaskIds: proposal.targetTaskIds,
      successorPlanRevision: originTarget?.successorPlanRevision ?? null,
    });
    const conflict = await this.persist(proposal, receipt, {
      expectedProposalRevision: proposal.revision - 1,
      allowedStatuses: ["pending_audit"],
    });
    return conflict ?? receipt;
  }

  private async compensateCancel(
    command: Extract<MutationProposalCommand, { type: "reconcile" }>,
    fingerprint: string,
    current: MutationProposal,
    resumeReservedCompensation: boolean,
  ): Promise<MutationProposalReceipt> {
    const sourceStep = command.stepId
      ? current.steps.find((item) => item.stepId === command.stepId)
      : undefined;
    if (
      !sourceStep ||
      sourceStep.operation !== "cancel" ||
      !sourceStep.recoveryIntent ||
      command.beforeFingerprint !== sourceStep.recoveryIntent.beforeFingerprint ||
      (!resumeReservedCompensation &&
        sourceStep.state !== "committed" &&
        sourceStep.state !== "reconciled" &&
        sourceStep.state !== "unknown")
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "invalid_lifecycle",
        "cancel compensation bindingが一致しません",
      );
    }
    if (!command.approvalCommentRef || command.actor.role !== "human") {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        "cancel compensationにはhuman approval commentが必要です",
      );
    }
    const boundDecision = resumeReservedCompensation
      ? storedApprovalBinding(current)
      : approvalBinding(current, "compensation", { stepId: sourceStep.stepId });
    if (!boundDecision) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        "stored compensation approvalがありません",
      );
    }
    const verification = await this.environment.verifyHumanApproval(
      boundDecision,
      command.approvalCommentRef,
    );
    if (
      !verification.ok ||
      verification.receipt.decision !== "approve" ||
      verification.receipt.actor.id !== command.actor.id ||
      (resumeReservedCompensation &&
        (!current.trustedApproval ||
          verification.receipt.bodyHash !== current.trustedApproval.bodyHash ||
          verification.receipt.authorityConfigFingerprint !==
            current.trustedApproval.authorityConfigFingerprint))
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        verification.ok
          ? "compensation approval receiptがstored authorityと一致しません"
          : verification.diagnostic,
      );
    }
    const approval = verification.receipt;
    const compensationStepId = `compensation:${sourceStep.stepId}:${command.commandId}`;
    let compensationStep = current.steps.find((item) => item.stepId === compensationStepId);
    if (!resumeReservedCompensation) {
      compensationStep = {
        stepId: compensationStepId,
        operation: "recover_cancel",
        targetTaskId: sourceStep.targetTaskId,
        payload: { beforeFingerprint: command.beforeFingerprint },
        beforeImage: sourceStep.expectedPostcondition,
        expectedPostcondition: { state: "open", state_reason: null },
        state: "not_started",
        diagnostic: null,
        remoteIdentifiers: sourceStep.remoteIdentifiers,
        correlationToken: null,
        recoveryIntent: null,
      };
      current.steps.push(compensationStep);
      current.status = "compensating";
      current.revision += 1;
      current.updatedAt = this.now();
      current.approvalCommentRef = { ...command.approvalCommentRef };
      current.trustedApproval = storedTrustedApproval(approval);
      const reservation = this.accepted(command.commandId, fingerprint, current);
      const conflict = await this.persist(current, reservation, {
        expectedProposalRevision: command.expectedRevision,
        allowedStatuses: ["partially_applied", "applied"],
      });
      if (conflict) return conflict;
    }
    if (!compensationStep) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "side_effect_unknown",
        "compensation stepが見つかりません",
        false,
      );
    }
    const ownerNonce = randomUUID();
    const applicationClaim = await this.repository.claimApplication({
      proposalId: current.proposalId,
      commandId: command.commandId,
      commandFingerprint: fingerprint,
      ownerNonce,
      leaseDurationSeconds: 60,
    });
    if (!applicationClaim.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "active_claim",
        "同じproposalのcompensationは別processが実行中です",
      );
    }
    let applicationLease = applicationClaim.lease;
    let mutationReservation: MutationReservationProof | undefined;
    const compensationValidation = await this.environment.validateApply(current);
    if (!compensationValidation.ok) {
      await this.repository.releaseApplication(applicationLease).catch(() => false);
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        compensationValidation.code,
        compensationValidation.diagnostic,
      );
    }
    // compensation時点の全Run coverageをdurable stateへ採用し、旧apply集合を再利用しない。
    current.applyCoverageFingerprint = compensationValidation.coverageFingerprint;
    current.invalidationTargets = compensationValidation.affectedRuns ?? [];
    current.revision += 1;
    current.updatedAt = this.now();
    const coveragePersisted = await this.persist(
      current,
      this.accepted(command.commandId, fingerprint, current),
      {
        expectedProposalRevision: current.revision - 1,
        allowedStatuses: ["compensating"],
      },
    );
    if (coveragePersisted) {
      await this.repository.releaseApplication(applicationLease).catch(() => false);
      return coveragePersisted;
    }
    const reservation = await this.environment.mutationCoordination.reserveMutation(
      current,
      compensationValidation.claimEntityVersion ?? 0,
      ownerNonce,
    );
    if (!reservation.accepted) {
      await this.repository.releaseApplication(applicationLease).catch(() => false);
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        reservation.code,
        reservation.message,
      );
    }
    mutationReservation = reservation.reservation;
    try {
      let outcome: MutationStepOutcome | null = null;
      if (
        compensationStep.state === "unknown" ||
        compensationStep.remoteExecution?.state === "side_effect_in_flight"
      ) {
        const reconciliation = await this.environment.reconcileStep?.(compensationStep, current, {
          applicationLease,
          mutationReservation,
        });
        if (!reconciliation || reconciliation.state === "unknown") {
          return this.rejection(
            command.commandId,
            fingerprint,
            current,
            current.revision,
            "side_effect_unknown",
            reconciliation?.diagnostic ??
              compensationStep.diagnostic ??
              "compensation stateがunknownです",
            false,
          );
        }
        if (reconciliation.state === "reconciled") {
          outcome = {
            state: "reconciled",
            diagnostic: reconciliation.diagnostic,
            resolvedTaskId: reconciliation.resolvedTaskId,
            remoteIdentifiers: reconciliation.remoteIdentifiers,
          };
        } else if (compensationStep.remoteExecution?.state === "side_effect_in_flight") {
          return this.rejection(
            command.commandId,
            fingerprint,
            current,
            current.revision,
            "side_effect_unknown",
            "expired compensation in-flight ownerのtakeoverはreconcile-onlyです",
            false,
          );
        } else {
          compensationStep.state = "not_started";
          compensationStep.diagnostic = reconciliation.diagnostic;
          compensationStep.remoteIdentifiers = reconciliation.remoteIdentifiers ?? null;
        }
      }
      if (!outcome) {
        try {
          if (!compensationStep.localPreparation && this.environment.prepareStep) {
            const preparation = await this.environment.prepareStep(compensationStep, current, {
              applicationLease,
              mutationReservation,
            });
            if (!preparation.ok) throw new Error(preparation.diagnostic);
            compensationStep.localPreparation = preparation.preparation;
            current.revision += 1;
            current.updatedAt = this.now();
            const preparationPersisted = await this.persistFenced(
              current,
              this.accepted(command.commandId, fingerprint, current),
              {
                expectedProposalRevision: current.revision - 1,
                allowedStatuses: ["compensating"],
              },
              { applicationLease, mutationReservation },
            );
            if (preparationPersisted) return preparationPersisted;
          }
          const fenced = await this.repository.fenceApplication({
            lease: applicationLease,
            stepId: compensationStep.stepId,
            leaseDurationSeconds: 60,
          });
          if (!fenced.ok) throw new Error("application_fence_lost");
          applicationLease = fenced.lease;
          compensationStep.remoteExecution = {
            state: "side_effect_in_flight",
            ownerNonce: applicationLease.ownerNonce,
            fencingToken: applicationLease.fencingToken,
            startedAt: this.now(),
          };
          current.revision += 1;
          current.updatedAt = this.now();
          const intentPersisted = await this.persistFenced(
            current,
            this.accepted(command.commandId, fingerprint, current),
            {
              expectedProposalRevision: current.revision - 1,
              allowedStatuses: ["compensating"],
            },
            { applicationLease, mutationReservation },
          );
          if (intentPersisted) return intentPersisted;
          if (mutationReservation) {
            mutationReservation =
              await this.environment.mutationCoordination.beginMutationSideEffect(
                mutationReservation,
              );
          }
          outcome = await this.environment.executeStep(
            compensationStep,
            current,
            { applicationLease, mutationReservation },
            async (remoteOutcome) => {
              compensationStep!.state = remoteOutcome.state;
              compensationStep!.diagnostic = remoteOutcome.diagnostic;
              compensationStep!.remoteIdentifiers = remoteOutcome.remoteIdentifiers ?? null;
              current.revision += 1;
              current.updatedAt = this.now();
              const persisted = await this.persistFenced(
                current,
                this.accepted(command.commandId, fingerprint, current),
                {
                  expectedProposalRevision: current.revision - 1,
                  allowedStatuses: ["compensating"],
                },
                { applicationLease, mutationReservation: mutationReservation! },
              );
              if (persisted) throw new Error(persisted.diagnostic ?? "compensation CAS失敗");
            },
          );
        } catch (error) {
          outcome = {
            state: "unknown",
            diagnostic: error instanceof Error ? error.message : String(error),
            remoteIdentifiers: compensationStep.remoteIdentifiers,
          };
        }
      }
      compensationStep.state = outcome.state;
      compensationStep.diagnostic = outcome.diagnostic;
      compensationStep.remoteIdentifiers = outcome.remoteIdentifiers ?? null;
      current.revision += 1;
      current.updatedAt = this.now();
      if (outcome.state === "unknown") {
        const failed = this.rejection(
          command.commandId,
          fingerprint,
          current,
          current.revision,
          "side_effect_unknown",
          outcome.diagnostic ?? "compensation stateがunknownです",
          false,
        );
        const conflict = await this.persistFenced(
          current,
          failed,
          {
            expectedProposalRevision: current.revision - 1,
            allowedStatuses: ["compensating"],
          },
          { applicationLease, mutationReservation },
        );
        return conflict ?? failed;
      }
      const stepPersisted = await this.persistFenced(
        current,
        this.accepted(command.commandId, fingerprint, current),
        {
          expectedProposalRevision: current.revision - 1,
          allowedStatuses: ["compensating"],
        },
        { applicationLease, mutationReservation },
      );
      if (stepPersisted) return stepPersisted;
      compensationStep.remoteExecution = null;
      if (mutationReservation?.sideEffectState === "in_flight") {
        mutationReservation =
          await this.environment.mutationCoordination.completeMutationSideEffect(
            mutationReservation,
          );
      }
      if (mutationReservation) {
        const released =
          await this.environment.mutationCoordination.releaseMutationReservation(
            mutationReservation,
          );
        if (!released) throw new Error("mutation reservationを解除できません");
        mutationReservation = undefined;
      }
      current.status = "compensated";
      current.revision += 1;
      current.updatedAt = this.now();
      current.invalidationTargets = current.invalidationTargets.map((target) => ({
        ...target,
        successorPlanRevision: {
          planId: target.planId,
          fromVersion: target.planVersion,
          proposedVersion: `${target.planVersion}+compensation.${current.proposalId}`,
          reasonProposalId: current.proposalId,
        },
      }));
      current.evidence.push(command.evidence);
      this.enqueueAudit(current, "proposal_compensated", approval.actor, {
        sourceStepId: sourceStep.stepId,
        compensationStepId,
        beforeFingerprint: command.beforeFingerprint,
      });
      this.enqueueAudit(
        current,
        "work_graph_invalidated",
        INTERNAL_MUTATION_ORCHESTRATOR,
        this.invalidationDetail(
          current,
          current.applyCoverageFingerprint ??
            mutationCommandFingerprint(current.invalidationTargets),
        ),
      );
      const receipt = this.accepted(command.commandId, fingerprint, current, {
        changedTaskIds: [sourceStep.targetTaskId],
      });
      const conflict = await this.persist(current, receipt, {
        expectedProposalRevision: current.revision - 1,
        allowedStatuses: ["compensating"],
      });
      if (conflict) return conflict;
      await this.drainPendingAudits(current).catch(() => undefined);
      return receipt;
    } finally {
      if (mutationReservation) {
        await this.environment.mutationCoordination
          .releaseMutationReservation(mutationReservation)
          .catch(() => false);
      }
      await this.repository.releaseApplication(applicationLease).catch(() => false);
    }
  }

  private async expire(
    command: Extract<MutationProposalCommand, { type: "expire" }>,
    fingerprint: string,
    registry: MutationProposalRegistry,
  ): Promise<MutationProposalReceipt> {
    const proposal = registry.proposals.find((item) => item.proposalId === command.proposalId);
    const gate = this.mutableProposal(command, fingerprint, proposal, [
      "awaiting_human",
      "approved",
    ]);
    if (gate) return gate;
    proposal!.status = "expired";
    proposal!.revision += 1;
    proposal!.updatedAt = this.now();
    this.enqueueAudit(proposal!, "proposal_expired", command.actor, {});
    const receipt = this.accepted(command.commandId, fingerprint, proposal!);
    const conflict = await this.persist(proposal!, receipt, {
      expectedProposalRevision: command.expectedRevision,
      allowedStatuses: ["awaiting_human", "approved"],
    });
    if (conflict) return conflict;
    await this.drainPendingAudits(proposal!).catch(() => undefined);
    return receipt;
  }

  private async supersede(
    command: Extract<MutationProposalCommand, { type: "supersede" }>,
    fingerprint: string,
    registry: MutationProposalRegistry,
  ): Promise<MutationProposalReceipt> {
    const proposal = registry.proposals.find((item) => item.proposalId === command.proposalId);
    const successor = registry.proposals.find(
      (item) => item.proposalId === command.successorProposalId,
    );
    const gate = this.mutableProposal(command, fingerprint, proposal, [
      "awaiting_human",
      "approved",
    ]);
    if (gate) return gate;
    if (!successor) {
      return this.rejection(
        command.commandId,
        fingerprint,
        proposal!,
        proposal!.revision,
        "proposal_not_found",
        "successor proposalが見つかりません",
      );
    }
    proposal!.status = "superseded";
    proposal!.successorProposalId = successor.proposalId;
    proposal!.revision += 1;
    proposal!.updatedAt = this.now();
    this.enqueueAudit(proposal!, "proposal_superseded", command.actor, {
      successorProposalId: successor.proposalId,
    });
    const receipt = this.accepted(command.commandId, fingerprint, proposal!);
    const conflict = await this.persist(proposal!, receipt, {
      expectedProposalRevision: command.expectedRevision,
      allowedStatuses: ["awaiting_human", "approved"],
    });
    if (conflict) return conflict;
    await this.drainPendingAudits(proposal!).catch(() => undefined);
    return receipt;
  }

  private async acceptReplan(
    command: Extract<MutationProposalCommand, { type: "accept_replan" }>,
    fingerprint: string,
    registry: MutationProposalRegistry,
    resumeReservedReplan: boolean,
  ): Promise<MutationProposalReceipt> {
    const proposal = registry.proposals.find((item) => item.proposalId === command.proposalId);
    const gate = resumeReservedReplan
      ? proposal?.status === "accepting_replan"
        ? null
        : this.rejection(
            command.commandId,
            fingerprint,
            proposal ?? null,
            proposal?.revision ?? 0,
            "invalid_lifecycle",
            "予約済みreplan acceptanceのproposal stateが一致しません",
          )
      : this.mutableProposal(command, fingerprint, proposal, ["applied", "compensated"]);
    if (gate) return gate;
    const current = proposal!;
    if (command.actor.role !== "human") {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        "replan acceptanceはverified humanだけが実行できます",
      );
    }
    const target = current.invalidationTargets.find(
      (candidate) =>
        candidate.runId === (command.targetRunId ?? current.origin.runId) &&
        candidate.projectRoot === (command.targetProjectRoot ?? candidate.projectRoot),
    );
    if (!target) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "origin_binding_drift",
        "replan target Runがfrozen invalidation targetにありません",
      );
    }
    const expectedSuccessor = target.successorPlanRevision;
    if (
      mutationCommandFingerprint(command.successorPlanRevision) !==
      mutationCommandFingerprint(expectedSuccessor)
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "origin_binding_drift",
        "successor plan revisionがapplied proposalと一致しません",
      );
    }

    const boundDecision = resumeReservedReplan
      ? storedApprovalBinding(current)
      : approvalBinding(current, "replan", {
          targetRunId: target.runId,
          targetProjectRoot: target.projectRoot,
          successorPlanRevision: expectedSuccessor,
        });
    if (!boundDecision) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        "stored trusted replan approvalがありません",
      );
    }
    if (
      resumeReservedReplan &&
      mutationCommandFingerprint(current.approvalCommentRef) !==
        mutationCommandFingerprint(command.approvalCommentRef)
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        "予約済みreplan approval commentが一致しません",
      );
    }
    const verification = await this.environment.verifyHumanApproval(
      boundDecision,
      command.approvalCommentRef,
    );
    if (
      !verification.ok ||
      verification.receipt.decision !== "approve" ||
      verification.receipt.actor.id !== command.actor.id ||
      (resumeReservedReplan &&
        (!current.trustedApproval ||
          verification.receipt.bodyHash !== current.trustedApproval.bodyHash ||
          verification.receipt.authorityConfigFingerprint !==
            current.trustedApproval.authorityConfigFingerprint))
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "human_gate_required",
        verification.ok
          ? "replan approval receiptがstored authorityと一致しません"
          : verification.diagnostic,
      );
    }
    const approval = verification.receipt;
    if (!resumeReservedReplan) {
      current.status = "accepting_replan";
      current.revision += 1;
      current.updatedAt = this.now();
      current.approvalCommentRef = { ...command.approvalCommentRef };
      current.trustedApproval = storedTrustedApproval(approval);
      const reservation = this.accepted(command.commandId, fingerprint, current, {
        successorPlanRevision: expectedSuccessor,
      });
      const conflict = await this.persist(current, reservation, {
        expectedProposalRevision: command.expectedRevision,
        allowedStatuses: ["applied", "compensated"],
      });
      if (conflict) return conflict;
    }
    if (!this.environment.acceptReplan) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        "run_state_unknown",
        "replan acceptance adapterが利用できません",
        false,
      );
    }
    const result = await this.environment.acceptReplan(
      current,
      approval,
      expectedSuccessor,
      command.successorNodeId,
      target,
    );
    if (!result.ok) {
      return this.rejection(
        command.commandId,
        fingerprint,
        current,
        current.revision,
        result.code,
        result.diagnostic,
        false,
      );
    }
    current.status = current.steps.some(
      (step) =>
        step.operation === "recover_cancel" &&
        (step.state === "committed" || step.state === "reconciled"),
    )
      ? "compensated"
      : "applied";
    current.revision += 1;
    current.updatedAt = this.now();
    this.enqueueAudit(current, "proposal_reconciled", approval.actor, {
      action: "replan_accepted",
      successorNodeId: command.successorNodeId,
      receiptFingerprint: mutationCommandFingerprint(approval),
    });
    const receipt = this.accepted(command.commandId, fingerprint, current, {
      successorPlanRevision: expectedSuccessor,
    });
    const conflict = await this.persist(current, receipt, {
      expectedProposalRevision: current.revision - 1,
      allowedStatuses: ["accepting_replan"],
    });
    if (conflict) return conflict;
    await this.drainPendingAudits(current).catch(() => undefined);
    return receipt;
  }

  private mutableProposal(
    command: Exclude<MutationProposalCommand, { type: "propose" }>,
    fingerprint: string,
    proposal: MutationProposal | undefined,
    statuses: MutationProposal["status"][],
  ): MutationProposalReceipt | null {
    if (!proposal) {
      return this.rejection(
        command.commandId,
        fingerprint,
        null,
        0,
        "proposal_not_found",
        "proposalが見つかりません",
      );
    }
    if (proposal.revision !== command.expectedRevision) {
      return this.rejection(
        command.commandId,
        fingerprint,
        proposal,
        proposal.revision,
        "stale_revision",
        "expected revisionが一致しません",
      );
    }
    if (!statuses.includes(proposal.status)) {
      return this.rejection(
        command.commandId,
        fingerprint,
        proposal,
        proposal.revision,
        "invalid_lifecycle",
        `status ${proposal.status} では実行できません`,
      );
    }
    if (
      Date.parse(this.now()) >= Date.parse(proposal.expiresAt) &&
      command.type !== "expire" &&
      command.type !== "reconcile"
    ) {
      return this.rejection(
        command.commandId,
        fingerprint,
        proposal,
        proposal.revision,
        "expired",
        "proposalが期限切れです",
      );
    }
    return null;
  }

  private accepted(
    commandId: string,
    fingerprint: string,
    proposal: MutationProposal,
    overrides: Partial<MutationProposalReceipt> = {},
  ): MutationProposalReceipt {
    return MutationProposalReceiptSchema.parse({
      schemaVersion: "1",
      accepted: true,
      commandId,
      commandFingerprint: fingerprint,
      proposalId: proposal.proposalId,
      revision: proposal.revision,
      status: proposal.status,
      stateUnchanged: false,
      errorCode: null,
      diagnostic: null,
      changedTaskIds: [],
      successorPlanRevision: null,
      ...overrides,
    });
  }

  private rejection(
    commandId: string,
    fingerprint: string,
    proposal: MutationProposal | null,
    revision: number,
    errorCode: string,
    diagnostic: string,
    stateUnchanged = true,
  ): MutationProposalReceipt {
    return MutationProposalReceiptSchema.parse({
      schemaVersion: "1",
      accepted: false,
      commandId,
      commandFingerprint: fingerprint,
      proposalId: proposal?.proposalId ?? null,
      revision,
      status: proposal?.status ?? null,
      stateUnchanged,
      errorCode,
      diagnostic,
      changedTaskIds: [],
      successorPlanRevision: null,
    });
  }

  private async persist(
    proposal: MutationProposal,
    receipt: MutationProposalReceipt,
    options: MutationProposalRecordOptions,
  ): Promise<MutationProposalReceipt | null> {
    const result = await this.repository.recordReceipt(proposal, receipt, options);
    if (!result || result.ok) return null;
    if (
      result.receipt &&
      result.receipt.commandId === receipt.commandId &&
      result.receipt.commandFingerprint === receipt.commandFingerprint
    ) {
      return result.receipt;
    }
    const current = result.currentProposal;
    return this.rejection(
      receipt.commandId,
      receipt.commandFingerprint,
      current,
      current?.revision ?? 0,
      result.code,
      result.code === "command_payload_mismatch"
        ? "同じcommandIdに異なるpayloadは使用できません"
        : result.code === "invalid_lifecycle"
          ? "proposal statusが別commandにより変更されました"
          : "proposal revisionが別commandにより変更されました",
    );
  }

  /** remote outcome/step CASをapplication leaseとreservationの両lock内で確定する。 */
  private async persistFenced(
    proposal: MutationProposal,
    receipt: MutationProposalReceipt,
    options: MutationProposalRecordOptions,
    fence: MutationFenceContext,
  ): Promise<MutationProposalReceipt | null> {
    return this.persist(proposal, receipt, {
      ...options,
      applicationLease: fence.applicationLease,
      mutationReservation: fence.mutationReservation,
      withMutationReservation: this.environment.mutationCoordination.withMutationReservation.bind(
        this.environment.mutationCoordination,
      ),
    });
  }

  private enqueueAudit(
    proposal: MutationProposal,
    type: MutationProposalAuditEvent["type"],
    actor: MutationActor,
    detail: Record<string, unknown>,
  ): void {
    const event = {
      eventId: `mutation:${proposal.proposalId}:${type}:${proposal.revision}`,
      proposalRevision: proposal.revision,
      type,
      actorId: actor.id,
      actorRole: actor.role,
      occurredAt: this.now(),
      detail,
    };
    if (!proposal.pendingAudits.some((candidate) => candidate.eventId === event.eventId)) {
      proposal.pendingAudits.push(event);
    }
    if (!proposal.pendingAuditEventIds.includes(event.eventId)) {
      proposal.pendingAuditEventIds.push(event.eventId);
    }
  }

  private async drainPendingAudits(proposal: MutationProposal): Promise<void> {
    for (const envelope of proposal.pendingAudits) {
      await this.environment.appendAudit({
        ...envelope,
        proposalId: proposal.proposalId,
        originRunId: proposal.origin.runId,
      });
      const acknowledged = await this.repository.acknowledgeAudit(
        proposal.proposalId,
        envelope.eventId,
        proposal.revision,
      );
      if (!acknowledged) throw new Error(`audit outbox CASに失敗しました: ${envelope.eventId}`);
      proposal.pendingAudits = proposal.pendingAudits.filter(
        (candidate) => candidate.eventId !== envelope.eventId,
      );
      proposal.pendingAuditEventIds = proposal.pendingAuditEventIds.filter(
        (eventId) => eventId !== envelope.eventId,
      );
    }
  }

  private invalidationDetail(
    proposal: MutationProposal,
    coverageFingerprint: string,
  ): Record<string, unknown> {
    return {
      affectedTaskIds: [
        ...new Set(
          [proposal.origin.taskId, ...proposal.targetTaskIds, ...proposal.affectedDownstream].map(
            (taskId) => proposal.logicalTaskIds[taskId] ?? taskId,
          ),
        ),
      ],
      coverageFingerprint,
      planId: proposal.origin.planId,
      fromVersion: proposal.origin.planVersion,
      proposedVersion: `${proposal.origin.planVersion}+proposal.${proposal.proposalId}`,
      affectedRuns: proposal.invalidationTargets,
    };
  }

  private approvalRequests(
    proposal: MutationProposal,
  ): MutationProposalFullView["approvalRequests"] {
    const issueUrl = `https://github.com/${proposal.origin.repository}/issues/${proposal.origin.taskId.split("#").at(-1)}`;
    const request = (
      purpose: "decision" | "compensation" | "replan",
      options: Parameters<typeof approvalBinding>[2] = {},
    ) => ({
      purpose,
      proposalId: proposal.proposalId,
      revision: proposal.revision,
      proposalFingerprint: proposal.planFingerprint,
      expiresAt: proposal.expiresAt,
      issueUrl,
      machineBlock: renderMutationApprovalMachineBlock({
        ...approvalBinding(proposal, purpose, options),
        decision: "approve",
      }),
    });
    const requests: MutationProposalFullView["approvalRequests"] = [];
    if (proposal.status === "awaiting_human") requests.push(request("decision"));
    if (proposal.status === "partially_applied" || proposal.status === "applied") {
      for (const step of proposal.steps) {
        if (
          step.operation === "cancel" &&
          step.recoveryIntent &&
          (step.state === "committed" || step.state === "reconciled" || step.state === "unknown")
        ) {
          requests.push({
            ...request("compensation", { stepId: step.stepId }),
            stepId: step.stepId,
          });
        }
      }
    }
    if (proposal.status === "applied" || proposal.status === "compensated") {
      for (const target of proposal.invalidationTargets) {
        requests.push({
          ...request("replan", {
            targetRunId: target.runId,
            targetProjectRoot: target.projectRoot,
            successorPlanRevision: target.successorPlanRevision,
          }),
          targetRunId: target.runId,
          targetProjectRoot: target.projectRoot,
          successorPlanRevision: target.successorPlanRevision,
        });
      }
    }
    return requests;
  }
}
