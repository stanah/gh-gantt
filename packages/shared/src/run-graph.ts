import { z } from "zod";

export const RUN_GRAPH_ROLES = [
  "orchestrator",
  "planner",
  "implementer",
  "executor",
  "reviewer",
  "human",
] as const;

export type RunGraphRole = (typeof RUN_GRAPH_ROLES)[number];

export interface RunGraphConfig {
  plan_id: string;
  plan_version: string;
  schema_version: string;
}

export const RunGraphConfigSchema: z.ZodType<RunGraphConfig> = z
  .object({
    plan_id: z.string().min(1),
    plan_version: z.string().min(1),
    schema_version: z.string().min(1),
  })
  .strict();

export interface GraphContractRole {
  id: RunGraphRole;
}

export interface GraphContractNode {
  id: string;
  role: RunGraphRole;
  inputArtifactSchemas: string[];
  outputArtifactSchemas: string[];
}

export interface GraphContractEdge {
  id: string;
  from: string;
  to: string;
  condition: string;
}

export interface GraphContractArtifactSchema {
  id: string;
  version: string;
}

export interface GraphContractAuthority {
  action: string;
  roles: RunGraphRole[];
}

export interface GraphContract {
  schemaVersion: "1";
  planId: string;
  planVersion: string;
  roles: GraphContractRole[];
  nodes: GraphContractNode[];
  edges: GraphContractEdge[];
  artifactSchemas: GraphContractArtifactSchema[];
  evidenceKinds: string[];
  authorities: GraphContractAuthority[];
  budgets: {
    maxExecutorRetries: number;
    maxImprovementIterations: number;
  };
  humanGate: {
    approvalRoles: RunGraphRole[];
    overrideRequiresReason: boolean;
  };
}

const RoleSchema = z.enum(RUN_GRAPH_ROLES);

export const GraphContractSchema: z.ZodType<GraphContract> = z
  .object({
    schemaVersion: z.literal("1"),
    planId: z.string().min(1),
    planVersion: z.string().min(1),
    roles: z.array(z.object({ id: RoleSchema })).min(1),
    nodes: z
      .array(
        z.object({
          id: z.string().min(1),
          role: RoleSchema,
          inputArtifactSchemas: z.array(z.string().min(1)),
          outputArtifactSchemas: z.array(z.string().min(1)),
        }),
      )
      .min(1),
    edges: z.array(
      z.object({
        id: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        condition: z.string().min(1),
      }),
    ),
    artifactSchemas: z.array(z.object({ id: z.string().min(1), version: z.string().min(1) })),
    evidenceKinds: z.array(z.string().min(1)),
    authorities: z.array(
      z.object({ action: z.string().min(1), roles: z.array(RoleSchema).min(1) }),
    ),
    budgets: z.object({
      maxExecutorRetries: z.number().int().nonnegative(),
      maxImprovementIterations: z.number().int().nonnegative(),
    }),
    humanGate: z.object({
      approvalRoles: z.array(RoleSchema).min(1),
      overrideRequiresReason: z.boolean(),
    }),
  })
  .superRefine((contract, context) => {
    const roleIds = new Set(contract.roles.map((role) => role.id));
    const nodeIds = new Set(contract.nodes.map((node) => node.id));
    const artifactSchemas = new Set(
      contract.artifactSchemas.map((schema) => `${schema.id}@${schema.version}`),
    );
    const unique = (values: string[], path: string) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} は一意である必要があります`,
        });
      }
    };
    unique(
      contract.roles.map((role) => role.id),
      "roles",
    );
    unique(
      contract.nodes.map((node) => node.id),
      "nodes",
    );
    unique(
      contract.edges.map((edge) => edge.id),
      "edges",
    );
    unique(
      contract.artifactSchemas.map((schema) => `${schema.id}@${schema.version}`),
      "artifactSchemas",
    );
    unique(contract.evidenceKinds, "evidenceKinds");
    unique(
      contract.authorities.map((authority) => authority.action),
      "authorities",
    );
    for (const [index, node] of contract.nodes.entries()) {
      if (
        !roleIds.has(node.role) ||
        [...node.inputArtifactSchemas, ...node.outputArtifactSchemas].some(
          (schema) => !artifactSchemas.has(schema),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index],
          message: "node が未定義 role または artifact schema を参照しています",
        });
      }
    }
    for (const [index, edge] of contract.edges.entries()) {
      if (!nodeIds.has(edge.from) || (edge.to !== "terminal" && !nodeIds.has(edge.to))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "edge が未定義 node を参照しています",
        });
      }
    }
    if (
      contract.authorities.some((authority) =>
        authority.roles.some((role) => !roleIds.has(role)),
      ) ||
      contract.humanGate.approvalRoles.some((role) => !roleIds.has(role))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorities"],
        message: "authority が未定義 role を参照しています",
      });
    }
  });

export const FIXED_DEV_ROLE_GRAPH_CONTRACT: GraphContract = {
  schemaVersion: "1",
  planId: "dev-role-fixed",
  planVersion: "1",
  roles: RUN_GRAPH_ROLES.map((id) => ({ id })),
  nodes: [
    {
      id: "planner",
      role: "planner",
      inputArtifactSchemas: [],
      outputArtifactSchemas: ["dev-role.plan@1"],
    },
    {
      id: "implementer",
      role: "implementer",
      inputArtifactSchemas: ["dev-role.plan@1", "dev-role.review@1"],
      outputArtifactSchemas: ["dev-role.implementation@1"],
    },
    {
      id: "executor",
      role: "executor",
      inputArtifactSchemas: ["dev-role.implementation@1"],
      outputArtifactSchemas: ["dev-role.verify@1"],
    },
    {
      id: "reviewer",
      role: "reviewer",
      inputArtifactSchemas: ["dev-role.plan@1", "dev-role.implementation@1", "dev-role.verify@1"],
      outputArtifactSchemas: ["dev-role.review@1"],
    },
    {
      id: "human-pr",
      role: "human",
      inputArtifactSchemas: ["dev-role.review@1"],
      outputArtifactSchemas: ["github.pr-live@1"],
    },
  ],
  edges: [
    { id: "plan-valid", from: "planner", to: "implementer", condition: "plan_valid" },
    { id: "plan-invalid", from: "planner", to: "human-pr", condition: "plan_invalid" },
    {
      id: "implementation-valid",
      from: "implementer",
      to: "executor",
      condition: "implementation_valid",
    },
    {
      id: "implementation-invalid",
      from: "implementer",
      to: "human-pr",
      condition: "implementation_invalid",
    },
    { id: "verify-passed", from: "executor", to: "reviewer", condition: "verify_passed" },
    { id: "verify-retry", from: "executor", to: "implementer", condition: "verify_failed" },
    {
      id: "verify-budget-exhausted",
      from: "executor",
      to: "human-pr",
      condition: "verify_budget_exhausted",
    },
    { id: "review-approved", from: "reviewer", to: "human-pr", condition: "approve" },
    { id: "review-comment", from: "reviewer", to: "human-pr", condition: "comment" },
    {
      id: "review-improve",
      from: "reviewer",
      to: "implementer",
      condition: "request_changes",
    },
    {
      id: "review-budget-exhausted",
      from: "reviewer",
      to: "human-pr",
      condition: "review_budget_exhausted",
    },
    { id: "review-blocked", from: "reviewer", to: "human-pr", condition: "block" },
    { id: "review-critical", from: "reviewer", to: "human-pr", condition: "critical" },
    { id: "planner-human-override", from: "planner", to: "planner", condition: "human_override" },
    {
      id: "implementer-human-override",
      from: "implementer",
      to: "implementer",
      condition: "human_override",
    },
    {
      id: "executor-human-override",
      from: "executor",
      to: "executor",
      condition: "human_override",
    },
    {
      id: "reviewer-human-override",
      from: "reviewer",
      to: "reviewer",
      condition: "human_override",
    },
    {
      id: "human-pr-override",
      from: "human-pr",
      to: "implementer",
      condition: "human_override",
    },
    { id: "pr-completed", from: "human-pr", to: "terminal", condition: "pr_completed" },
  ],
  artifactSchemas: [
    { id: "dev-role.plan", version: "1" },
    { id: "dev-role.implementation", version: "1" },
    { id: "dev-role.verify", version: "1" },
    { id: "dev-role.review", version: "1" },
    { id: "github.pr-live", version: "1" },
    { id: "run.checkpoint", version: "1" },
  ],
  evidenceKinds: [
    "artifact_validation",
    "command_execution",
    "independent_review",
    "github_pr_live",
    "human_decision",
    "checkpoint",
    "side_effect_reconciliation",
  ],
  authorities: [
    { action: "run_start", roles: ["orchestrator"] },
    { action: "node_attempt", roles: ["planner", "implementer", "executor", "reviewer"] },
    {
      action: "run_checkpoint",
      roles: ["orchestrator", "planner", "implementer", "executor", "reviewer"],
    },
    { action: "human_decision", roles: ["human"] },
    { action: "pr_observe", roles: ["orchestrator", "human"] },
  ],
  budgets: { maxExecutorRetries: 2, maxImprovementIterations: 3 },
  humanGate: { approvalRoles: ["human"], overrideRequiresReason: true },
};

export const RUN_GRAPH_RUN_STATES = [
  "pending",
  "running",
  "paused",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
] as const;

export const RUN_GRAPH_NODE_STATES = [
  "pending",
  "ready",
  "running",
  "paused",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
] as const;

export const RUN_GRAPH_ATTEMPT_STATES = [
  "created",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "cancelled",
] as const;

export type RunGraphRunState = (typeof RUN_GRAPH_RUN_STATES)[number];
export type RunGraphNodeState = (typeof RUN_GRAPH_NODE_STATES)[number];
export type RunGraphAttemptState = (typeof RUN_GRAPH_ATTEMPT_STATES)[number];

export interface RunGraphActor {
  id: string;
  role: RunGraphRole;
}

export interface BoundedRunGraphReference {
  kind: "workspace" | "github" | "command";
  uri: string;
  sha256: string;
  byteLength: number;
}

export interface RunGraphRun {
  id: string;
  state: RunGraphRunState;
  task: { owner: string; repo: string; issueNumber: number };
  contract: { planId: string; planVersion: string; schemaVersion: string };
  actor: RunGraphActor;
  createdAt: string;
  updatedAt: string;
  currentNodeId: string | null;
  parentRunId: string | null;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
}

export interface RunGraphNode {
  id: string;
  runId: string;
  contractNodeId: string;
  state: RunGraphNodeState;
  actor: RunGraphActor;
  createdAt: string;
  updatedAt: string;
  activeAttemptId: string | null;
  previousNodeId: string | null;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
}

export interface RunGraphAttempt {
  id: string;
  runId: string;
  nodeId: string;
  ordinal: number;
  state: RunGraphAttemptState;
  actor: RunGraphActor;
  createdAt: string;
  updatedAt: string;
  previousAttemptId: string | null;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
}

export interface RunGraphArtifact {
  id: string;
  runId: string;
  nodeId: string;
  producerAttemptId: string;
  schemaId: string;
  schemaVersion: string;
  actor: RunGraphActor;
  createdAt: string;
  derivedFromArtifactIds: string[];
  reference: BoundedRunGraphReference;
}

export interface RunGraphEvidence {
  id: string;
  runId: string;
  nodeId: string | null;
  producerAttemptId: string | null;
  kind: string;
  actor: RunGraphActor;
  createdAt: string;
  artifactIds: string[];
  provenance: string;
  reference: BoundedRunGraphReference;
}

/** 外部 runner が artifact 本文を複製せず control plane へ渡す登録情報。 */
export interface RunGraphArtifactSubmission {
  id: string;
  schemaId: string;
  schemaVersion: string;
  derivedFromArtifactIds: string[];
  reference: BoundedRunGraphReference;
}

/** 外部 runner が transition guard の根拠として渡す登録情報。 */
export interface RunGraphEvidenceSubmission {
  id: string;
  kind: string;
  artifactIds: string[];
  provenance: string;
  reference: BoundedRunGraphReference;
}

/** repository coordination registry が発行する current claim の fencing proof。 */
export interface DispatchClaimProof {
  claimId: string;
  fencingToken: number;
  ownerId: string;
  runId: string;
}

/** isolated workspace に対する期限付き claim。 */
export interface DispatchClaim {
  taskId: string;
  repository: string;
  state: string;
  ownerId: string;
  workspaceId: string;
  runId: string;
  claimId: string;
  entityVersion: number;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  dispatchPlanId: string;
  dispatchPlanVersion: "1";
}

export type DispatchClaimOperation =
  | "claim"
  | "heartbeat"
  | "release"
  | "reclaim"
  | "authorize_event";
export type DispatchClaimRejectionCode =
  | "event_payload_mismatch"
  | "stale_entity_version"
  | "dispatch_not_configured"
  | "unknown_state"
  | "global_capacity"
  | "state_capacity"
  | "repository_capacity"
  | "task_already_claimed"
  | "workspace_already_claimed"
  | "claim_not_found"
  | "stale_claim"
  | "authorization_pending"
  | "snapshot_mismatch"
  | "lease_expired"
  | "lease_not_expired";

interface DispatchClaimAcceptedReceiptBase {
  accepted: true;
  eventId: string;
  entityVersion: number;
  stateUnchanged: false;
  claim: DispatchClaim;
}

export type DispatchClaimAcceptedReceipt =
  | (DispatchClaimAcceptedReceiptBase & { operation: "claim" })
  | (DispatchClaimAcceptedReceiptBase & { operation: "heartbeat" })
  | (DispatchClaimAcceptedReceiptBase & { operation: "release" })
  | (DispatchClaimAcceptedReceiptBase & {
      operation: "reclaim";
      reclaimReason: "expired";
    })
  | (DispatchClaimAcceptedReceiptBase & {
      operation: "reclaim";
      reclaimReason: "owner_stopped";
      evidenceId: string;
    })
  | (DispatchClaimAcceptedReceiptBase & {
      operation: "authorize_event";
      completion: DispatchCompletionAuthorization;
      claimContinues: boolean;
    });

export type DispatchClaimReceipt =
  | DispatchClaimAcceptedReceipt
  | {
      accepted: false;
      operation: DispatchClaimOperation;
      eventId: string;
      entityVersion: number;
      stateUnchanged: true;
      code: DispatchClaimRejectionCode;
      message: string;
    };

export const RUN_GRAPH_CLAIM_AUDIT_TYPES = [
  "claim_acquired",
  "claim_heartbeat",
  "claim_released",
  "claim_reclaimed",
  "claim_event_authorized",
] as const;

export interface DispatchCompletionAuthorization {
  runId: string;
  taskId: string;
  actorId: string;
  commandFingerprint: string;
}

export interface RunGraphClaimAuditCommand {
  type: (typeof RUN_GRAPH_CLAIM_AUDIT_TYPES)[number];
  registryEventId: string;
  registryEntityVersion: number;
  claim: DispatchClaim;
  reclaimReason?: "expired" | "owner_stopped";
  evidenceId?: string;
  completion?: DispatchCompletionAuthorization;
}

export interface RunGraphClaimAuditInput {
  schemaVersion: "1";
  eventId: string;
  actor: RunGraphActor;
  receipt: Extract<DispatchClaimReceipt, { accepted: true }> & { claim: DispatchClaim };
}

export interface DispatchClaimAcquireInput {
  schemaVersion: "1";
  eventId: string;
  expectedEntityVersion: number;
  taskId: string;
  repository: string;
  state: string;
  ownerId: string;
  workspaceId: string;
  runId: string;
  leaseDurationSeconds: number;
  dispatchPlanId: string;
  dispatchPlanVersion: "1";
  snapshotFingerprint: string;
}

export interface DispatchClaimHeartbeatInput {
  schemaVersion: "1";
  eventId: string;
  expectedEntityVersion: number;
  proof: DispatchClaimProof;
  leaseDurationSeconds: number;
}

export interface DispatchClaimReleaseInput {
  schemaVersion: "1";
  eventId: string;
  expectedEntityVersion: number;
  proof: DispatchClaimProof;
}

export interface DispatchClaimReclaimInput {
  schemaVersion: "1";
  eventId: string;
  expectedEntityVersion: number;
  claimId: string;
  reason: "expired" | "owner_stopped";
  ownerStoppedEvidenceId?: string;
}

export interface DispatchClaimEventAuthorizationInput {
  schemaVersion: "1";
  eventId: string;
  expectedEntityVersion: number;
  proof: DispatchClaimProof;
  runId: string;
  taskId: string;
  actorId: string;
  commandFingerprint: string;
}

export const DispatchClaimProofSchema: z.ZodType<DispatchClaimProof> = z
  .object({
    claimId: z.string().trim().min(1),
    fencingToken: z.number().int().positive(),
    ownerId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
  })
  .strict();

export const DispatchClaimSchema: z.ZodType<DispatchClaim> = z
  .object({
    taskId: z.string().trim().min(1),
    repository: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    state: z.string().trim().min(1),
    ownerId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    claimId: z.string().trim().min(1),
    entityVersion: z.number().int().positive(),
    fencingToken: z.number().int().positive(),
    acquiredAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    dispatchPlanId: z.string().trim().min(1),
    dispatchPlanVersion: z.literal("1"),
  })
  .strict();

const DispatchClaimInputBaseSchema = z.object({
  schemaVersion: z.literal("1"),
  eventId: z.string().trim().min(1),
  expectedEntityVersion: z.number().int().nonnegative(),
});

export const DispatchClaimAcquireInputSchema: z.ZodType<DispatchClaimAcquireInput> =
  DispatchClaimInputBaseSchema.extend({
    taskId: z.string().trim().min(1),
    repository: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toLowerCase()),
    state: z.string().trim().min(1),
    ownerId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    leaseDurationSeconds: z.number().int().min(5).max(86_400),
    dispatchPlanId: z.string().trim().min(1),
    dispatchPlanVersion: z.literal("1"),
    snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict();

export const DispatchClaimHeartbeatInputSchema: z.ZodType<DispatchClaimHeartbeatInput> =
  DispatchClaimInputBaseSchema.extend({
    proof: DispatchClaimProofSchema,
    leaseDurationSeconds: z.number().int().min(5).max(86_400),
  }).strict();

export const DispatchClaimReleaseInputSchema: z.ZodType<DispatchClaimReleaseInput> =
  DispatchClaimInputBaseSchema.extend({ proof: DispatchClaimProofSchema }).strict();

export const DispatchClaimReclaimInputSchema: z.ZodType<DispatchClaimReclaimInput> =
  DispatchClaimInputBaseSchema.extend({
    claimId: z.string().trim().min(1),
    reason: z.enum(["expired", "owner_stopped"]),
    ownerStoppedEvidenceId: z.string().trim().min(1).optional(),
  })
    .strict()
    .superRefine((input, context) => {
      if (input.reason === "owner_stopped" && !input.ownerStoppedEvidenceId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ownerStoppedEvidenceId"],
          message: "owner_stopped reclaim には停止 evidence ID が必要です",
        });
      }
      if (input.reason === "expired" && input.ownerStoppedEvidenceId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ownerStoppedEvidenceId"],
          message: "expired reclaim に owner 停止 evidence は指定できません",
        });
      }
    });

export const DispatchClaimEventAuthorizationInputSchema: z.ZodType<DispatchClaimEventAuthorizationInput> =
  DispatchClaimInputBaseSchema.extend({
    proof: DispatchClaimProofSchema,
    runId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    actorId: z.string().trim().min(1),
    commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict();

const DispatchCompletionAuthorizationSchema: z.ZodType<DispatchCompletionAuthorization> = z
  .object({
    runId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    actorId: z.string().trim().min(1),
    commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const DispatchClaimAcceptedReceiptBaseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string().trim().min(1),
  entityVersion: z.number().int().nonnegative(),
  stateUnchanged: z.literal(false),
  claim: DispatchClaimSchema,
});

const DispatchClaimAcceptedReceiptSchema: z.ZodType<DispatchClaimAcceptedReceipt> = z.union([
  DispatchClaimAcceptedReceiptBaseSchema.extend({ operation: z.literal("claim") }).strict(),
  DispatchClaimAcceptedReceiptBaseSchema.extend({ operation: z.literal("heartbeat") }).strict(),
  DispatchClaimAcceptedReceiptBaseSchema.extend({ operation: z.literal("release") }).strict(),
  DispatchClaimAcceptedReceiptBaseSchema.extend({
    operation: z.literal("reclaim"),
    reclaimReason: z.literal("expired"),
  }).strict(),
  DispatchClaimAcceptedReceiptBaseSchema.extend({
    operation: z.literal("reclaim"),
    reclaimReason: z.literal("owner_stopped"),
    evidenceId: z.string().trim().min(1),
  }).strict(),
  DispatchClaimAcceptedReceiptBaseSchema.extend({
    operation: z.literal("authorize_event"),
    completion: DispatchCompletionAuthorizationSchema,
    claimContinues: z.boolean(),
  }).strict(),
]);

const DispatchClaimRejectedReceiptSchema = z
  .object({
    accepted: z.literal(false),
    operation: z.enum(["claim", "heartbeat", "release", "reclaim", "authorize_event"]),
    eventId: z.string().trim().min(1),
    entityVersion: z.number().int().nonnegative(),
    stateUnchanged: z.literal(true),
    code: z.enum([
      "event_payload_mismatch",
      "stale_entity_version",
      "dispatch_not_configured",
      "unknown_state",
      "global_capacity",
      "state_capacity",
      "repository_capacity",
      "task_already_claimed",
      "workspace_already_claimed",
      "claim_not_found",
      "stale_claim",
      "authorization_pending",
      "snapshot_mismatch",
      "lease_expired",
      "lease_not_expired",
    ]),
    message: z.string().trim().min(1),
  })
  .strict();

export const DispatchClaimReceiptSchema: z.ZodType<DispatchClaimReceipt> = z.union([
  DispatchClaimAcceptedReceiptSchema,
  DispatchClaimRejectedReceiptSchema,
]);

export const RunGraphClaimAuditCommandSchema: z.ZodType<RunGraphClaimAuditCommand> = z
  .object({
    type: z.enum(RUN_GRAPH_CLAIM_AUDIT_TYPES),
    registryEventId: z.string().trim().min(1),
    registryEntityVersion: z.number().int().positive(),
    claim: DispatchClaimSchema,
    reclaimReason: z.enum(["expired", "owner_stopped"]).optional(),
    evidenceId: z.string().trim().min(1).optional(),
    completion: DispatchCompletionAuthorizationSchema.optional(),
  })
  .strict();

export const RunGraphClaimAuditInputSchema: z.ZodType<RunGraphClaimAuditInput> = z
  .object({
    schemaVersion: z.literal("1"),
    eventId: z.string().trim().min(1),
    actor: z.object({ id: z.string().min(1).max(200), role: z.enum(RUN_GRAPH_ROLES) }).strict(),
    receipt: DispatchClaimAcceptedReceiptSchema,
  })
  .strict();

const OpaqueIdSchema = z.string().min(1).max(200);
const TimestampSchema = z.string().datetime({ offset: true });
const ArtifactIdListSchema = z.array(OpaqueIdSchema);

export const RunGraphActorSchema: z.ZodType<RunGraphActor> = z
  .object({
    id: OpaqueIdSchema,
    role: RoleSchema,
  })
  .strict();

export const BoundedRunGraphReferenceSchema: z.ZodType<BoundedRunGraphReference> = z
  .object({
    kind: z.enum(["workspace", "github", "command"]),
    uri: z.string().min(1).max(4096),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export const RunGraphRunSchema: z.ZodType<RunGraphRun> = z
  .object({
    id: OpaqueIdSchema,
    state: z.enum(RUN_GRAPH_RUN_STATES),
    task: z
      .object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        issueNumber: z.number().int().positive(),
      })
      .strict(),
    contract: z
      .object({
        planId: z.string().min(1),
        planVersion: z.string().min(1),
        schemaVersion: z.string().min(1),
      })
      .strict(),
    actor: RunGraphActorSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    currentNodeId: OpaqueIdSchema.nullable(),
    parentRunId: OpaqueIdSchema.nullable(),
    inputArtifactIds: ArtifactIdListSchema,
    outputArtifactIds: ArtifactIdListSchema,
  })
  .strict();

export const RunGraphNodeSchema: z.ZodType<RunGraphNode> = z
  .object({
    id: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    contractNodeId: OpaqueIdSchema,
    state: z.enum(RUN_GRAPH_NODE_STATES),
    actor: RunGraphActorSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    activeAttemptId: OpaqueIdSchema.nullable(),
    previousNodeId: OpaqueIdSchema.nullable(),
    inputArtifactIds: ArtifactIdListSchema,
    outputArtifactIds: ArtifactIdListSchema,
  })
  .strict();

export const RunGraphAttemptSchema: z.ZodType<RunGraphAttempt> = z
  .object({
    id: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    nodeId: OpaqueIdSchema,
    ordinal: z.number().int().positive(),
    state: z.enum(RUN_GRAPH_ATTEMPT_STATES),
    actor: RunGraphActorSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    previousAttemptId: OpaqueIdSchema.nullable(),
    inputArtifactIds: ArtifactIdListSchema,
    outputArtifactIds: ArtifactIdListSchema,
  })
  .strict();

export const RunGraphArtifactSchema: z.ZodType<RunGraphArtifact> = z
  .object({
    id: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    nodeId: OpaqueIdSchema,
    producerAttemptId: OpaqueIdSchema,
    schemaId: z.string().min(1),
    schemaVersion: z.string().min(1),
    actor: RunGraphActorSchema,
    createdAt: TimestampSchema,
    derivedFromArtifactIds: ArtifactIdListSchema,
    reference: BoundedRunGraphReferenceSchema,
  })
  .strict();

export const RunGraphEvidenceSchema: z.ZodType<RunGraphEvidence> = z
  .object({
    id: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    nodeId: OpaqueIdSchema.nullable(),
    producerAttemptId: OpaqueIdSchema.nullable(),
    kind: z.string().min(1),
    actor: RunGraphActorSchema,
    createdAt: TimestampSchema,
    artifactIds: ArtifactIdListSchema,
    provenance: z.string().min(1).max(1000),
    reference: BoundedRunGraphReferenceSchema,
  })
  .strict();

export const RunGraphArtifactSubmissionSchema: z.ZodType<RunGraphArtifactSubmission> = z
  .object({
    id: OpaqueIdSchema,
    schemaId: z.string().min(1),
    schemaVersion: z.string().min(1),
    derivedFromArtifactIds: ArtifactIdListSchema,
    reference: BoundedRunGraphReferenceSchema,
  })
  .strict();

export const RunGraphEvidenceSubmissionSchema: z.ZodType<RunGraphEvidenceSubmission> = z
  .object({
    id: OpaqueIdSchema,
    kind: z.string().min(1),
    artifactIds: ArtifactIdListSchema,
    provenance: z.string().min(1).max(1000),
    reference: BoundedRunGraphReferenceSchema,
  })
  .strict();

export const RUN_GRAPH_RUNNER_COMMAND_TYPES = [
  "attempt_started",
  "attempt_finished",
  "node_outcome_submitted",
  "run_paused",
  "run_resumed",
  "human_decision",
  "pr_observed",
] as const;

export type RunGraphRunnerCommandType = (typeof RUN_GRAPH_RUNNER_COMMAND_TYPES)[number];

export type RunGraphRunnerCommand =
  | { type: "attempt_started"; nodeId: string; attemptId: string }
  | {
      type: "attempt_finished";
      nodeId: string;
      attemptId: string;
      outcome: "succeeded" | "failed" | "timed_out" | "stalled" | "cancelled";
      artifactIds: string[];
      evidenceIds: string[];
    }
  | {
      type: "node_outcome_submitted";
      nodeId: string;
      attemptId: string;
      outcome: string;
      artifactIds: string[];
      evidenceIds: string[];
    }
  | {
      type: "run_paused";
      checkpointArtifactId: string;
      evidenceIds: string[];
      reason: string;
    }
  | {
      type: "run_resumed";
      checkpointArtifactId: string;
      evidenceIds: string[];
      sideEffectState: "not_started" | "committed" | "reconciled" | "unknown";
    }
  | {
      type: "human_decision";
      decision: "approved" | "rejected" | "override";
      reason: string | null;
      evidenceIds: string[];
    }
  | {
      type: "pr_observed";
      repository: string;
      pullRequestNumber: number;
      state: "open" | "merged" | "closed";
      isDraft: boolean;
      linkedIssue: { owner: string; repo: string; issueNumber: number } | null;
      linkageComplete: boolean;
      evidenceIds: string[];
    };

export interface RunGraphRunnerCommandInput {
  schemaVersion: "1";
  eventId: string;
  runId: string;
  actor: RunGraphActor;
  command: RunGraphRunnerCommand;
  artifacts?: RunGraphArtifactSubmission[];
  evidence?: RunGraphEvidenceSubmission[];
}

export interface RunGraphStartInput {
  schemaVersion: "1";
  eventId: string;
  actor: RunGraphActor;
  task: { owner: string; repo: string; issueNumber: number };
  contract: { planId: string; planVersion: string; schemaVersion: string };
}

export interface RunGraphStartedCommand {
  type: "run_started";
  task: RunGraphStartInput["task"];
  contract: RunGraphStartInput["contract"];
  firstNodeId: string;
}

export type RunGraphAcceptedCommand =
  | RunGraphStartedCommand
  | RunGraphRunnerCommand
  | RunGraphClaimAuditCommand;

/** crash 後も exact completion だけを識別する immutable claim authorization binding。 */
export interface RunGraphDispatchAuthorizationBinding {
  claimId: string;
  fencingToken: number;
  ownerId: string;
  runId: string;
  taskId: string;
  commandFingerprint: string;
}

export interface RunGraphAcceptedEvent {
  recordType: "accepted";
  eventId: string;
  sequence: number;
  runId: string;
  acceptedAt: string;
  actor: RunGraphActor;
  command: RunGraphAcceptedCommand;
  artifactIds: string[];
  evidenceIds: string[];
  artifacts?: RunGraphArtifact[];
  evidence?: RunGraphEvidence[];
  dispatchAuthorization?: RunGraphDispatchAuthorizationBinding;
  nextNodeId?: string;
  nextContractNodeId?: string;
  waitReason?: string;
}

export const RUN_GRAPH_REJECTION_CODES = [
  "duplicate_event",
  "invalid_transition",
  "stale_attempt",
  "artifact_schema_mismatch",
  "unsupported_contract_binding",
  "authority_denied",
  "evidence_required",
  "pr_not_linked_to_task",
  "github_live_state_unavailable",
  "stale_claim",
] as const;

export type RunGraphRejectionCode = (typeof RUN_GRAPH_REJECTION_CODES)[number];

export interface RunGraphRejection {
  recordType: "rejected";
  rejectionId: string;
  eventId: string;
  runId: string;
  rejectedAt: string;
  actor: RunGraphActor;
  command: RunGraphRunnerCommand;
  code: RunGraphRejectionCode;
  message: string;
  stateUnchanged: true;
}

export interface RunGraphJournal {
  schemaVersion: "1";
  runId: string;
  acceptedEvents: RunGraphAcceptedEvent[];
  rejections: RunGraphRejection[];
}

const AttemptStartedCommandSchema = z
  .object({
    type: z.literal("attempt_started"),
    nodeId: OpaqueIdSchema,
    attemptId: OpaqueIdSchema,
  })
  .strict();

const AttemptFinishedCommandSchema = z
  .object({
    type: z.literal("attempt_finished"),
    nodeId: OpaqueIdSchema,
    attemptId: OpaqueIdSchema,
    outcome: z.enum(["succeeded", "failed", "timed_out", "stalled", "cancelled"]),
    artifactIds: ArtifactIdListSchema,
    evidenceIds: z.array(OpaqueIdSchema),
  })
  .strict();

const NodeOutcomeSubmittedCommandSchema = z
  .object({
    type: z.literal("node_outcome_submitted"),
    nodeId: OpaqueIdSchema,
    attemptId: OpaqueIdSchema,
    outcome: z.string().min(1).max(200),
    artifactIds: ArtifactIdListSchema,
    evidenceIds: z.array(OpaqueIdSchema),
  })
  .strict();

const RunPausedCommandSchema = z
  .object({
    type: z.literal("run_paused"),
    checkpointArtifactId: OpaqueIdSchema,
    evidenceIds: z.array(OpaqueIdSchema),
    reason: z.string().min(1).max(2000),
  })
  .strict();

const RunResumedCommandSchema = z
  .object({
    type: z.literal("run_resumed"),
    checkpointArtifactId: OpaqueIdSchema,
    evidenceIds: z.array(OpaqueIdSchema),
    sideEffectState: z.enum(["not_started", "committed", "reconciled", "unknown"]),
  })
  .strict();

const HumanDecisionCommandSchema = z
  .object({
    type: z.literal("human_decision"),
    decision: z.enum(["approved", "rejected", "override"]),
    reason: z.string().min(1).max(2000).nullable(),
    evidenceIds: z.array(OpaqueIdSchema),
  })
  .strict();

const PrObservedCommandSchema = z
  .object({
    type: z.literal("pr_observed"),
    repository: z
      .string()
      .min(3)
      .max(300)
      .regex(/^[^/]+\/[^/]+$/),
    pullRequestNumber: z.number().int().positive(),
    state: z.enum(["open", "merged", "closed"]),
    isDraft: z.boolean(),
    linkedIssue: z
      .object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        issueNumber: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    linkageComplete: z.boolean(),
    evidenceIds: z.array(OpaqueIdSchema),
  })
  .strict();

export const RunGraphRunnerCommandSchema: z.ZodType<RunGraphRunnerCommand> = z
  .discriminatedUnion("type", [
    AttemptStartedCommandSchema,
    AttemptFinishedCommandSchema,
    NodeOutcomeSubmittedCommandSchema,
    RunPausedCommandSchema,
    RunResumedCommandSchema,
    HumanDecisionCommandSchema,
    PrObservedCommandSchema,
  ])
  .superRefine((command, context) => {
    if (command.type === "human_decision" && command.decision === "override" && !command.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "human override には理由が必要です",
      });
    }
  });

export const RunGraphRunnerCommandInputSchema: z.ZodType<RunGraphRunnerCommandInput> = z
  .object({
    schemaVersion: z.literal("1"),
    eventId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    actor: RunGraphActorSchema,
    command: RunGraphRunnerCommandSchema,
    artifacts: z.array(RunGraphArtifactSubmissionSchema).optional(),
    evidence: z.array(RunGraphEvidenceSubmissionSchema).optional(),
  })
  .strict();

const TaskReferenceSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
  })
  .strict();

const ContractReferenceSchema = z
  .object({
    planId: z.string().min(1),
    planVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
  })
  .strict();

export const RunGraphStartInputSchema: z.ZodType<RunGraphStartInput> = z
  .object({
    schemaVersion: z.literal("1"),
    eventId: OpaqueIdSchema,
    actor: RunGraphActorSchema,
    task: TaskReferenceSchema,
    contract: ContractReferenceSchema,
  })
  .strict();

const RunGraphStartedCommandSchema: z.ZodType<RunGraphStartedCommand> = z
  .object({
    type: z.literal("run_started"),
    task: TaskReferenceSchema,
    contract: ContractReferenceSchema,
    firstNodeId: OpaqueIdSchema,
  })
  .strict();

export const RunGraphAcceptedCommandSchema: z.ZodType<RunGraphAcceptedCommand> = z.union([
  RunGraphStartedCommandSchema,
  RunGraphRunnerCommandSchema,
  RunGraphClaimAuditCommandSchema,
]);

export const RunGraphDispatchAuthorizationBindingSchema: z.ZodType<RunGraphDispatchAuthorizationBinding> =
  z
    .object({
      claimId: OpaqueIdSchema,
      fencingToken: z.number().int().positive(),
      ownerId: OpaqueIdSchema,
      runId: OpaqueIdSchema,
      taskId: OpaqueIdSchema,
      commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();

export const RunGraphAcceptedEventSchema: z.ZodType<RunGraphAcceptedEvent> = z
  .object({
    recordType: z.literal("accepted"),
    eventId: OpaqueIdSchema,
    sequence: z.number().int().positive(),
    runId: OpaqueIdSchema,
    acceptedAt: TimestampSchema,
    actor: RunGraphActorSchema,
    command: RunGraphAcceptedCommandSchema,
    artifactIds: ArtifactIdListSchema,
    evidenceIds: z.array(OpaqueIdSchema),
    artifacts: z.array(RunGraphArtifactSchema).optional(),
    evidence: z.array(RunGraphEvidenceSchema).optional(),
    dispatchAuthorization: RunGraphDispatchAuthorizationBindingSchema.optional(),
    nextNodeId: OpaqueIdSchema.optional(),
    nextContractNodeId: OpaqueIdSchema.optional(),
    waitReason: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const submittedArtifactIds = (event.artifacts ?? []).map((artifact) => artifact.id);
    const submittedEvidenceIds = (event.evidence ?? []).map((evidence) => evidence.id);
    const checkpointUsesAttemptProducer = event.command.type === "run_paused";
    if (
      event.dispatchAuthorization &&
      (event.dispatchAuthorization.runId !== event.runId ||
        event.dispatchAuthorization.ownerId !== event.actor.id ||
        (event.command.type !== "attempt_finished" &&
          event.command.type !== "node_outcome_submitted"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dispatchAuthorization"],
        message: "dispatch authorization は同じ Run/actor の completion/outcome にだけ指定できます",
      });
    }
    if (
      new Set(event.artifactIds).size !== event.artifactIds.length ||
      new Set(event.evidenceIds).size !== event.evidenceIds.length ||
      submittedArtifactIds.some((id) => !event.artifactIds.includes(id)) ||
      submittedEvidenceIds.some((id) => !event.evidenceIds.includes(id)) ||
      (event.artifacts ?? []).some(
        (artifact) =>
          artifact.runId !== event.runId ||
          (!checkpointUsesAttemptProducer && artifact.actor.id !== event.actor.id),
      ) ||
      (event.evidence ?? []).some(
        (evidence) =>
          evidence.runId !== event.runId ||
          (!checkpointUsesAttemptProducer && evidence.actor.id !== event.actor.id),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactIds"],
        message: "accepted event の artifact/evidence binding が envelope と一致しません",
      });
    }
    if ((event.nextNodeId === undefined) !== (event.nextContractNodeId === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextNodeId"],
        message: "next node ID と next contract node ID は同時に記録する必要があります",
      });
    }
    if (
      event.command.type === "node_outcome_submitted" &&
      (!event.nextNodeId || !event.nextContractNodeId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextNodeId"],
        message: "node outcome accepted event には next node binding が必要です",
      });
    }
  });

/** 旧 schema v1 envelope の PR observation を fail-closed な未証明 linkage へ正規化する。 */
function normalizeLegacyPrObservedEnvelope(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const envelope = input as Record<string, unknown>;
  const command = envelope.command;
  if (!command || typeof command !== "object" || Array.isArray(command)) return input;
  const commandRecord = command as Record<string, unknown>;
  if (commandRecord.type !== "pr_observed") return input;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(commandRecord, key);
  return {
    ...envelope,
    command: {
      ...commandRecord,
      isDraft: has("isDraft") ? commandRecord.isDraft : false,
      linkedIssue: has("linkedIssue") ? commandRecord.linkedIssue : null,
      linkageComplete: has("linkageComplete") ? commandRecord.linkageComplete : false,
    },
  };
}

/**
 * immutable な旧 schema v1 segment を読むときだけ read migration を適用する。
 * 新規 append は厳格な write schema を使い続ける。
 */
export const RunGraphAcceptedEventReadSchema: z.ZodType<
  RunGraphAcceptedEvent,
  z.ZodTypeDef,
  unknown
> = z.preprocess(normalizeLegacyPrObservedEnvelope, RunGraphAcceptedEventSchema);

export const RunGraphRejectionSchema: z.ZodType<RunGraphRejection> = z
  .object({
    recordType: z.literal("rejected"),
    rejectionId: OpaqueIdSchema,
    eventId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    rejectedAt: TimestampSchema,
    actor: RunGraphActorSchema,
    command: RunGraphRunnerCommandSchema,
    code: z.enum(RUN_GRAPH_REJECTION_CODES),
    message: z.string().min(1).max(2000),
    stateUnchanged: z.literal(true),
  })
  .strict();

/** immutable な旧 rejection record 専用の read migration schema。 */
export const RunGraphRejectionReadSchema: z.ZodType<RunGraphRejection, z.ZodTypeDef, unknown> =
  z.preprocess(normalizeLegacyPrObservedEnvelope, RunGraphRejectionSchema);

export const RunGraphJournalSchema: z.ZodType<RunGraphJournal> = z
  .object({
    schemaVersion: z.literal("1"),
    runId: OpaqueIdSchema,
    acceptedEvents: z.array(RunGraphAcceptedEventSchema),
    rejections: z.array(RunGraphRejectionSchema),
  })
  .strict()
  .superRefine((journal, context) => {
    const acceptedIds = new Set<string>();
    for (const [index, event] of journal.acceptedEvents.entries()) {
      if (acceptedIds.has(event.eventId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptedEvents", index, "eventId"],
          message: "同じ event ID を複数の accepted event に記録できません",
        });
      }
      acceptedIds.add(event.eventId);
      if (event.runId !== journal.runId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptedEvents", index, "runId"],
          message: "accepted event の run ID が journal と一致しません",
        });
      }
      if (event.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acceptedEvents", index, "sequence"],
          message: "accepted event sequence は1から連続している必要があります",
        });
      }
    }

    const rejectionIds = new Set<string>();
    for (const [index, rejection] of journal.rejections.entries()) {
      if (rejectionIds.has(rejection.rejectionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejections", index, "rejectionId"],
          message: "同じ rejection ID を複数回記録できません",
        });
      }
      rejectionIds.add(rejection.rejectionId);
      if (rejection.runId !== journal.runId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejections", index, "runId"],
          message: "rejection の run ID が journal と一致しません",
        });
      }
      if (rejection.code === "duplicate_event" && !acceptedIds.has(rejection.eventId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejections", index, "eventId"],
          message: "duplicate_event は既に受理済みの event ID を参照する必要があります",
        });
      }
    }
  });

export interface RunGraphBudgetProjection {
  executorRetries: number;
  improvementIterations: number;
}

export interface RunGraphProjection {
  schemaVersion: "1";
  revision: number;
  run: RunGraphRun;
  nodes: RunGraphNode[];
  attempts: RunGraphAttempt[];
  artifacts: RunGraphArtifact[];
  evidence: RunGraphEvidence[];
  budgets: RunGraphBudgetProjection;
}

export interface RunGraphBoundedCollection<T> {
  total: number;
  limit: number;
  truncated: boolean;
  items: T[];
}

export interface RunGraphClaimAuditView {
  eventId: string;
  acceptedAt: string;
  actor: RunGraphActor;
  command: RunGraphClaimAuditCommand;
}

export interface RunGraphView {
  schemaVersion: "1";
  runId: string;
  task: { owner: string; repo: string; issueNumber: number };
  contract: RunGraphRun["contract"];
  revision: number;
  state: RunGraphRunState;
  createdAt: string;
  updatedAt: string;
  currentNode: RunGraphNode | null;
  activeAttempt: RunGraphAttempt | null;
  waitReason: string | null;
  budgets: RunGraphBudgetProjection;
  allowedNextTransitions: RunGraphRunnerCommandType[];
  nodes: RunGraphBoundedCollection<RunGraphNode>;
  attempts: RunGraphBoundedCollection<RunGraphAttempt>;
  artifacts: RunGraphBoundedCollection<RunGraphArtifact>;
  evidence: RunGraphBoundedCollection<RunGraphEvidence>;
  claimAudits: RunGraphBoundedCollection<RunGraphClaimAuditView>;
}

const RunGraphBudgetProjectionSchema: z.ZodType<RunGraphBudgetProjection> = z
  .object({
    executorRetries: z.number().int().nonnegative(),
    improvementIterations: z.number().int().nonnegative(),
  })
  .strict();

export const RunGraphProjectionSchema: z.ZodType<RunGraphProjection> = z
  .object({
    schemaVersion: z.literal("1"),
    revision: z.number().int().nonnegative(),
    run: RunGraphRunSchema,
    nodes: z.array(RunGraphNodeSchema),
    attempts: z.array(RunGraphAttemptSchema),
    artifacts: z.array(RunGraphArtifactSchema),
    evidence: z.array(RunGraphEvidenceSchema),
    budgets: RunGraphBudgetProjectionSchema,
  })
  .strict()
  .superRefine((projection, context) => {
    const nodeIds = new Set(projection.nodes.map((node) => node.id));
    const attemptIds = new Set(projection.attempts.map((attempt) => attempt.id));
    const artifactIds = new Set(projection.artifacts.map((artifact) => artifact.id));
    const evidenceIds = new Set(projection.evidence.map((evidence) => evidence.id));
    const reportDuplicate = (values: string[], path: string) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} の ID は Run 内で一意である必要があります`,
        });
      }
    };
    reportDuplicate(
      projection.nodes.map((node) => node.id),
      "nodes",
    );
    reportDuplicate(
      projection.attempts.map((attempt) => attempt.id),
      "attempts",
    );
    reportDuplicate(
      projection.artifacts.map((artifact) => artifact.id),
      "artifacts",
    );
    reportDuplicate(
      projection.evidence.map((evidence) => evidence.id),
      "evidence",
    );
    if (projection.run.currentNodeId && !nodeIds.has(projection.run.currentNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run", "currentNodeId"],
        message: "current node ID が projection に存在しません",
      });
    }
    for (const [index, node] of projection.nodes.entries()) {
      const activeAttempt = node.activeAttemptId
        ? projection.attempts.find((attempt) => attempt.id === node.activeAttemptId)
        : undefined;
      if (
        node.runId !== projection.run.id ||
        (node.previousNodeId !== null && !nodeIds.has(node.previousNodeId)) ||
        (node.activeAttemptId !== null && activeAttempt?.nodeId !== node.id) ||
        [...node.inputArtifactIds, ...node.outputArtifactIds].some((id) => !artifactIds.has(id))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index],
          message: "node の lineage が projection と一致しません",
        });
      }
    }
    for (const [index, attempt] of projection.attempts.entries()) {
      if (
        attempt.runId !== projection.run.id ||
        !nodeIds.has(attempt.nodeId) ||
        (attempt.previousAttemptId !== null && !attemptIds.has(attempt.previousAttemptId)) ||
        [...attempt.inputArtifactIds, ...attempt.outputArtifactIds].some(
          (id) => !artifactIds.has(id),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attempts", index],
          message: "attempt の lineage が projection と一致しません",
        });
      }
    }
    for (const [index, artifact] of projection.artifacts.entries()) {
      if (
        artifact.runId !== projection.run.id ||
        !nodeIds.has(artifact.nodeId) ||
        !attemptIds.has(artifact.producerAttemptId) ||
        artifact.derivedFromArtifactIds.some((id) => !artifactIds.has(id))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", index],
          message: "artifact の lineage が projection と一致しません",
        });
      }
    }
    for (const [index, evidence] of projection.evidence.entries()) {
      if (
        evidence.runId !== projection.run.id ||
        (evidence.nodeId !== null && !nodeIds.has(evidence.nodeId)) ||
        (evidence.producerAttemptId !== null && !attemptIds.has(evidence.producerAttemptId)) ||
        evidence.artifactIds.some((id) => !artifactIds.has(id))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", index],
          message: "evidence の lineage が projection と一致しません",
        });
      }
    }
    if (
      [...projection.run.inputArtifactIds, ...projection.run.outputArtifactIds].some(
        (id) => !artifactIds.has(id),
      ) ||
      evidenceIds.size !== projection.evidence.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run"],
        message: "run の lineage または entity ID が projection と一致しません",
      });
    }
  });

function boundedCollectionSchema<T>(
  itemSchema: z.ZodType<T>,
): z.ZodType<RunGraphBoundedCollection<T>> {
  return z
    .object({
      total: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(100),
      truncated: z.boolean(),
      items: z.array(itemSchema),
    })
    .strict()
    .superRefine((collection, context) => {
      if (collection.items.length > collection.limit) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items"],
          message: "items 件数は limit 以下である必要があります",
        });
      }
      if (collection.total < collection.items.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["total"],
          message: "total は items 件数以上である必要があります",
        });
      }
      if (collection.truncated !== collection.total > collection.items.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["truncated"],
          message: "truncated は total と items 件数から導出する必要があります",
        });
      }
    });
}

const BoundedArtifactCollectionSchema = boundedCollectionSchema(RunGraphArtifactSchema);
const BoundedEvidenceCollectionSchema = boundedCollectionSchema(RunGraphEvidenceSchema);
const BoundedNodeCollectionSchema = boundedCollectionSchema(RunGraphNodeSchema);
const BoundedAttemptCollectionSchema = boundedCollectionSchema(RunGraphAttemptSchema);
const RunGraphClaimAuditViewSchema: z.ZodType<RunGraphClaimAuditView> = z
  .object({
    eventId: OpaqueIdSchema,
    acceptedAt: TimestampSchema,
    actor: RunGraphActorSchema,
    command: RunGraphClaimAuditCommandSchema,
  })
  .strict();
const BoundedClaimAuditCollectionSchema = boundedCollectionSchema(RunGraphClaimAuditViewSchema);

export const RunGraphViewSchema: z.ZodType<RunGraphView> = z
  .object({
    schemaVersion: z.literal("1"),
    runId: OpaqueIdSchema,
    task: TaskReferenceSchema,
    contract: ContractReferenceSchema,
    revision: z.number().int().nonnegative(),
    state: z.enum(RUN_GRAPH_RUN_STATES),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    currentNode: RunGraphNodeSchema.nullable(),
    activeAttempt: RunGraphAttemptSchema.nullable(),
    waitReason: z.string().min(1).max(2000).nullable(),
    budgets: RunGraphBudgetProjectionSchema,
    allowedNextTransitions: z.array(z.enum(RUN_GRAPH_RUNNER_COMMAND_TYPES)),
    nodes: BoundedNodeCollectionSchema,
    attempts: BoundedAttemptCollectionSchema,
    artifacts: BoundedArtifactCollectionSchema,
    evidence: BoundedEvidenceCollectionSchema,
    claimAudits: BoundedClaimAuditCollectionSchema,
  })
  .strict();
