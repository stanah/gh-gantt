import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import { NormalizedRepositorySchema } from "./repository.js";

export const MUTATION_PROPOSAL_SCHEMA_VERSION = "1" as const;
export const MUTATION_PROPOSAL_DEFAULT_LIMIT = 20;
export const MUTATION_PROPOSAL_MAX_LIMIT = 100;
export const MUTATION_PROPOSAL_MAX_EVIDENCE = 20;
export const MUTATION_PROPOSAL_MAX_OPERATIONS = 50;

const NonEmptyStringSchema = z.string().trim().min(1);
const TaskIdSchema = NonEmptyStringSchema.max(300);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export interface MutationActor {
  id: string;
  role: "orchestrator" | "planner" | "implementer" | "executor" | "reviewer" | "human";
}

export interface MutationEvidence {
  id: string;
  kind: "observation" | "requirement" | "review" | "human_decision" | "side_effect_reconciliation";
  source: string;
  summary: string;
  observedAt: string;
  sideEffectState?: "not_started" | "committed" | "reconciled" | "unknown";
}

export interface MutationOrigin {
  runId: string;
  workspaceId: string;
  taskId: string;
  repository: string;
  planId: string;
  planVersion: string;
  authorityId: string;
  mutationCheckpointId: string;
}

export interface MutationNewTaskSpec {
  clientId: string;
  title: string;
  type: string;
  body?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  requireReview?: boolean;
}

export type WorkGraphMutationIntent =
  | {
      kind: "split";
      targetTaskId: string;
      children: MutationNewTaskSpec[];
      sourceDisposition: "keep" | "close";
    }
  | { kind: "add"; parentTaskId: string | null; task: MutationNewTaskSpec }
  | {
      kind: "merge";
      sourceTaskIds: string[];
      targetTaskId: string;
      sourceDisposition: "close";
    }
  | {
      kind: "reorder";
      semantics: "sibling_priority";
      parentTaskId: string;
      orderedSubTaskIds: string[];
      movedSubTaskId: string;
      beforeSubTaskId?: string;
      afterSubTaskId?: string;
    }
  | { kind: "cancel"; targetTaskId: string; reason: string }
  | {
      kind: "dependency";
      operation: "add" | "remove";
      taskId: string;
      blockerTaskId: string;
    };
export type WorkGraphMutationKind = WorkGraphMutationIntent["kind"];

interface MutationActorCommandBase {
  schemaVersion: "1";
  commandId: string;
  actor: MutationActor;
}

export type MutationProposalCommand =
  | (MutationActorCommandBase & {
      type: "propose";
      originRunId: string;
      intent: WorkGraphMutationIntent;
      evidence: MutationEvidence[];
      expiresAt: string;
    })
  | {
      schemaVersion: "1";
      commandId: string;
      type: "decide";
      proposalId: string;
      expectedRevision: number;
      approvalCommentRef: { repository: string; issueNumber: number; commentId: string };
    }
  | (MutationActorCommandBase & {
      type: "apply";
      proposalId: string;
      expectedRevision: number;
    })
  | (MutationActorCommandBase & {
      type: "reconcile";
      proposalId: string;
      expectedRevision: number;
      stepId?: string;
      evidence: MutationEvidence;
      resolution: "confirm_committed" | "confirm_not_started" | "reopen_cancelled_task";
      beforeFingerprint?: string;
      approvalCommentRef?: { repository: string; issueNumber: number; commentId: string };
    })
  | (MutationActorCommandBase & {
      type: "expire";
      proposalId: string;
      expectedRevision: number;
    })
  | (MutationActorCommandBase & {
      type: "supersede";
      proposalId: string;
      expectedRevision: number;
      successorProposalId: string;
    })
  | (MutationActorCommandBase & {
      type: "accept_replan";
      proposalId: string;
      expectedRevision: number;
      approvalCommentRef: { repository: string; issueNumber: number; commentId: string };
      successorPlanRevision: MutationSuccessorPlanRevision;
      successorNodeId: string;
      targetRunId?: string;
      targetProjectRoot?: string;
    });

export type MutationPrimitiveOperation =
  | "create"
  | "update"
  | "link"
  | "reprioritize"
  | "complete_close"
  | "cancel"
  | "recover_cancel";

export interface MutationPrimitiveStep {
  stepId: string;
  operation: MutationPrimitiveOperation;
  targetTaskId: string;
  payload: Record<string, unknown>;
  beforeImage: Record<string, unknown> | null;
  expectedPostcondition: Record<string, unknown>;
  state: "not_started" | "committed" | "reconciled" | "unknown";
  diagnostic: string | null;
  remoteIdentifiers?: {
    issueId?: string;
    issueNumber?: number;
    projectItemId?: string;
  } | null;
  localPreparation?: {
    sourceRevision: string;
    sourceFingerprint: string;
    preparedFingerprint: string;
    preparedAt: string;
  } | null;
  remoteExecution?: {
    state: "side_effect_in_flight";
    ownerNonce: string;
    fencingToken: number;
    startedAt: string;
  } | null;
  correlationToken: string | null;
  recoveryIntent: { kind: "reopen_cancelled_task"; beforeFingerprint: string } | null;
}

export type MutationApproval =
  | { kind: "human"; actor: MutationActor; evidenceId: string; decidedAt: string }
  | {
      kind: "policy";
      policyId: string;
      policyVersion: string;
      ruleId: string;
      evidenceId: string;
      decidedAt: string;
    };

export type MutationProposalStatus =
  | "awaiting_human"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded"
  | "applying"
  | "partially_applied"
  | "reconciling"
  | "pending_audit"
  | "accepting_replan"
  | "compensating"
  | "applied"
  | "compensated";

export interface MutationProposalAuditEnvelope {
  eventId: string;
  proposalRevision: number;
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
  actorId: string;
  actorRole: MutationActor["role"];
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface MutationTaskDiff {
  taskId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface MutationProposal {
  schemaVersion: "1";
  proposalId: string;
  revision: number;
  status: MutationProposalStatus;
  commandId: string;
  commandFingerprint: string;
  sourceRevision: string;
  snapshotFingerprint: string;
  proposeCoverageFingerprint: string;
  planFingerprint: string;
  policyFingerprint: string | null;
  origin: MutationOrigin;
  intent: WorkGraphMutationIntent;
  targetTaskIds: string[];
  evidence: MutationEvidence[];
  diff: MutationTaskDiff[];
  affectedUpstream: string[];
  affectedDownstream: string[];
  risk: "low" | "medium" | "high" | "destructive";
  proposedBy: MutationActor;
  approval: MutationApproval | null;
  approvalCommentRef: { repository: string; issueNumber: number; commentId: string } | null;
  trustedApproval: {
    decision: "approve" | "reject";
    boundRevision: number;
    boundProposalFingerprint: string;
    boundExpiresAt: string;
    boundPurpose: "decision" | "compensation" | "replan";
    boundStepId: string | null;
    boundTargetRunId: string | null;
    boundTargetProjectRoot: string | null;
    boundSuccessorDescriptorFingerprint: string | null;
    authorNodeId: string;
    commentId: string;
    bodyHash: string;
    commentUpdatedAt: string;
    authorityConfigFingerprint: string;
  } | null;
  steps: MutationPrimitiveStep[];
  logicalTaskIds: Record<string, string>;
  successorProposalId: string | null;
  applyCoverageFingerprint: string | null;
  applyBaseline: {
    sourceRevision: string;
    snapshotFingerprint: string;
    afterStepId: string;
  } | null;
  invalidationTargets: Array<{
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
  pendingAuditEventIds: string[];
  pendingAudits: MutationProposalAuditEnvelope[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MutationSuccessorPlanRevision {
  planId: string;
  fromVersion: string;
  proposedVersion: string;
  reasonProposalId: string;
}

export interface MutationProposalReceipt {
  schemaVersion: "1";
  accepted: boolean;
  commandId: string;
  commandFingerprint: string;
  proposalId: string | null;
  revision: number;
  status: MutationProposalStatus | null;
  stateUnchanged: boolean;
  errorCode: string | null;
  diagnostic: string | null;
  changedTaskIds: string[];
  successorPlanRevision: MutationSuccessorPlanRevision | null;
  approvalRequest?: { issueUrl: string; machineBlock: string } | null;
}

export interface MutationProposalSummary {
  proposalId: string;
  revision: number;
  status: MutationProposalStatus;
  mutationKind: WorkGraphMutationKind;
  targetTaskIds: string[];
  risk: MutationProposal["risk"];
  proposedBy: MutationActor;
  createdAt: string;
  expiresAt: string;
}

export interface MutationProposalView {
  schemaVersion: "1";
  total: number;
  limit: number;
  truncated: boolean;
  items: MutationProposalSummary[];
}

export interface MutationProposalFullView {
  schemaVersion: "1";
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  items: MutationProposal[];
  approvalRequests: Array<{
    purpose: "decision" | "compensation" | "replan";
    proposalId: string;
    revision: number;
    proposalFingerprint: string;
    expiresAt: string;
    issueUrl: string;
    machineBlock: string;
    stepId?: string;
    targetRunId?: string;
    targetProjectRoot?: string;
    successorPlanRevision?: MutationSuccessorPlanRevision;
  }>;
}

export interface MutationProposalInspectQuery {
  proposalId?: string;
  full?: boolean;
  limit?: number;
  offset?: number;
}

export interface MutationPolicyRule {
  id: string;
  mutation_kinds: Exclude<WorkGraphMutationKind, "cancel">[];
  repositories: string[];
  root_task_ids: string[];
  task_types: string[];
  max_operations: number;
  max_affected_tasks: number;
  max_risk: "low" | "medium" | "high";
}

export interface MutationPolicyConfig {
  schema_version: "1";
  policy_id: string;
  version: string;
  rules: MutationPolicyRule[];
}

export interface MutationApprovalConfig {
  schema_version: "1";
  source: "github_issue_comment";
  allowed_author_node_ids: string[];
}

const MutationActorSchemaValue: z.ZodType<MutationActor> = z
  .object({
    id: NonEmptyStringSchema,
    role: z.enum(["orchestrator", "planner", "implementer", "executor", "reviewer", "human"]),
  })
  .strict();
export const MutationActorSchema: typeof MutationActorSchemaValue = MutationActorSchemaValue;

const MutationEvidenceSchemaValue: z.ZodType<MutationEvidence> = z
  .object({
    id: NonEmptyStringSchema,
    kind: z.enum([
      "observation",
      "requirement",
      "review",
      "human_decision",
      "side_effect_reconciliation",
    ]),
    source: NonEmptyStringSchema,
    summary: z.string().trim().min(1).max(500),
    observedAt: z.string().datetime(),
    sideEffectState: z.enum(["not_started", "committed", "reconciled", "unknown"]).optional(),
  })
  .strict();
export const MutationEvidenceSchema: typeof MutationEvidenceSchemaValue =
  MutationEvidenceSchemaValue;

const MutationOriginSchemaValue: z.ZodType<MutationOrigin> = z
  .object({
    runId: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    taskId: TaskIdSchema,
    repository: NormalizedRepositorySchema,
    planId: NonEmptyStringSchema,
    planVersion: NonEmptyStringSchema,
    authorityId: NonEmptyStringSchema,
    mutationCheckpointId: NonEmptyStringSchema,
  })
  .strict();
export const MutationOriginSchema: typeof MutationOriginSchemaValue = MutationOriginSchemaValue;

const NewTaskSpecSchema: z.ZodType<MutationNewTaskSpec> = z
  .object({
    clientId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    title: NonEmptyStringSchema.max(500),
    type: NonEmptyStringSchema,
    body: z.string().max(20_000).nullable().optional(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    requireReview: z.boolean().optional(),
  })
  .strict();

const WorkGraphMutationIntentSchemaValue: z.ZodType<WorkGraphMutationIntent> = z.union([
  z
    .object({
      kind: z.literal("split"),
      targetTaskId: TaskIdSchema,
      children: z.array(NewTaskSpecSchema).min(2).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
      sourceDisposition: z.enum(["keep", "close"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("add"),
      parentTaskId: TaskIdSchema.nullable(),
      task: NewTaskSpecSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge"),
      sourceTaskIds: z.array(TaskIdSchema).min(2).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
      targetTaskId: TaskIdSchema,
      sourceDisposition: z.literal("close"),
    })
    .strict()
    .refine((value) => new Set(value.sourceTaskIds).size === value.sourceTaskIds.length, {
      path: ["sourceTaskIds"],
      message: "merge sourceTaskIds に重複は許可されません",
    })
    .refine((value) => !value.sourceTaskIds.includes(value.targetTaskId), {
      message: "merge target は source と別 task である必要があります",
    }),
  z
    .object({
      kind: z.literal("reorder"),
      semantics: z.literal("sibling_priority"),
      parentTaskId: TaskIdSchema,
      orderedSubTaskIds: z.array(TaskIdSchema).min(2).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
      movedSubTaskId: TaskIdSchema,
      beforeSubTaskId: TaskIdSchema.optional(),
      afterSubTaskId: TaskIdSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.orderedSubTaskIds).size !== value.orderedSubTaskIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["orderedSubTaskIds"],
          message: "orderedSubTaskIds に重複は許可されません",
        });
      }
      if (!value.orderedSubTaskIds.includes(value.movedSubTaskId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["movedSubTaskId"],
          message: "movedSubTaskId は sibling 集合に含まれる必要があります",
        });
      }
      if ((value.beforeSubTaskId === undefined) === (value.afterSubTaskId === undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["beforeSubTaskId"],
          message: "beforeSubTaskId と afterSubTaskId はどちらか一方だけ必要です",
        });
      }
    }),
  z
    .object({
      kind: z.literal("cancel"),
      targetTaskId: TaskIdSchema,
      reason: NonEmptyStringSchema.max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dependency"),
      operation: z.enum(["add", "remove"]),
      taskId: TaskIdSchema,
      blockerTaskId: TaskIdSchema,
    })
    .strict()
    .refine((value) => value.taskId !== value.blockerTaskId, {
      message: "task は自身を blocker にできません",
    }),
]);
export const WorkGraphMutationIntentSchema: typeof WorkGraphMutationIntentSchemaValue =
  WorkGraphMutationIntentSchemaValue;

const MutationActorCommandBaseSchema = z
  .object({
    schemaVersion: z.literal(MUTATION_PROPOSAL_SCHEMA_VERSION),
    commandId: NonEmptyStringSchema.max(200),
    actor: MutationActorSchema,
  })
  .strict();

const ProposeCommandSchema = MutationActorCommandBaseSchema.extend({
  type: z.literal("propose"),
  originRunId: NonEmptyStringSchema,
  intent: WorkGraphMutationIntentSchema,
  evidence: z.array(MutationEvidenceSchema).max(MUTATION_PROPOSAL_MAX_EVIDENCE),
  expiresAt: z.string().datetime(),
}).strict();

const DecideCommandSchema = z
  .object({
    schemaVersion: z.literal(MUTATION_PROPOSAL_SCHEMA_VERSION),
    commandId: NonEmptyStringSchema.max(200),
    type: z.literal("decide"),
    proposalId: NonEmptyStringSchema,
    expectedRevision: z.number().int().positive(),
    approvalCommentRef: z
      .object({
        repository: NormalizedRepositorySchema,
        issueNumber: z.number().int().positive(),
        commentId: NonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();

const ApplyCommandSchema = MutationActorCommandBaseSchema.extend({
  type: z.literal("apply"),
  proposalId: NonEmptyStringSchema,
  expectedRevision: z.number().int().positive(),
}).strict();

const ReconcileCommandSchema = MutationActorCommandBaseSchema.extend({
  type: z.literal("reconcile"),
  proposalId: NonEmptyStringSchema,
  expectedRevision: z.number().int().positive(),
  stepId: NonEmptyStringSchema.optional(),
  evidence: MutationEvidenceSchema,
  resolution: z.enum(["confirm_committed", "confirm_not_started", "reopen_cancelled_task"]),
  beforeFingerprint: Sha256Schema.optional(),
  approvalCommentRef: z
    .object({
      repository: NormalizedRepositorySchema,
      issueNumber: z.number().int().positive(),
      commentId: NonEmptyStringSchema,
    })
    .strict()
    .optional(),
}).strict();

const ExpireCommandSchema = MutationActorCommandBaseSchema.extend({
  type: z.literal("expire"),
  proposalId: NonEmptyStringSchema,
  expectedRevision: z.number().int().positive(),
}).strict();

const SupersedeCommandSchema = MutationActorCommandBaseSchema.extend({
  type: z.literal("supersede"),
  proposalId: NonEmptyStringSchema,
  expectedRevision: z.number().int().positive(),
  successorProposalId: NonEmptyStringSchema,
}).strict();

const AcceptReplanCommandSchema = MutationActorCommandBaseSchema.extend({
  type: z.literal("accept_replan"),
  proposalId: NonEmptyStringSchema,
  expectedRevision: z.number().int().positive(),
  approvalCommentRef: z
    .object({
      repository: NormalizedRepositorySchema,
      issueNumber: z.number().int().positive(),
      commentId: NonEmptyStringSchema,
    })
    .strict(),
  successorPlanRevision: z
    .object({
      planId: NonEmptyStringSchema,
      fromVersion: NonEmptyStringSchema,
      proposedVersion: NonEmptyStringSchema,
      reasonProposalId: NonEmptyStringSchema,
    })
    .strict(),
  successorNodeId: NonEmptyStringSchema,
  targetRunId: NonEmptyStringSchema.optional(),
  targetProjectRoot: NonEmptyStringSchema.optional(),
}).strict();

const MutationProposalCommandSchemaValue: z.ZodType<MutationProposalCommand> = z.discriminatedUnion(
  "type",
  [
    ProposeCommandSchema,
    DecideCommandSchema,
    ApplyCommandSchema,
    ReconcileCommandSchema,
    ExpireCommandSchema,
    SupersedeCommandSchema,
    AcceptReplanCommandSchema,
  ],
);
export const MutationProposalCommandSchema: typeof MutationProposalCommandSchemaValue =
  MutationProposalCommandSchemaValue;

const MutationPrimitiveStepSchemaValue: z.ZodType<MutationPrimitiveStep> = z
  .object({
    stepId: NonEmptyStringSchema,
    operation: z.enum([
      "create",
      "update",
      "link",
      "reprioritize",
      "complete_close",
      "cancel",
      "recover_cancel",
    ]),
    targetTaskId: TaskIdSchema,
    payload: z.record(z.unknown()),
    beforeImage: z.record(z.unknown()).nullable(),
    expectedPostcondition: z.record(z.unknown()),
    state: z.enum(["not_started", "committed", "reconciled", "unknown"]),
    diagnostic: z.string().nullable(),
    remoteIdentifiers: z
      .object({
        issueId: NonEmptyStringSchema.optional(),
        issueNumber: z.number().int().positive().optional(),
        projectItemId: NonEmptyStringSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    localPreparation: z
      .object({
        sourceRevision: NonEmptyStringSchema,
        sourceFingerprint: Sha256Schema,
        preparedFingerprint: Sha256Schema,
        preparedAt: z.string().datetime(),
      })
      .strict()
      .nullable()
      .optional(),
    remoteExecution: z
      .object({
        state: z.literal("side_effect_in_flight"),
        ownerNonce: z.string().uuid(),
        fencingToken: z.number().int().positive(),
        startedAt: z.string().datetime(),
      })
      .strict()
      .nullable()
      .optional(),
    correlationToken: NonEmptyStringSchema.nullable(),
    recoveryIntent: z
      .object({
        kind: z.literal("reopen_cancelled_task"),
        beforeFingerprint: Sha256Schema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export const MutationPrimitiveStepSchema: typeof MutationPrimitiveStepSchemaValue =
  MutationPrimitiveStepSchemaValue;

const MutationApprovalSchemaValue: z.ZodType<MutationApproval> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("human"),
      actor: MutationActorSchema.refine((actor) => actor.role === "human"),
      evidenceId: NonEmptyStringSchema,
      decidedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("policy"),
      policyId: NonEmptyStringSchema,
      policyVersion: NonEmptyStringSchema,
      ruleId: NonEmptyStringSchema,
      evidenceId: NonEmptyStringSchema,
      decidedAt: z.string().datetime(),
    })
    .strict(),
]);
export const MutationApprovalSchema: typeof MutationApprovalSchemaValue =
  MutationApprovalSchemaValue;

const TaskDiffSchema: z.ZodType<MutationTaskDiff> = z
  .object({
    taskId: TaskIdSchema,
    before: z.record(z.unknown()).nullable(),
    after: z.record(z.unknown()).nullable(),
  })
  .strict();

const MutationProposalStatusSchemaValue: z.ZodType<MutationProposalStatus> = z.enum([
  "awaiting_human",
  "approved",
  "rejected",
  "expired",
  "superseded",
  "applying",
  "partially_applied",
  "reconciling",
  "pending_audit",
  "accepting_replan",
  "compensating",
  "applied",
  "compensated",
]);
export const MutationProposalStatusSchema: typeof MutationProposalStatusSchemaValue =
  MutationProposalStatusSchemaValue;

const MutationProposalSchemaValue: z.ZodType<MutationProposal> = z
  .object({
    schemaVersion: z.literal(MUTATION_PROPOSAL_SCHEMA_VERSION),
    proposalId: NonEmptyStringSchema,
    revision: z.number().int().positive(),
    status: MutationProposalStatusSchema,
    commandId: NonEmptyStringSchema,
    commandFingerprint: Sha256Schema,
    sourceRevision: NonEmptyStringSchema,
    snapshotFingerprint: Sha256Schema,
    proposeCoverageFingerprint: Sha256Schema,
    planFingerprint: Sha256Schema,
    policyFingerprint: Sha256Schema.nullable(),
    origin: MutationOriginSchema,
    intent: WorkGraphMutationIntentSchema,
    targetTaskIds: z.array(TaskIdSchema).min(1).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    evidence: z.array(MutationEvidenceSchema).max(MUTATION_PROPOSAL_MAX_EVIDENCE),
    diff: z.array(TaskDiffSchema).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    affectedUpstream: z.array(TaskIdSchema).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    affectedDownstream: z.array(TaskIdSchema).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    risk: z.enum(["low", "medium", "high", "destructive"]),
    proposedBy: MutationActorSchema,
    approval: MutationApprovalSchema.nullable(),
    approvalCommentRef: z
      .object({
        repository: NormalizedRepositorySchema,
        issueNumber: z.number().int().positive(),
        commentId: NonEmptyStringSchema,
      })
      .strict()
      .nullable(),
    trustedApproval: z
      .object({
        decision: z.enum(["approve", "reject"]),
        boundRevision: z.number().int().positive(),
        boundProposalFingerprint: Sha256Schema,
        boundExpiresAt: z.string().datetime(),
        boundPurpose: z.enum(["decision", "compensation", "replan"]),
        boundStepId: NonEmptyStringSchema.nullable(),
        boundTargetRunId: NonEmptyStringSchema.nullable(),
        boundTargetProjectRoot: NonEmptyStringSchema.nullable(),
        boundSuccessorDescriptorFingerprint: Sha256Schema.nullable(),
        authorNodeId: NonEmptyStringSchema,
        commentId: NonEmptyStringSchema,
        bodyHash: Sha256Schema,
        commentUpdatedAt: z.string().datetime(),
        authorityConfigFingerprint: Sha256Schema,
      })
      .strict()
      .nullable(),
    steps: z.array(MutationPrimitiveStepSchema).min(1).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    logicalTaskIds: z.record(z.string(), TaskIdSchema),
    successorProposalId: NonEmptyStringSchema.nullable(),
    applyCoverageFingerprint: Sha256Schema.nullable(),
    applyBaseline: z
      .object({
        sourceRevision: NonEmptyStringSchema,
        snapshotFingerprint: Sha256Schema,
        afterStepId: NonEmptyStringSchema,
      })
      .strict()
      .nullable(),
    invalidationTargets: z
      .array(
        z
          .object({
            workspaceId: NonEmptyStringSchema,
            projectRoot: NonEmptyStringSchema,
            runId: NonEmptyStringSchema,
            taskId: TaskIdSchema,
            planId: NonEmptyStringSchema,
            planVersion: NonEmptyStringSchema,
            schemaVersion: NonEmptyStringSchema,
            currentNodeId: NonEmptyStringSchema,
            successorPlanRevision: z
              .object({
                planId: NonEmptyStringSchema,
                fromVersion: NonEmptyStringSchema,
                proposedVersion: NonEmptyStringSchema,
                reasonProposalId: NonEmptyStringSchema,
              })
              .strict(),
          })
          .strict(),
      )
      .max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    pendingAuditEventIds: z.array(NonEmptyStringSchema).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    pendingAudits: z
      .array(
        z
          .object({
            eventId: NonEmptyStringSchema,
            proposalRevision: z.number().int().positive(),
            type: z.enum([
              "proposal_created",
              "proposal_approved",
              "proposal_rejected",
              "proposal_expired",
              "proposal_superseded",
              "proposal_apply_step",
              "proposal_applied",
              "proposal_reconciled",
              "proposal_compensated",
              "work_graph_invalidated",
            ]),
            actorId: NonEmptyStringSchema,
            actorRole: z.enum([
              "orchestrator",
              "planner",
              "implementer",
              "executor",
              "reviewer",
              "human",
            ]),
            occurredAt: z.string().datetime(),
            detail: z.record(z.unknown()),
          })
          .strict(),
      )
      .max(MUTATION_PROPOSAL_MAX_OPERATIONS * 4),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const MutationProposalSchema: typeof MutationProposalSchemaValue =
  MutationProposalSchemaValue;

const MutationProposalReceiptSchemaValue: z.ZodType<MutationProposalReceipt> = z
  .object({
    schemaVersion: z.literal(MUTATION_PROPOSAL_SCHEMA_VERSION),
    accepted: z.boolean(),
    commandId: NonEmptyStringSchema,
    commandFingerprint: Sha256Schema,
    proposalId: NonEmptyStringSchema.nullable(),
    revision: z.number().int().nonnegative(),
    status: MutationProposalStatusSchema.nullable(),
    stateUnchanged: z.boolean(),
    errorCode: z
      .enum([
        "invalid_command",
        "command_payload_mismatch",
        "proposal_not_found",
        "stale_revision",
        "unsupported_operation",
        "task_not_found",
        "invalid_task_type",
        "invalid_hierarchy",
        "dangling_reference",
        "dependency_cycle",
        "scope_drift",
        "sync_conflict",
        "review_gate",
        "human_gate_required",
        "active_claim",
        "unfinished_run",
        "run_state_unknown",
        "source_drift",
        "policy_drift",
        "origin_binding_drift",
        "active_attempt_conflict",
        "expired",
        "invalid_lifecycle",
        "partial_failure",
        "side_effect_unknown",
        "audit_pending",
      ])
      .nullable(),
    diagnostic: z.string().max(2_000).nullable(),
    remoteIdentifiers: z
      .object({
        issueId: NonEmptyStringSchema.optional(),
        issueNumber: z.number().int().positive().optional(),
        projectItemId: NonEmptyStringSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    changedTaskIds: z.array(TaskIdSchema).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    successorPlanRevision: z
      .object({
        planId: NonEmptyStringSchema,
        fromVersion: NonEmptyStringSchema,
        proposedVersion: NonEmptyStringSchema,
        reasonProposalId: NonEmptyStringSchema,
      })
      .strict()
      .nullable(),
    approvalRequest: z
      .object({ issueUrl: z.string().url(), machineBlock: NonEmptyStringSchema })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export const MutationProposalReceiptSchema: typeof MutationProposalReceiptSchemaValue =
  MutationProposalReceiptSchemaValue;

const MutationProposalSummarySchemaValue: z.ZodType<MutationProposalSummary> = z
  .object({
    proposalId: NonEmptyStringSchema,
    revision: z.number().int().positive(),
    status: MutationProposalStatusSchema,
    mutationKind: z.enum(["split", "add", "merge", "reorder", "cancel", "dependency"]),
    targetTaskIds: z.array(TaskIdSchema).max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    risk: z.enum(["low", "medium", "high", "destructive"]),
    proposedBy: MutationActorSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const MutationProposalSummarySchema: typeof MutationProposalSummarySchemaValue =
  MutationProposalSummarySchemaValue;

const MutationProposalViewSchemaValue: z.ZodType<MutationProposalView> = z
  .object({
    schemaVersion: z.literal(MUTATION_PROPOSAL_SCHEMA_VERSION),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(MUTATION_PROPOSAL_MAX_LIMIT),
    truncated: z.boolean(),
    items: z.array(MutationProposalSummarySchema),
  })
  .strict()
  .superRefine((view, context) => {
    if (view.items.length > view.limit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "items は limit 以下である必要があります",
      });
    }
    if (view.truncated !== view.total > view.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["truncated"],
        message: "truncated は total と items の差分を正確に表す必要があります",
      });
    }
  });
export const MutationProposalViewSchema: typeof MutationProposalViewSchemaValue =
  MutationProposalViewSchemaValue;

const MutationProposalFullViewSchemaValue: z.ZodType<MutationProposalFullView> = z
  .object({
    schemaVersion: z.literal(MUTATION_PROPOSAL_SCHEMA_VERSION),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(MUTATION_PROPOSAL_MAX_LIMIT),
    offset: z.number().int().nonnegative(),
    truncated: z.boolean(),
    items: z.array(MutationProposalSchema),
    approvalRequests: z.array(
      z
        .object({
          purpose: z.enum(["decision", "compensation", "replan"]),
          proposalId: NonEmptyStringSchema,
          revision: z.number().int().positive(),
          proposalFingerprint: Sha256Schema,
          expiresAt: z.string().datetime(),
          issueUrl: z.string().url(),
          machineBlock: NonEmptyStringSchema,
          stepId: NonEmptyStringSchema.optional(),
          targetRunId: NonEmptyStringSchema.optional(),
          targetProjectRoot: NonEmptyStringSchema.optional(),
          successorPlanRevision: z
            .object({
              planId: NonEmptyStringSchema,
              fromVersion: NonEmptyStringSchema,
              proposedVersion: NonEmptyStringSchema,
              reasonProposalId: NonEmptyStringSchema,
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((view, context) => {
    if (view.items.length > view.limit) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "limit 超過です" });
    }
    if (view.truncated !== view.offset + view.items.length < view.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["truncated"],
        message: "truncated が pagination と一致しません",
      });
    }
  });
export const MutationProposalFullViewSchema: typeof MutationProposalFullViewSchemaValue =
  MutationProposalFullViewSchemaValue;

const MutationProposalInspectQuerySchemaValue: z.ZodType<
  Required<Pick<MutationProposalInspectQuery, "full" | "limit" | "offset">> &
    Pick<MutationProposalInspectQuery, "proposalId">,
  z.ZodTypeDef,
  MutationProposalInspectQuery
> = z
  .object({
    proposalId: NonEmptyStringSchema.optional(),
    full: z.boolean().default(false),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MUTATION_PROPOSAL_MAX_LIMIT)
      .default(MUTATION_PROPOSAL_DEFAULT_LIMIT),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
export const MutationProposalInspectQuerySchema: typeof MutationProposalInspectQuerySchemaValue =
  MutationProposalInspectQuerySchemaValue;

const MutationPolicyRuleSchema: z.ZodType<MutationPolicyRule> = z
  .object({
    id: NonEmptyStringSchema,
    mutation_kinds: z.array(z.enum(["split", "add", "merge", "reorder", "dependency"])).min(1),
    repositories: z.array(NormalizedRepositorySchema).min(1),
    root_task_ids: z.array(TaskIdSchema).min(1),
    task_types: z.array(NonEmptyStringSchema).min(1),
    max_operations: z.number().int().positive().max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    max_affected_tasks: z.number().int().positive().max(MUTATION_PROPOSAL_MAX_OPERATIONS),
    max_risk: z.enum(["low", "medium", "high"]),
  })
  .strict();

const MutationPolicyConfigSchemaValue: z.ZodType<MutationPolicyConfig | undefined> = z
  .object({
    schema_version: z.literal("1"),
    policy_id: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    rules: z.array(MutationPolicyRuleSchema).min(1).max(50),
  })
  .strict()
  .optional();
export const MutationPolicyConfigSchema: typeof MutationPolicyConfigSchemaValue =
  MutationPolicyConfigSchemaValue;

const MutationApprovalConfigSchemaValue: z.ZodType<MutationApprovalConfig | undefined> = z
  .object({
    schema_version: z.literal("1"),
    source: z.literal("github_issue_comment"),
    allowed_author_node_ids: z.array(NonEmptyStringSchema).min(1).max(100),
  })
  .strict()
  .optional();
export const MutationApprovalConfigSchema: typeof MutationApprovalConfigSchemaValue =
  MutationApprovalConfigSchemaValue;

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f));
    else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >>> 12), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >>> 18),
        0x80 | ((point >>> 12) & 0x3f),
        0x80 | ((point >>> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

/** browserとNodeのどちらでも同じ値を返す同期SHA-256。 */
function sha256(value: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));
  const schedule = Array.from({ length: 64 }, () => 0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      schedule[index] =
        ((bytes[start]! << 24) |
          (bytes[start + 1]! << 16) |
          (bytes[start + 2]! << 8) |
          bytes[start + 3]!) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = schedule[index - 15]!;
      const right = schedule[index - 2]!;
      const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
      const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
      schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const first = (h! + sum1 + choose + constants[index]! + schedule[index]!) >>> 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** 正準JSONのSHA-256。鍵順やlocaleへ依存せず、command retry identityに使う。 */
export function mutationCommandFingerprint(command: unknown): string {
  return sha256(canonicalJsonStringify(command));
}
