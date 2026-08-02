import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  canonicalJsonStringify,
  DispatchClaimAcquireInputSchema,
  DispatchClaimEventAuthorizationInputSchema,
  DispatchClaimHeartbeatInputSchema,
  DispatchClaimReceiptSchema,
  DispatchClaimReclaimInputSchema,
  DispatchClaimReleaseInputSchema,
  DispatchClaimSchema,
  type DispatchClaim,
  type DispatchClaimAcquireInput,
  type DispatchClaimEventAuthorizationInput,
  type DispatchClaimHeartbeatInput,
  type DispatchClaimProof,
  type DispatchClaimReceipt,
  type DispatchClaimReclaimInput,
  type DispatchClaimReleaseInput,
  type DispatchConfig,
  type RunGraphDispatchAuthorizationBinding,
} from "@gh-gantt/shared";
import { resolveRepositoryCoordinationLayout } from "./repository-coordination-layout.js";

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MAX_RECOVERY_GENERATIONS = 64;

interface DispatchClaimHistoryEvent {
  eventId: string;
  operation: "claim" | "heartbeat" | "release" | "reclaim" | "authorize_event";
  entityVersion: number;
  occurredAt: string;
  claimId: string;
  taskId: string;
  ownerId: string;
  runId: string;
  reclaimReason?: "expired" | "owner_stopped";
  evidenceId?: string;
}

interface StoredReceipt {
  eventId: string;
  payloadFingerprint: string;
  receipt: DispatchClaimReceipt;
}

export interface MutationReservationProof {
  proposalId: string;
  ownerNonce: string;
  fencingToken: number;
  affectedTaskIds: string[];
  expiresAt: string;
  /** in_flight はexpiryを越えてもdispatchを遮断し、reconcile完了まで残る。 */
  sideEffectState?: "idle" | "in_flight";
}

export interface MutationReservationInput {
  proposalId: string;
  ownerNonce: string;
  expectedEntityVersion: number;
  affectedTaskIds: string[];
  leaseDurationSeconds: number;
}

export type MutationReservationResult =
  | { accepted: true; entityVersion: number; reservation: MutationReservationProof }
  | {
      accepted: false;
      entityVersion: number;
      code: "stale_entity_version" | "dispatch_claim_conflict" | "mutation_reservation_conflict";
      message: string;
    };

interface StoredPendingAuthorization {
  status: "pending";
  eventId: string;
  payloadFingerprint: string;
  claim: DispatchClaim;
  binding: RunGraphDispatchAuthorizationBinding;
  actorId: string;
  createdAt: string;
}

interface StoredReclaimedAuthorization {
  status: "reclaimed";
  eventId: string;
  payloadFingerprint: string;
  claim: DispatchClaim;
  binding: RunGraphDispatchAuthorizationBinding;
  actorId: string;
  createdAt: string;
  reclaimedAt: string;
  reclaimEventId: string;
}

type StoredAuthorization = StoredPendingAuthorization | StoredReclaimedAuthorization;

interface DispatchClaimRegistry {
  schemaVersion: "1";
  projectIdentity: string;
  entityVersion: number;
  claims: DispatchClaim[];
  authorizations: StoredAuthorization[];
  receipts: StoredReceipt[];
  history: DispatchClaimHistoryEvent[];
  mutationReservations: MutationReservationProof[];
}

export interface DispatchClaimSnapshot {
  schemaVersion: "1";
  projectIdentity: string;
  entityVersion: number;
  claims: DispatchClaim[];
  pendingAuthorizations: Array<{ eventId: string; claimId: string }>;
  history: DispatchClaimHistoryEvent[];
  mutationReservations?: MutationReservationProof[];
}

export type DispatchClaimAcquireResult =
  | Extract<DispatchClaimReceipt, { accepted: false }>
  | (Extract<DispatchClaimReceipt, { accepted: true }> & { claim: DispatchClaim });

export interface DispatchClaimStoreDependencies {
  now: () => string;
  nextId: () => string;
  waitTimeoutMs: number;
  processIdentity: { pid: number; hostname: string };
  isProcessAlive: (pid: number) => boolean;
  readCurrentSnapshotFingerprint?: () => Promise<string>;
  /** テスト専用: dead owner観測後の決定的なinterleaving point。 */
  afterDeadOwnerObserved?: (ownerNonce: string) => Promise<void>;
  /** テスト専用: recovery claim candidate完全書込後・atomic publish前のcrashを模擬する。 */
  afterRecoveryClaimCandidateWritten?: (
    expectedOwnerNonce: string,
    claimantNonce: string,
  ) => Promise<void>;
  /** テスト専用: recovery winnerの最終検証後・LOCK retire前の停止を模擬する。 */
  afterRecoveryClaimValidated?: (
    expectedOwnerNonce: string,
    claimantNonce: string,
  ) => Promise<void>;
  /** テスト専用: registryのatomic publish直前のcrashを模擬する。 */
  beforeRegistryPublish?: () => Promise<void>;
  /** テスト専用: pending authorization永続化直後のcrashを模擬する。 */
  afterAuthorizationPendingPublish?: () => Promise<void>;
  /** テスト専用: Run Graph追記後、authorization receipt公開前のcrashを模擬する。 */
  beforeAuthorizationFinalizePublish?: () => Promise<void>;
}

export interface DispatchAuthorizedEventCommitContext {
  claim: DispatchClaim;
  binding: RunGraphDispatchAuthorizationBinding;
}

export type PendingAuthorizationInspection = "exact_committed" | "absent" | "conflict";

export type AbortPendingAuthorizationResult =
  | {
      status: "exact_committed";
      receipt: Extract<DispatchClaimReceipt, { accepted: true; operation: "authorize_event" }>;
    }
  | { status: "aborted" | "absent" | "conflict" };

const HistoryEventSchema: z.ZodType<DispatchClaimHistoryEvent> = z
  .object({
    eventId: z.string().min(1),
    operation: z.enum(["claim", "heartbeat", "release", "reclaim", "authorize_event"]),
    entityVersion: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    claimId: z.string().min(1),
    taskId: z.string().min(1),
    ownerId: z.string().min(1),
    runId: z.string().min(1),
    reclaimReason: z.enum(["expired", "owner_stopped"]).optional(),
    evidenceId: z.string().min(1).optional(),
  })
  .strict();

const StoredReceiptSchema: z.ZodType<StoredReceipt> = z
  .object({
    eventId: z.string().min(1),
    payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    receipt: DispatchClaimReceiptSchema,
  })
  .strict();

const MutationReservationProofSchema: z.ZodType<MutationReservationProof> = z
  .object({
    proposalId: z.string().min(1),
    ownerNonce: z.string().uuid(),
    fencingToken: z.number().int().positive(),
    affectedTaskIds: z.array(z.string().min(1)).min(1),
    expiresAt: z.string().datetime({ offset: true }),
    sideEffectState: z.enum(["idle", "in_flight"]).default("idle"),
  })
  .strict();

const MutationReservationInputSchema: z.ZodType<MutationReservationInput> = z
  .object({
    proposalId: z.string().min(1),
    ownerNonce: z.string().uuid(),
    expectedEntityVersion: z.number().int().nonnegative(),
    affectedTaskIds: z.array(z.string().min(1)).min(1),
    leaseDurationSeconds: z.number().int().positive(),
  })
  .strict();

const AuthorizationBaseSchema = z.object({
  eventId: z.string().min(1),
  payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  claim: DispatchClaimSchema,
  binding: z
    .object({
      claimId: z.string().min(1),
      fencingToken: z.number().int().positive(),
      ownerId: z.string().min(1),
      runId: z.string().min(1),
      taskId: z.string().min(1),
      commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  actorId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
});

const StoredAuthorizationSchema: z.ZodType<StoredAuthorization> = z.discriminatedUnion("status", [
  AuthorizationBaseSchema.extend({ status: z.literal("pending") }).strict(),
  AuthorizationBaseSchema.extend({
    status: z.literal("reclaimed"),
    reclaimedAt: z.string().datetime({ offset: true }),
    reclaimEventId: z.string().min(1),
  }).strict(),
]);

const RegistrySchema: z.ZodType<DispatchClaimRegistry, z.ZodTypeDef, unknown> = z
  .object({
    schemaVersion: z.literal("1"),
    projectIdentity: z.string().min(1),
    entityVersion: z.number().int().nonnegative(),
    claims: z.array(DispatchClaimSchema),
    authorizations: z.array(StoredAuthorizationSchema).default([]),
    receipts: z.array(StoredReceiptSchema),
    history: z.array(HistoryEventSchema),
    mutationReservations: z.array(MutationReservationProofSchema).default([]),
  })
  .strict()
  .superRefine((registry, context) => {
    if (new Set(registry.claims.map((claim) => claim.taskId)).size !== registry.claims.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims"],
        message: "task claim は一意である必要があります",
      });
    }
    if (
      new Set(registry.claims.map((claim) => claim.workspaceId)).size !== registry.claims.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims"],
        message: "workspace claim は一意である必要があります",
      });
    }
    if (
      new Set(registry.receipts.map((receipt) => receipt.eventId)).size !== registry.receipts.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipts"],
        message: "eventId は一意である必要があります",
      });
    }
    if (
      new Set(registry.authorizations.map((authorization) => authorization.eventId)).size !==
      registry.authorizations.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizations"],
        message: "authorization eventId は一意である必要があります",
      });
    }
    if (
      new Set(registry.mutationReservations.map((reservation) => reservation.proposalId)).size !==
      registry.mutationReservations.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutationReservations"],
        message: "proposal mutation reservation は一意である必要があります",
      });
    }
  });

const LockOwnerSchema = z
  .object({
    schemaVersion: z.literal("1"),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    nonce: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const RecoveryClaimSchema = z
  .object({
    schemaVersion: z.literal("1"),
    expectedOwnerNonce: z.string().uuid(),
    claimant: z
      .object({
        pid: z.number().int().positive(),
        hostname: z.string().min(1),
        nonce: z.string().uuid(),
        claimedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

interface RegistryLayout {
  root: string;
  registryPath: string;
  lockPath: string;
  projectIdentity: string;
  dispatch: DispatchConfig | undefined;
  configuredStates: Set<string>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function canonicalJsonEquals(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function resolveLayout(projectRoot: string): Promise<RegistryLayout> {
  const coordination = await resolveRepositoryCoordinationLayout(projectRoot);
  const root = coordination.claimRoot;
  return {
    root,
    registryPath: join(root, "registry.json"),
    lockPath: join(root, "LOCK"),
    projectIdentity: coordination.projectIdentity,
    dispatch: coordination.config.dispatch,
    configuredStates: new Set(Object.keys(coordination.config.statuses.values)),
  };
}

function recoveryClaimPath(lockPath: string, expectedOwnerNonce: string): string {
  return join(lockPath, `recovery-claim-${fingerprint(expectedOwnerNonce)}.json`);
}

function recoverySuccessorPath(
  lockPath: string,
  expectedOwnerNonce: string,
  predecessor: string,
): string {
  return join(
    lockPath,
    `recovery-successor-${fingerprint(expectedOwnerNonce)}-${fingerprint(predecessor)}.json`,
  );
}

function parseRecoveryClaim(
  raw: string,
  expectedOwnerNonce: string,
): z.infer<typeof RecoveryClaimSchema> | null {
  try {
    const claim = RecoveryClaimSchema.parse(JSON.parse(raw));
    return claim.expectedOwnerNonce === expectedOwnerNonce ? claim : null;
  } catch {
    return null;
  }
}

function createRecoveryClaim(
  expectedOwnerNonce: string,
  owner: z.infer<typeof LockOwnerSchema>,
  dependencies: DispatchClaimStoreDependencies,
): z.infer<typeof RecoveryClaimSchema> {
  return RecoveryClaimSchema.parse({
    schemaVersion: "1",
    expectedOwnerNonce,
    claimant: {
      pid: owner.pid,
      hostname: owner.hostname,
      nonce: owner.nonce,
      claimedAt: dependencies.now(),
    },
  });
}

async function publishRecoveryClaim(
  markerPath: string,
  claimantNonce: string,
  recoveryClaim: z.infer<typeof RecoveryClaimSchema>,
  dependencies: DispatchClaimStoreDependencies,
): Promise<void> {
  const candidatePath = `${markerPath}.candidate-${fingerprint(claimantNonce)}`;
  await writeFile(candidatePath, `${JSON.stringify(recoveryClaim, null, 2)}\n`, { flag: "wx" });
  try {
    await dependencies.afterRecoveryClaimCandidateWritten?.(
      recoveryClaim.expectedOwnerNonce,
      claimantNonce,
    );
    // hard link は同一 filesystem 上で atomic かつ既存 marker を上書きしない。
    await link(candidatePath, markerPath);
  } finally {
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

async function retireObservedDeadOwnerGeneration(
  layout: RegistryLayout,
  observedOwner: z.infer<typeof LockOwnerSchema>,
  contender: z.infer<typeof LockOwnerSchema>,
  dependencies: DispatchClaimStoreDependencies,
): Promise<boolean> {
  let markerPath = recoveryClaimPath(layout.lockPath, observedOwner.nonce);
  let markerRaw = await readOptional(markerPath);
  if (markerRaw === null) {
    await publishRecoveryClaim(
      markerPath,
      contender.nonce,
      createRecoveryClaim(observedOwner.nonce, contender, dependencies),
      dependencies,
    );
    markerRaw = await readOptional(markerPath);
    if (markerRaw === null) return false;
  }

  const visitedMarkers = new Set<string>();
  for (let generation = 0; generation < MAX_RECOVERY_GENERATIONS; generation += 1) {
    if (visitedMarkers.has(markerPath)) return false;
    visitedMarkers.add(markerPath);
    const recoveryClaim = parseRecoveryClaim(markerRaw, observedOwner.nonce);
    const predecessor = recoveryClaim
      ? recoveryClaim.claimant.nonce
      : `malformed-${fingerprint(markerRaw)}`;
    const successorPath = recoverySuccessorPath(layout.lockPath, observedOwner.nonce, predecessor);

    if (recoveryClaim?.claimant.nonce === contender.nonce) {
      const [validatedOwnerRaw, validatedRecoveryRaw, validatedSuccessorRaw] = await Promise.all([
        readOptional(join(layout.lockPath, "owner.json")),
        readOptional(markerPath),
        readOptional(successorPath),
      ]);
      if (
        !validatedOwnerRaw ||
        validatedRecoveryRaw !== markerRaw ||
        validatedSuccessorRaw !== null
      ) {
        return false;
      }
      const validatedOwner = LockOwnerSchema.parse(JSON.parse(validatedOwnerRaw));
      const validatedRecovery = parseRecoveryClaim(validatedRecoveryRaw, observedOwner.nonce);
      if (
        validatedOwner.nonce !== observedOwner.nonce ||
        validatedRecovery?.claimant.nonce !== contender.nonce
      ) {
        return false;
      }
      await dependencies.afterRecoveryClaimValidated?.(
        validatedOwner.nonce,
        validatedRecovery.claimant.nonce,
      );
      const [latestOwnerRaw, latestRecoveryRaw, successorRaw] = await Promise.all([
        readOptional(join(layout.lockPath, "owner.json")),
        readOptional(markerPath),
        readOptional(successorPath),
      ]);
      if (!latestOwnerRaw || latestRecoveryRaw !== markerRaw || successorRaw !== null) return false;
      const latestOwner = LockOwnerSchema.parse(JSON.parse(latestOwnerRaw));
      const latestRecovery = parseRecoveryClaim(latestRecoveryRaw, observedOwner.nonce);
      if (
        latestOwner.nonce !== observedOwner.nonce ||
        latestRecovery?.claimant.nonce !== contender.nonce
      ) {
        return false;
      }
      // recovery marker は observed owner generation に、successor marker は predecessor claimant
      // generation に hard-link no-replace で束縛される。tip winner 自身が live の間は他 contender が
      // successor を作れない。pause seam 後にも owner/marker/tip を再検証するため、この再検証から
      // rename まで compliant writer は LOCK を retire できず、winner crash 後だけ次 generation が
      // 同じ規則で選出される。
      const recovered = `${layout.lockPath}.recovered-${fingerprint(observedOwner.nonce)}-${randomUUID()}`;
      await rename(layout.lockPath, recovered);
      const retiredOwner = LockOwnerSchema.parse(
        JSON.parse(await readFile(join(recovered, "owner.json"), "utf8")),
      );
      if (retiredOwner.nonce !== observedOwner.nonce) {
        throw new Error("retire 対象の lock owner generation が変化しました");
      }
      await rm(recovered, { recursive: true, force: true });
      return true;
    }

    if (recoveryClaim) {
      if (recoveryClaim.claimant.hostname !== dependencies.processIdentity.hostname) return false;
      if (dependencies.isProcessAlive(recoveryClaim.claimant.pid)) return false;
    }

    const successorRaw = await readOptional(successorPath);
    if (successorRaw !== null) {
      markerPath = successorPath;
      markerRaw = successorRaw;
      continue;
    }
    await publishRecoveryClaim(
      successorPath,
      contender.nonce,
      createRecoveryClaim(observedOwner.nonce, contender, dependencies),
      dependencies,
    );
    const publishedRaw = await readOptional(successorPath);
    if (publishedRaw === null) return false;
    markerPath = successorPath;
    markerRaw = publishedRaw;
  }
  return false;
}

async function acquireLock(
  layout: RegistryLayout,
  dependencies: DispatchClaimStoreDependencies,
): Promise<() => Promise<void>> {
  await mkdir(layout.root, { recursive: true });
  const owner = {
    schemaVersion: "1" as const,
    pid: dependencies.processIdentity.pid,
    hostname: dependencies.processIdentity.hostname,
    nonce: randomUUID(),
    startedAt: dependencies.now(),
  };
  const deadline = Date.now() + dependencies.waitTimeoutMs;
  while (true) {
    const candidate = `${layout.lockPath}.candidate-${owner.nonce}`;
    try {
      await mkdir(candidate);
      await writeJsonAtomic(join(candidate, "owner.json"), owner);
      await rename(candidate, layout.lockPath);
      break;
    } catch (error) {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" &&
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
      )
        throw error;
      const raw = await readOptional(join(layout.lockPath, "owner.json"));
      if (raw) {
        const current = LockOwnerSchema.parse(JSON.parse(raw));
        if (
          current.hostname === dependencies.processIdentity.hostname &&
          !dependencies.isProcessAlive(current.pid)
        ) {
          await dependencies.afterDeadOwnerObserved?.(current.nonce);
          try {
            if (await retireObservedDeadOwnerGeneration(layout, current, owner, dependencies))
              continue;
          } catch (recoveryError) {
            if (
              !["ENOENT", "EEXIST", "ENOTEMPTY"].includes(
                (recoveryError as NodeJS.ErrnoException).code ?? "",
              )
            )
              throw recoveryError;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error("dispatch claim registry は使用中です");
      await sleep(10);
    }
  }
  return async () => {
    const raw = await readOptional(join(layout.lockPath, "owner.json"));
    if (!raw) return;
    const current = LockOwnerSchema.parse(JSON.parse(raw));
    if (current.nonce !== owner.nonce)
      throw new Error("dispatch claim registry lock owner が変化しました");
    const retired = `${layout.lockPath}.retired-${owner.nonce}`;
    await rename(layout.lockPath, retired);
    await rm(retired, { recursive: true, force: true });
  };
}

function emptyRegistry(layout: RegistryLayout): DispatchClaimRegistry {
  return {
    schemaVersion: "1",
    projectIdentity: layout.projectIdentity,
    entityVersion: 0,
    claims: [],
    authorizations: [],
    receipts: [],
    history: [],
    mutationReservations: [],
  };
}

function proofMatches(claim: DispatchClaim, proof: DispatchClaimProof): boolean {
  return (
    claim.claimId === proof.claimId &&
    claim.fencingToken === proof.fencingToken &&
    claim.ownerId === proof.ownerId &&
    claim.runId === proof.runId
  );
}

export function createDispatchClaimStoreDependencies(
  overrides: Partial<DispatchClaimStoreDependencies> = {},
): DispatchClaimStoreDependencies {
  return {
    now: () => new Date().toISOString(),
    nextId: () => `claim-${randomUUID()}`,
    waitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    processIdentity: { pid: process.pid, hostname: hostname() },
    isProcessAlive,
    ...overrides,
  };
}

/** repository-shared claim registry を短時間 transaction だけで更新する public Store。 */
export class DispatchClaimStore {
  private readonly dependencies: DispatchClaimStoreDependencies;

  constructor(
    private readonly projectRoot: string,
    dependencies: DispatchClaimStoreDependencies = createDispatchClaimStoreDependencies(),
  ) {
    this.dependencies = dependencies;
  }

  private async readRegistry(layout: RegistryLayout): Promise<DispatchClaimRegistry> {
    const raw = await readOptional(layout.registryPath);
    if (raw === null) return emptyRegistry(layout);
    const registry = RegistrySchema.parse(JSON.parse(raw));
    if (registry.projectIdentity !== layout.projectIdentity) {
      throw new Error("dispatch claim registry の project identity が一致しません");
    }
    return registry;
  }

  private async transact<T>(
    callback: (layout: RegistryLayout, registry: DispatchClaimRegistry) => Promise<T>,
  ): Promise<T> {
    const layout = await resolveLayout(this.projectRoot);
    const release = await acquireLock(layout, this.dependencies);
    try {
      return await callback(layout, await this.readRegistry(layout));
    } finally {
      await release();
    }
  }

  private replayOrMismatch(
    registry: DispatchClaimRegistry,
    eventId: string,
    payloadFingerprint: string,
    operation: DispatchClaimReceipt["operation"],
  ): DispatchClaimReceipt | null {
    const stored = registry.receipts.find((item) => item.eventId === eventId);
    if (!stored) return null;
    if (stored.payloadFingerprint === payloadFingerprint) return stored.receipt;
    return {
      accepted: false,
      operation,
      eventId,
      entityVersion: registry.entityVersion,
      stateUnchanged: true,
      code: "event_payload_mismatch",
      message: "同じ eventId に異なる payload は使用できません",
    };
  }

  private async reject(
    layout: RegistryLayout,
    registry: DispatchClaimRegistry,
    payloadFingerprint: string,
    receipt: Extract<DispatchClaimReceipt, { accepted: false }>,
  ): Promise<DispatchClaimReceipt> {
    registry.receipts.push({ eventId: receipt.eventId, payloadFingerprint, receipt });
    await this.publishRegistry(layout, registry);
    return receipt;
  }

  private async publishRegistry(
    layout: RegistryLayout,
    registry: DispatchClaimRegistry,
  ): Promise<void> {
    await this.dependencies.beforeRegistryPublish?.();
    await writeJsonAtomic(layout.registryPath, RegistrySchema.parse(registry));
  }

  private async finalizeAuthorization(
    layout: RegistryLayout,
    registry: DispatchClaimRegistry,
    authorization: StoredAuthorization,
  ): Promise<Extract<DispatchClaimReceipt, { accepted: true; operation: "authorize_event" }>> {
    const entityVersion = registry.entityVersion + 1;
    const claimContinues = authorization.status === "pending";
    let receiptClaim = authorization.claim;
    if (claimContinues) {
      const index = registry.claims.findIndex(
        (claim) => claim.claimId === authorization.claim.claimId,
      );
      const current = registry.claims[index];
      if (!current || !canonicalJsonEquals(current, authorization.claim)) {
        throw new Error("pending authorization の claim lineage が失効しました");
      }
      receiptClaim = DispatchClaimSchema.parse({
        ...authorization.claim,
        entityVersion,
        fencingToken: entityVersion,
      });
      registry.claims[index] = receiptClaim;
    }
    const receipt = DispatchClaimReceiptSchema.parse({
      accepted: true,
      operation: "authorize_event",
      eventId: authorization.eventId,
      entityVersion,
      stateUnchanged: false,
      claim: receiptClaim,
      completion: {
        runId: authorization.claim.runId,
        taskId: authorization.claim.taskId,
        actorId: authorization.actorId,
        commandFingerprint: authorization.binding.commandFingerprint,
      },
      claimContinues,
    });
    if (!receipt.accepted || receipt.operation !== "authorize_event") {
      throw new Error("authorize_event receipt の構築に失敗しました");
    }
    registry.entityVersion = entityVersion;
    registry.authorizations = registry.authorizations.filter(
      (stored) => stored.eventId !== authorization.eventId,
    );
    registry.receipts.push({
      eventId: authorization.eventId,
      payloadFingerprint: authorization.payloadFingerprint,
      receipt,
    });
    registry.history.push({
      eventId: authorization.eventId,
      operation: "authorize_event",
      entityVersion,
      occurredAt: this.dependencies.now(),
      claimId: authorization.claim.claimId,
      taskId: authorization.claim.taskId,
      ownerId: authorization.claim.ownerId,
      runId: authorization.claim.runId,
    });
    await this.dependencies.beforeAuthorizationFinalizePublish?.();
    await this.publishRegistry(layout, registry);
    return receipt;
  }

  async claim(
    input: DispatchClaimAcquireInput,
    readCurrentSnapshotFingerprint?: () => Promise<string>,
  ): Promise<DispatchClaimAcquireResult> {
    const command = DispatchClaimAcquireInputSchema.parse(input);
    const payloadFingerprint = fingerprint(command);
    return this.transact(async (layout, registry) => {
      const replay = this.replayOrMismatch(registry, command.eventId, payloadFingerprint, "claim");
      if (replay) return replay as DispatchClaimAcquireResult;
      const rejection = (
        code: Extract<DispatchClaimReceipt, { accepted: false }>["code"],
        message: string,
        durableRegistry = registry,
      ) =>
        this.reject(layout, durableRegistry, payloadFingerprint, {
          accepted: false,
          operation: "claim",
          eventId: command.eventId,
          entityVersion: durableRegistry.entityVersion,
          stateUnchanged: true,
          code,
          message,
        }) as Promise<DispatchClaimReceipt & { accepted: false }>;
      if (command.expectedEntityVersion !== registry.entityVersion) {
        // lock待機中にmutation reservationが勝った場合だけ、低位CAS競合をドメイン競合へ戻す。
        // expected世代以前から存在するreservationや無関係なversion進行は真正なstaleのままにする。
        const durableRegistry = await this.readRegistry(layout);
        const now = Date.parse(this.dependencies.now());
        if (
          durableRegistry.mutationReservations.some(
            (reservation) =>
              reservation.fencingToken > command.expectedEntityVersion &&
              (reservation.sideEffectState === "in_flight" ||
                Date.parse(reservation.expiresAt) > now) &&
              reservation.affectedTaskIds.includes(command.taskId),
          )
        ) {
          return rejection(
            "task_already_claimed",
            "task は Work Graph mutation reservation により予約されています",
            durableRegistry,
          );
        }
        return rejection(
          "stale_entity_version",
          "expected entityVersion が current と一致しません",
          durableRegistry,
        );
      }
      const readSnapshot =
        readCurrentSnapshotFingerprint ?? this.dependencies.readCurrentSnapshotFingerprint;
      if (!readSnapshot || (await readSnapshot()) !== command.snapshotFingerprint)
        return rejection(
          "snapshot_mismatch",
          "claim 直前の Work Graph/gate snapshot が dispatch plan と一致しません",
        );
      if (registry.claims.some((claim) => claim.taskId === command.taskId))
        return rejection("task_already_claimed", "task は既に claim されています");
      if (registry.claims.some((claim) => claim.workspaceId === command.workspaceId))
        return rejection("workspace_already_claimed", "workspace は既に claim されています");
      if (
        registry.mutationReservations.some(
          (reservation) =>
            (reservation.sideEffectState === "in_flight" ||
              Date.parse(reservation.expiresAt) > Date.parse(this.dependencies.now())) &&
            reservation.affectedTaskIds.includes(command.taskId),
        )
      )
        return rejection(
          "task_already_claimed",
          "task は Work Graph mutation reservation により予約されています",
        );
      if (!layout.dispatch)
        return rejection(
          "dispatch_not_configured",
          "repository config に dispatch 設定がありません",
        );
      if (!layout.configuredStates.has(command.state))
        return rejection(
          "unknown_state",
          "claim state は configured status と一致する必要があります",
        );
      if (registry.claims.length >= layout.dispatch.max_concurrency)
        return rejection("global_capacity", "global concurrency 上限に達しています");
      const stateLimit =
        layout.dispatch.state_concurrency?.[command.state] ?? layout.dispatch.max_concurrency;
      if (registry.claims.filter((claim) => claim.state === command.state).length >= stateLimit)
        return rejection("state_capacity", "state concurrency 上限に達しています");
      const repositoryLimit =
        layout.dispatch.repository_concurrency?.[command.repository] ??
        layout.dispatch.max_concurrency;
      if (
        registry.claims.filter((claim) => claim.repository === command.repository).length >=
        repositoryLimit
      )
        return rejection("repository_capacity", "repository concurrency 上限に達しています");
      const entityVersion = registry.entityVersion + 1;
      const acquiredAt = this.dependencies.now();
      const claim: DispatchClaim = DispatchClaimSchema.parse({
        taskId: command.taskId,
        repository: command.repository,
        state: command.state,
        ownerId: command.ownerId,
        workspaceId: command.workspaceId,
        runId: command.runId,
        claimId: this.dependencies.nextId(),
        entityVersion,
        fencingToken: entityVersion,
        acquiredAt,
        expiresAt: new Date(
          Date.parse(acquiredAt) + command.leaseDurationSeconds * 1000,
        ).toISOString(),
        dispatchPlanId: command.dispatchPlanId,
        dispatchPlanVersion: command.dispatchPlanVersion,
      });
      const receipt = DispatchClaimReceiptSchema.parse({
        accepted: true,
        operation: "claim",
        eventId: command.eventId,
        entityVersion,
        stateUnchanged: false,
        claim,
      }) as Extract<DispatchClaimReceipt, { accepted: true }> & { claim: DispatchClaim };
      registry.entityVersion = entityVersion;
      registry.claims.push(claim);
      registry.receipts.push({ eventId: command.eventId, payloadFingerprint, receipt });
      registry.history.push({
        eventId: command.eventId,
        operation: "claim",
        entityVersion,
        occurredAt: acquiredAt,
        claimId: claim.claimId,
        taskId: claim.taskId,
        ownerId: claim.ownerId,
        runId: claim.runId,
      });
      await this.publishRegistry(layout, registry);
      return receipt;
    });
  }

  async heartbeat(input: DispatchClaimHeartbeatInput): Promise<DispatchClaimReceipt> {
    const command = DispatchClaimHeartbeatInputSchema.parse(input);
    return this.updateCurrent("heartbeat", command, command.proof, (claim, entityVersion, now) => ({
      ...claim,
      entityVersion,
      fencingToken: entityVersion,
      expiresAt: new Date(Date.parse(now) + command.leaseDurationSeconds * 1000).toISOString(),
    }));
  }

  async release(input: DispatchClaimReleaseInput): Promise<DispatchClaimReceipt> {
    const command = DispatchClaimReleaseInputSchema.parse(input);
    return this.updateCurrent("release", command, command.proof, () => null);
  }

  private async updateCurrent(
    operation: "heartbeat" | "release",
    command: DispatchClaimHeartbeatInput | DispatchClaimReleaseInput,
    proof: DispatchClaimProof,
    update: (claim: DispatchClaim, entityVersion: number, now: string) => DispatchClaim | null,
  ): Promise<DispatchClaimReceipt> {
    const payloadFingerprint = fingerprint(command);
    return this.transact(async (layout, registry) => {
      const replay = this.replayOrMismatch(
        registry,
        command.eventId,
        payloadFingerprint,
        operation,
      );
      if (replay) return replay;
      const reject = (
        code: Extract<DispatchClaimReceipt, { accepted: false }>["code"],
        message: string,
      ) =>
        this.reject(layout, registry, payloadFingerprint, {
          accepted: false,
          operation,
          eventId: command.eventId,
          entityVersion: registry.entityVersion,
          stateUnchanged: true,
          code,
          message,
        });
      if (
        registry.authorizations.some(
          (authorization) =>
            authorization.status === "pending" && authorization.claim.claimId === proof.claimId,
        )
      ) {
        return reject(
          "authorization_pending",
          "未確定の Run Graph authorization があるため claim を更新できません",
        );
      }
      if (command.expectedEntityVersion !== registry.entityVersion)
        return reject("stale_entity_version", "expected entityVersion が current と一致しません");
      const index = registry.claims.findIndex((claim) => claim.claimId === proof.claimId);
      if (index < 0) return reject("stale_claim", "current claim が見つかりません");
      const current = registry.claims[index]!;
      if (!proofMatches(current, proof))
        return reject("stale_claim", "current fencing proof と一致しません");
      const now = this.dependencies.now();
      if (Date.parse(current.expiresAt) <= Date.parse(now))
        return reject("lease_expired", `期限切れ claim は ${operation} できません`);
      const entityVersion = registry.entityVersion + 1;
      const next = update(current, entityVersion, now);
      if (next) registry.claims[index] = DispatchClaimSchema.parse(next);
      else registry.claims.splice(index, 1);
      const receipt = DispatchClaimReceiptSchema.parse({
        accepted: true,
        operation,
        eventId: command.eventId,
        entityVersion,
        stateUnchanged: false,
        claim: next ?? current,
      });
      registry.entityVersion = entityVersion;
      registry.receipts.push({ eventId: command.eventId, payloadFingerprint, receipt });
      registry.history.push({
        eventId: command.eventId,
        operation,
        entityVersion,
        occurredAt: now,
        claimId: current.claimId,
        taskId: current.taskId,
        ownerId: current.ownerId,
        runId: current.runId,
      });
      await this.publishRegistry(layout, registry);
      return receipt;
    });
  }

  async reclaim(input: DispatchClaimReclaimInput): Promise<DispatchClaimReceipt> {
    const command = DispatchClaimReclaimInputSchema.parse(input);
    const payloadFingerprint = fingerprint(command);
    return this.transact(async (layout, registry) => {
      const replay = this.replayOrMismatch(
        registry,
        command.eventId,
        payloadFingerprint,
        "reclaim",
      );
      if (replay) return replay;
      const reject = (
        code: Extract<DispatchClaimReceipt, { accepted: false }>["code"],
        message: string,
      ) =>
        this.reject(layout, registry, payloadFingerprint, {
          accepted: false,
          operation: "reclaim",
          eventId: command.eventId,
          entityVersion: registry.entityVersion,
          stateUnchanged: true,
          code,
          message,
        });
      if (command.expectedEntityVersion !== registry.entityVersion)
        return reject("stale_entity_version", "expected entityVersion が current と一致しません");
      const index = registry.claims.findIndex((claim) => claim.claimId === command.claimId);
      if (index < 0) return reject("claim_not_found", "reclaim 対象が見つかりません");
      const current = registry.claims[index]!;
      const now = this.dependencies.now();
      if (command.reason === "expired" && Date.parse(current.expiresAt) > Date.parse(now))
        return reject("lease_not_expired", "期限前の claim は reclaim できません");
      const entityVersion = registry.entityVersion + 1;
      registry.authorizations = registry.authorizations.map((authorization) =>
        authorization.status === "pending" && authorization.claim.claimId === current.claimId
          ? {
              ...authorization,
              status: "reclaimed" as const,
              reclaimedAt: now,
              reclaimEventId: command.eventId,
            }
          : authorization,
      );
      registry.claims.splice(index, 1);
      const receipt = DispatchClaimReceiptSchema.parse({
        accepted: true,
        operation: "reclaim",
        eventId: command.eventId,
        entityVersion,
        stateUnchanged: false,
        claim: current,
        reclaimReason: command.reason,
        ...(command.ownerStoppedEvidenceId ? { evidenceId: command.ownerStoppedEvidenceId } : {}),
      });
      registry.entityVersion = entityVersion;
      registry.receipts.push({ eventId: command.eventId, payloadFingerprint, receipt });
      registry.history.push({
        eventId: command.eventId,
        operation: "reclaim",
        entityVersion,
        occurredAt: now,
        claimId: current.claimId,
        taskId: current.taskId,
        ownerId: current.ownerId,
        runId: current.runId,
        reclaimReason: command.reason,
        ...(command.ownerStoppedEvidenceId ? { evidenceId: command.ownerStoppedEvidenceId } : {}),
      });
      await this.publishRegistry(layout, registry);
      return receipt;
    });
  }

  /**
   * append 前の domain rejection で不要になった exact pending authorization だけを解除する。
   * registry lock 内で Run Graph を再確認し、exact event があれば current/historical receipt を確定する。
   */
  async abortPendingAuthorization(
    input: DispatchClaimEventAuthorizationInput,
    inspectCommittedEvent: (
      context: DispatchAuthorizedEventCommitContext,
    ) => Promise<PendingAuthorizationInspection>,
  ): Promise<AbortPendingAuthorizationResult> {
    const command = DispatchClaimEventAuthorizationInputSchema.parse(input);
    const payloadFingerprint = fingerprint(command);
    const expectedBinding: RunGraphDispatchAuthorizationBinding = {
      claimId: command.proof.claimId,
      fencingToken: command.proof.fencingToken,
      ownerId: command.proof.ownerId,
      runId: command.proof.runId,
      taskId: command.taskId,
      commandFingerprint: command.commandFingerprint,
    };
    return this.transact(async (layout, registry) => {
      const replay = this.replayOrMismatch(
        registry,
        command.eventId,
        payloadFingerprint,
        "authorize_event",
      );
      if (replay) {
        if (!replay.accepted || replay.operation !== "authorize_event") {
          return { status: "conflict" };
        }
        const inspection = await inspectCommittedEvent({
          claim: replay.claim,
          binding: expectedBinding,
        });
        return inspection === "exact_committed"
          ? { status: "exact_committed", receipt: replay }
          : { status: "conflict" };
      }
      const index = registry.authorizations.findIndex(
        (authorization) => authorization.eventId === command.eventId,
      );
      if (index < 0) return { status: "absent" };
      const authorization = registry.authorizations[index]!;
      if (authorization.payloadFingerprint !== payloadFingerprint) return { status: "conflict" };
      if (
        !proofMatches(authorization.claim, command.proof) ||
        authorization.claim.entityVersion !== command.expectedEntityVersion ||
        authorization.claim.runId !== command.runId ||
        authorization.claim.taskId !== command.taskId ||
        authorization.actorId !== command.actorId ||
        !canonicalJsonEquals(authorization.binding, expectedBinding)
      ) {
        return { status: "conflict" };
      }
      const inspection = await inspectCommittedEvent({
        claim: authorization.claim,
        binding: authorization.binding,
      });
      if (inspection === "exact_committed") {
        return {
          status: "exact_committed",
          receipt: await this.finalizeAuthorization(layout, registry, authorization),
        };
      }
      if (authorization.status !== "pending") return { status: "absent" };
      const current = registry.claims.find(
        (claim) => claim.claimId === authorization.claim.claimId,
      );
      if (!current || !canonicalJsonEquals(current, authorization.claim))
        return { status: "conflict" };
      registry.authorizations.splice(index, 1);
      await this.publishRegistry(layout, registry);
      return { status: "aborted" };
    });
  }

  /**
   * current proof と binding を pending として先に永続化し、Run Graph append 後に receipt を確定する。
   * append 前後の crash では pending が repository 共通領域に残るため、heartbeat/release は進めない。
   */
  async commitAuthorizedEvent(
    input: DispatchClaimEventAuthorizationInput,
    commit: (context: DispatchAuthorizedEventCommitContext) => Promise<void>,
    options: { persistRejection?: boolean; historicalReconciliation?: boolean } = {},
  ): Promise<DispatchClaimReceipt> {
    const command = DispatchClaimEventAuthorizationInputSchema.parse(input);
    const payloadFingerprint = fingerprint(command);
    return this.transact(async (layout, registry) => {
      const replay = this.replayOrMismatch(
        registry,
        command.eventId,
        payloadFingerprint,
        "authorize_event",
      );
      if (replay) return replay;
      const reject = async (
        code: Extract<DispatchClaimReceipt, { accepted: false }>["code"],
        message: string,
      ) => {
        const receipt: Extract<DispatchClaimReceipt, { accepted: false }> = {
          accepted: false,
          operation: "authorize_event",
          eventId: command.eventId,
          entityVersion: registry.entityVersion,
          stateUnchanged: true,
          code,
          message,
        };
        return options.persistRejection === false
          ? receipt
          : this.reject(layout, registry, payloadFingerprint, receipt);
      };
      const storedAuthorization = registry.authorizations.find(
        (authorization) => authorization.eventId === command.eventId,
      );
      if (storedAuthorization && storedAuthorization.payloadFingerprint !== payloadFingerprint)
        return reject("event_payload_mismatch", "pending authorization の payload が一致しません");

      if (storedAuthorization?.status === "reclaimed") {
        if (!options.historicalReconciliation)
          return reject("stale_claim", "reclaim 済み authorization は新規 append に使用できません");
        await commit({
          claim: storedAuthorization.claim,
          binding: storedAuthorization.binding,
        });
        return this.finalizeAuthorization(layout, registry, storedAuthorization);
      }

      let pending = storedAuthorization;
      if (!pending) {
        if (command.expectedEntityVersion !== registry.entityVersion)
          return reject("stale_entity_version", "expected entityVersion が current と一致しません");
        const index = registry.claims.findIndex((claim) => claim.claimId === command.proof.claimId);
        if (index < 0) return reject("stale_claim", "current claim が見つかりません");
        const current = registry.claims[index]!;
        if (!proofMatches(current, command.proof))
          return reject("stale_claim", "current fencing proof と一致しません");
        if (
          current.runId !== command.runId ||
          current.runId !== command.proof.runId ||
          current.taskId !== command.taskId ||
          current.ownerId !== command.actorId
        )
          return reject(
            "stale_claim",
            "completion の run/task/actor lineage が claim と一致しません",
          );
        const now = this.dependencies.now();
        if (Date.parse(current.expiresAt) <= Date.parse(now))
          return reject("lease_expired", "期限切れ claim は completion できません");
        if (
          registry.authorizations.some(
            (authorization) =>
              authorization.status === "pending" && authorization.claim.claimId === current.claimId,
          )
        )
          return reject("authorization_pending", "同じ claim に未確定の authorization があります");
        pending = {
          status: "pending",
          eventId: command.eventId,
          payloadFingerprint,
          claim: current,
          binding: {
            claimId: current.claimId,
            fencingToken: current.fencingToken,
            ownerId: current.ownerId,
            runId: current.runId,
            taskId: current.taskId,
            commandFingerprint: command.commandFingerprint,
          },
          actorId: command.actorId,
          createdAt: now,
        };
        registry.authorizations.push(pending);
        await this.publishRegistry(layout, registry);
        await this.dependencies.afterAuthorizationPendingPublish?.();
      }

      if (pending.status !== "pending")
        return reject("stale_claim", "authorization は既に reclaim されています");
      const index = registry.claims.findIndex((claim) => claim.claimId === pending.claim.claimId);
      const current = registry.claims[index];
      if (!current || !canonicalJsonEquals(current, pending.claim))
        return reject("stale_claim", "pending authorization の claim lineage が失効しました");

      try {
        await commit({ claim: pending.claim, binding: pending.binding });
      } catch (error) {
        // RunGraphEventStore は append を commit した後には throw しない契約なので、
        // callback failure は未appendとして pending を解除し original proof を復活できる。
        registry.authorizations = registry.authorizations.filter(
          (authorization) => authorization.eventId !== command.eventId,
        );
        await this.publishRegistry(layout, registry);
        throw error;
      }
      return this.finalizeAuthorization(layout, registry, pending);
    });
  }

  async isDispatchConfigured(): Promise<boolean> {
    return (await resolveLayout(this.projectRoot)).dispatch !== undefined;
  }

  /** dispatch claimと同じregistry世代上でmutation対象を予約する。 */
  async reserveMutation(input: MutationReservationInput): Promise<MutationReservationResult> {
    const command = MutationReservationInputSchema.parse(input);
    return this.transact(async (layout, registry) => {
      const affected = new Set(command.affectedTaskIds);
      const current = registry.mutationReservations.find(
        (reservation) => reservation.proposalId === command.proposalId,
      );
      if (
        current &&
        current.ownerNonce === command.ownerNonce &&
        (current.sideEffectState === "in_flight" ||
          Date.parse(current.expiresAt) > Date.parse(this.dependencies.now()))
      ) {
        return {
          accepted: true as const,
          entityVersion: registry.entityVersion,
          reservation: current,
        };
      }
      if (command.expectedEntityVersion !== registry.entityVersion) {
        // lock待機中にdispatch claimが勝った場合だけ、共有registryを再読込してドメイン競合へ戻す。
        // claimがexpected世代以前から既知なら、別更新による真正なstaleを覆い隠さない。
        const durableRegistry = await this.readRegistry(layout);
        if (
          durableRegistry.claims.some(
            (claim) =>
              claim.entityVersion > command.expectedEntityVersion && affected.has(claim.taskId),
          )
        ) {
          return {
            accepted: false as const,
            entityVersion: durableRegistry.entityVersion,
            code: "dispatch_claim_conflict" as const,
            message: "mutation 対象 task に有効な dispatch claim があります",
          };
        }
        return {
          accepted: false as const,
          entityVersion: durableRegistry.entityVersion,
          code: "stale_entity_version" as const,
          message: "expected entityVersion が current と一致しません",
        };
      }
      if (registry.claims.some((claim) => affected.has(claim.taskId))) {
        return {
          accepted: false as const,
          entityVersion: registry.entityVersion,
          code: "dispatch_claim_conflict" as const,
          message: "mutation 対象 task に有効な dispatch claim があります",
        };
      }
      const now = this.dependencies.now();
      if (current && command.expectedEntityVersion === registry.entityVersion) {
        const entityVersion = registry.entityVersion + 1;
        const reservation = MutationReservationProofSchema.parse({
          ...current,
          ownerNonce: command.ownerNonce,
          fencingToken: entityVersion,
          affectedTaskIds: [...new Set(command.affectedTaskIds)].sort(),
          expiresAt: new Date(Date.parse(now) + command.leaseDurationSeconds * 1000).toISOString(),
          sideEffectState: current.sideEffectState,
        });
        registry.entityVersion = entityVersion;
        registry.mutationReservations = registry.mutationReservations.filter(
          (candidate) => candidate.proposalId !== command.proposalId,
        );
        registry.mutationReservations.push(reservation);
        await this.publishRegistry(layout, registry);
        return { accepted: true as const, entityVersion, reservation };
      }
      if (
        registry.mutationReservations.some(
          (reservation) =>
            (reservation.sideEffectState === "in_flight" ||
              Date.parse(reservation.expiresAt) > Date.parse(now)) &&
            reservation.affectedTaskIds.some((taskId) => affected.has(taskId)),
        )
      ) {
        return {
          accepted: false as const,
          entityVersion: registry.entityVersion,
          code: "mutation_reservation_conflict" as const,
          message: "mutation 対象 task は別 proposal に予約されています",
        };
      }
      const entityVersion = registry.entityVersion + 1;
      const reservation = MutationReservationProofSchema.parse({
        proposalId: command.proposalId,
        ownerNonce: command.ownerNonce,
        fencingToken: entityVersion,
        affectedTaskIds: [...new Set(command.affectedTaskIds)].sort(),
        expiresAt: new Date(Date.parse(now) + command.leaseDurationSeconds * 1000).toISOString(),
        sideEffectState: "idle",
      });
      registry.entityVersion = entityVersion;
      registry.mutationReservations = registry.mutationReservations.filter(
        (candidate) => candidate.proposalId !== command.proposalId,
      );
      registry.mutationReservations.push(reservation);
      await this.publishRegistry(layout, registry);
      return { accepted: true as const, entityVersion, reservation };
    });
  }

  /** Work Graph lease保持中に短時間だけmutation reservationのfencing proofを照合する。 */
  async assertMutationReservation(
    proof: MutationReservationProof,
  ): Promise<MutationReservationProof> {
    const expected = MutationReservationProofSchema.parse(proof);
    return this.transact(async (_layout, registry) => {
      const current = registry.mutationReservations.find(
        (reservation) => reservation.proposalId === expected.proposalId,
      );
      if (
        !current ||
        !canonicalJsonEquals(current, expected) ||
        (current.sideEffectState !== "in_flight" &&
          Date.parse(current.expiresAt) <= Date.parse(this.dependencies.now()))
      ) {
        throw new Error("stale_mutation_reservation");
      }
      return current;
    });
  }

  /** reservationを照合し、operation完了までdispatch coordination lockを保持する。 */
  async withMutationReservation<T>(
    proof: MutationReservationProof,
    operation: () => Promise<T>,
  ): Promise<T> {
    const expected = MutationReservationProofSchema.parse(proof);
    return this.transact(async (_layout, registry) => {
      const current = registry.mutationReservations.find(
        (reservation) => reservation.proposalId === expected.proposalId,
      );
      if (
        !current ||
        !canonicalJsonEquals(current, expected) ||
        (current.sideEffectState !== "in_flight" &&
          Date.parse(current.expiresAt) <= Date.parse(this.dependencies.now()))
      ) {
        throw new Error("stale_mutation_reservation");
      }
      return operation();
    });
  }

  /** リモートI/O開始前にexpiry非依存の永続的な排他へ昇格する。 */
  async beginMutationSideEffect(
    proof: MutationReservationProof,
    leaseDurationSeconds = 60,
  ): Promise<MutationReservationProof> {
    const expected = MutationReservationProofSchema.parse(proof);
    return this.transact(async (layout, registry) => {
      const index = registry.mutationReservations.findIndex(
        (reservation) => reservation.proposalId === expected.proposalId,
      );
      const current = registry.mutationReservations[index];
      if (
        !current ||
        !canonicalJsonEquals(current, expected) ||
        Date.parse(current.expiresAt) <= Date.parse(this.dependencies.now())
      ) {
        throw new Error("stale_mutation_reservation");
      }
      const entityVersion = registry.entityVersion + 1;
      const next = MutationReservationProofSchema.parse({
        ...current,
        fencingToken: entityVersion,
        expiresAt: new Date(
          Date.parse(this.dependencies.now()) + leaseDurationSeconds * 1000,
        ).toISOString(),
        sideEffectState: "in_flight",
      });
      registry.entityVersion = entityVersion;
      registry.mutationReservations[index] = next;
      await this.publishRegistry(layout, registry);
      return next;
    });
  }

  /** リモート結果をproposal journalへ確定後、通常leaseへ戻す。 */
  async completeMutationSideEffect(
    proof: MutationReservationProof,
    leaseDurationSeconds = 60,
  ): Promise<MutationReservationProof> {
    const expected = MutationReservationProofSchema.parse(proof);
    return this.transact(async (layout, registry) => {
      const index = registry.mutationReservations.findIndex(
        (reservation) => reservation.proposalId === expected.proposalId,
      );
      const current = registry.mutationReservations[index];
      if (
        !current ||
        !canonicalJsonEquals(current, expected) ||
        current.sideEffectState !== "in_flight"
      ) {
        throw new Error("stale_mutation_reservation");
      }
      const entityVersion = registry.entityVersion + 1;
      const next = MutationReservationProofSchema.parse({
        ...current,
        fencingToken: entityVersion,
        expiresAt: new Date(
          Date.parse(this.dependencies.now()) + leaseDurationSeconds * 1000,
        ).toISOString(),
        sideEffectState: "idle",
      });
      registry.entityVersion = entityVersion;
      registry.mutationReservations[index] = next;
      await this.publishRegistry(layout, registry);
      return next;
    });
  }

  async releaseMutationReservation(proof: MutationReservationProof): Promise<boolean> {
    const expected = MutationReservationProofSchema.parse(proof);
    return this.transact(async (layout, registry) => {
      const index = registry.mutationReservations.findIndex(
        (reservation) => reservation.proposalId === expected.proposalId,
      );
      if (index < 0 || !canonicalJsonEquals(registry.mutationReservations[index], expected)) {
        return false;
      }
      if (registry.mutationReservations[index]?.sideEffectState === "in_flight") return false;
      registry.mutationReservations.splice(index, 1);
      registry.entityVersion += 1;
      await this.publishRegistry(layout, registry);
      return true;
    });
  }

  /** stored authorization receipt の claim が現在も継続可能かを registry 上で照合する。 */
  async isReceiptClaimCurrent(
    receipt: Extract<DispatchClaimReceipt, { accepted: true; operation: "authorize_event" }>,
  ): Promise<boolean> {
    const parsed = DispatchClaimReceiptSchema.parse(receipt);
    if (!parsed.accepted || parsed.operation !== "authorize_event") return false;
    const layout = await resolveLayout(this.projectRoot);
    const release = await acquireLock(layout, this.dependencies);
    try {
      const registry = await this.readRegistry(layout);
      const stored = registry.receipts.find((item) => item.eventId === parsed.eventId);
      if (!stored || !canonicalJsonEquals(stored.receipt, parsed)) return false;
      const current = registry.claims.find((claim) => claim.claimId === parsed.claim.claimId);
      return current !== undefined && canonicalJsonEquals(current, parsed.claim);
    } finally {
      await release();
    }
  }

  async verifyReceipt(receipt: DispatchClaimReceipt): Promise<boolean> {
    const layout = await resolveLayout(this.projectRoot);
    const release = await acquireLock(layout, this.dependencies);
    try {
      const registry = await this.readRegistry(layout);
      return registry.receipts.some(
        (stored) =>
          stored.eventId === receipt.eventId && canonicalJsonEquals(stored.receipt, receipt),
      );
    } finally {
      await release();
    }
  }

  async assertCurrentClaim(
    proof: DispatchClaimProof,
    expectedEntityVersion: number,
  ): Promise<DispatchClaim> {
    const snapshot = await this.snapshot();
    if (snapshot.entityVersion !== expectedEntityVersion) throw new Error("stale_entity_version");
    const current = snapshot.claims.find((claim) => claim.claimId === proof.claimId);
    if (
      !current ||
      !proofMatches(current, proof) ||
      Date.parse(current.expiresAt) <= Date.parse(this.dependencies.now())
    ) {
      throw new Error("stale_claim");
    }
    return current;
  }

  async snapshot(): Promise<DispatchClaimSnapshot> {
    const layout = await resolveLayout(this.projectRoot);
    const release = await acquireLock(layout, this.dependencies);
    try {
      const registry = await this.readRegistry(layout);
      return {
        schemaVersion: "1",
        projectIdentity: registry.projectIdentity,
        entityVersion: registry.entityVersion,
        claims: registry.claims,
        pendingAuthorizations: registry.authorizations
          .filter((authorization) => authorization.status === "pending")
          .map((authorization) => ({
            eventId: authorization.eventId,
            claimId: authorization.claim.claimId,
          })),
        history: registry.history,
        mutationReservations: registry.mutationReservations,
      };
    } finally {
      await release();
    }
  }
}
