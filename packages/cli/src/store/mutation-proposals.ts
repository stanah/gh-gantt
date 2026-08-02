import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  MutationProposalReceiptSchema,
  MutationProposalSchema,
  type MutationProposal,
  type MutationProposalReceipt,
} from "@gh-gantt/shared";
import {
  resolveRepositoryCoordinationLayout,
  type RepositoryCoordinationLayout,
} from "./repository-coordination-layout.js";
import type { MutationReservationProof } from "./dispatch-claims.js";

const MAX_LOCK_RECOVERY_GENERATIONS = 64;

export interface MutationApplicationLease {
  proposalId: string;
  commandId: string;
  commandFingerprint: string;
  ownerNonce: string;
  fencingToken: number;
  stepId: string | null;
  expiresAt: string;
}

export interface MutationApplicationClaimInput {
  proposalId: string;
  commandId: string;
  commandFingerprint: string;
  ownerNonce: string;
  leaseDurationSeconds: number;
}

export type MutationApplicationLeaseResult =
  | { ok: true; lease: MutationApplicationLease }
  | {
      ok: false;
      code: "application_in_progress" | "invalid_application";
      lease?: MutationApplicationLease;
    };

const MutationApplicationLeaseSchema: z.ZodType<MutationApplicationLease> = z
  .object({
    proposalId: z.string().min(1),
    commandId: z.string().min(1),
    commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    ownerNonce: z.string().uuid(),
    fencingToken: z.number().int().positive(),
    stepId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const RegistrySchema = z
  .object({
    schemaVersion: z.literal("1"),
    projectIdentity: z.string().min(1),
    revision: z.number().int().nonnegative(),
    proposals: z.array(MutationProposalSchema),
    commandReceipts: z.array(
      z
        .object({
          commandId: z.string().min(1),
          commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
          receipt: MutationProposalReceiptSchema,
        })
        .strict(),
    ),
    applicationLeases: z.array(MutationApplicationLeaseSchema).default([]),
  })
  .strict();

export type MutationProposalRegistry = z.infer<typeof RegistrySchema>;

const LockOwnerSchema = z
  .object({
    schemaVersion: z.literal("1"),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    nonce: z.string().uuid(),
    acquiredAt: z.string().datetime(),
  })
  .strict();

const LockRecoveryClaimSchema = z
  .object({
    schemaVersion: z.literal("1"),
    expectedOwnerNonce: z.string().uuid(),
    claimant: z
      .object({
        pid: z.number().int().positive(),
        hostname: z.string().min(1),
        nonce: z.string().uuid(),
        claimedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export class MutationProposalLockError extends Error {
  constructor(
    readonly code: "ownerless_lock" | "corrupt_lock_owner",
    message: string,
  ) {
    super(message);
    this.name = "MutationProposalLockError";
  }
}

export interface MutationProposalStoreDependencies {
  resolveLayout?: (projectRoot: string) => Promise<RepositoryCoordinationLayout>;
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  processIdentity?: { pid: number; hostname: string };
  waitTimeoutMs?: number;
  /** テスト専用: recordReceiptがjournal lock取得を試みる直前のbarrier。 */
  beforeRecordLockAcquire?: () => Promise<void>;
  /** テスト専用: dead owner観測後の決定的なinterleaving point。 */
  afterDeadOwnerObserved?: (ownerNonce: string) => Promise<void>;
  /** テスト専用: recovery winnerの最終検証後・LOCK retire前の停止を模擬する。 */
  afterRecoveryClaimValidated?: (
    expectedOwnerNonce: string,
    claimantNonce: string,
  ) => Promise<void>;
}

type ResolvedMutationProposalStoreDependencies = Required<MutationProposalStoreDependencies>;

export interface MutationProposalRecordOptions {
  /** nullはproposal新規作成、数値は既存proposal revisionのCASを表す。 */
  expectedProposalRevision?: number | null;
  allowedStatuses?: MutationProposal["status"][];
  /** remote outcomeを記録する場合に、proposal ownerを同じjournal lock内で照合する。 */
  applicationLease?: MutationApplicationLease;
  /** remote outcomeを記録する場合に、mutation reservationを同じtransaction内で照合する。 */
  mutationReservation?: MutationReservationProof;
  /** reservation registry lockをcommit完了まで保持するguard。 */
  withMutationReservation?: <T>(
    proof: MutationReservationProof,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

export type MutationProposalRecordResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "command_payload_mismatch"
        | "command_replayed"
        | "stale_revision"
        | "invalid_lifecycle";
      currentProposal: MutationProposal | null;
      receipt?: MutationProposalReceipt;
    };

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function recoveryClaimPath(lockPath: string, expectedOwnerNonce: string): string {
  return join(lockPath, `recovery-claim-${expectedOwnerNonce}.json`);
}

function recoverySuccessorPath(
  lockPath: string,
  expectedOwnerNonce: string,
  predecessorNonce: string,
): string {
  return join(lockPath, `recovery-successor-${expectedOwnerNonce}-${predecessorNonce}.json`);
}

function parseRecoveryClaim(
  raw: string,
  expectedOwnerNonce: string,
): z.infer<typeof LockRecoveryClaimSchema> | null {
  try {
    const claim = LockRecoveryClaimSchema.parse(JSON.parse(raw));
    return claim.expectedOwnerNonce === expectedOwnerNonce ? claim : null;
  } catch {
    return null;
  }
}

function createRecoveryClaim(
  expectedOwnerNonce: string,
  owner: z.infer<typeof LockOwnerSchema>,
  dependencies: ResolvedMutationProposalStoreDependencies,
): z.infer<typeof LockRecoveryClaimSchema> {
  return LockRecoveryClaimSchema.parse({
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
  claim: z.infer<typeof LockRecoveryClaimSchema>,
): Promise<void> {
  const candidate = `${markerPath}.candidate-${claimantNonce}`;
  await writeFile(candidate, `${JSON.stringify(claim, null, 2)}\n`, { flag: "wx" });
  try {
    // hard linkで既存winnerを上書きせず、claimをatomicに公開する。
    await link(candidate, markerPath);
  } finally {
    await rm(candidate, { force: true }).catch(() => undefined);
  }
}

async function retireObservedDeadOwnerGeneration(
  lockPath: string,
  observedOwner: z.infer<typeof LockOwnerSchema>,
  contender: z.infer<typeof LockOwnerSchema>,
  dependencies: ResolvedMutationProposalStoreDependencies,
): Promise<boolean> {
  let markerPath = recoveryClaimPath(lockPath, observedOwner.nonce);
  let markerRaw = await readOptional(markerPath);
  if (markerRaw === null) {
    await publishRecoveryClaim(
      markerPath,
      contender.nonce,
      createRecoveryClaim(observedOwner.nonce, contender, dependencies),
    );
    markerRaw = await readOptional(markerPath);
    if (markerRaw === null) return false;
  }

  const visitedMarkers = new Set<string>();
  for (let generation = 0; generation < MAX_LOCK_RECOVERY_GENERATIONS; generation += 1) {
    if (visitedMarkers.has(markerPath)) return false;
    visitedMarkers.add(markerPath);
    const recoveryClaim = parseRecoveryClaim(markerRaw, observedOwner.nonce);
    const predecessor =
      recoveryClaim?.claimant.nonce ??
      `malformed-${createHash("sha256").update(markerRaw).digest("hex")}`;
    const successorPath = recoverySuccessorPath(lockPath, observedOwner.nonce, predecessor);

    if (recoveryClaim?.claimant.nonce === contender.nonce) {
      const [validatedOwnerRaw, validatedRecoveryRaw, validatedSuccessorRaw] = await Promise.all([
        readOptional(join(lockPath, "owner.json")),
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
      const [latestOwnerRaw, latestRecoveryRaw, latestSuccessorRaw] = await Promise.all([
        readOptional(join(lockPath, "owner.json")),
        readOptional(markerPath),
        readOptional(successorPath),
      ]);
      if (!latestOwnerRaw || latestRecoveryRaw !== markerRaw || latestSuccessorRaw !== null) {
        return false;
      }
      const latestOwner = LockOwnerSchema.parse(JSON.parse(latestOwnerRaw));
      const latestRecovery = parseRecoveryClaim(latestRecoveryRaw, observedOwner.nonce);
      if (
        latestOwner.nonce !== observedOwner.nonce ||
        latestRecovery?.claimant.nonce !== contender.nonce
      ) {
        return false;
      }
      const recovered = `${lockPath}.recovered-${observedOwner.nonce}-${randomUUID()}`;
      await rename(lockPath, recovered);
      const retiredOwner = LockOwnerSchema.parse(
        JSON.parse(await readFile(join(recovered, "owner.json"), "utf8")),
      );
      if (retiredOwner.nonce !== observedOwner.nonce) {
        throw new Error("retire 対象の mutation proposal lock owner 世代が変化しました");
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
    );
    const publishedRaw = await readOptional(successorPath);
    if (publishedRaw === null) return false;
    markerPath = successorPath;
    markerRaw = publishedRaw;
  }
  return false;
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
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

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/** proposal journal専用root/LOCKを使い、claim/cache journalと共有しない。 */
export class MutationProposalStore {
  private readonly dependencies: ResolvedMutationProposalStoreDependencies;

  constructor(
    private readonly projectRoot: string,
    dependencies: MutationProposalStoreDependencies = {},
  ) {
    this.dependencies = {
      resolveLayout: dependencies.resolveLayout ?? resolveRepositoryCoordinationLayout,
      now: dependencies.now ?? (() => new Date().toISOString()),
      isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
      processIdentity: dependencies.processIdentity ?? { pid: process.pid, hostname: hostname() },
      waitTimeoutMs: dependencies.waitTimeoutMs ?? 5_000,
      beforeRecordLockAcquire: dependencies.beforeRecordLockAcquire ?? (async () => undefined),
      afterDeadOwnerObserved: dependencies.afterDeadOwnerObserved ?? (async () => undefined),
      afterRecoveryClaimValidated:
        dependencies.afterRecoveryClaimValidated ?? (async () => undefined),
    };
  }

  private async acquireLock(root: string): Promise<() => Promise<void>> {
    await mkdir(root, { recursive: true });
    const lockPath = join(root, "LOCK");
    const owner = LockOwnerSchema.parse({
      schemaVersion: "1",
      ...this.dependencies.processIdentity,
      nonce: randomUUID(),
      acquiredAt: this.dependencies.now(),
    });
    const deadline = Date.now() + this.dependencies.waitTimeoutMs;
    while (true) {
      const candidate = `${lockPath}.candidate-${owner.nonce}`;
      try {
        await mkdir(candidate);
        await writeFile(join(candidate, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
          flag: "wx",
        });
        await rename(candidate, lockPath);
        break;
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        const raw = await readOptional(join(lockPath, "owner.json"));
        if (raw === null) {
          // releaseとの競合でLOCK自体が消えた可能性があるため、deadlineまでは再試行する。
          // atomic candidate publishで空のlegacy LOCKは安全に置換できるが、内容を持つownerless
          // LOCKは生存中の旧writerと区別できないため、推測で削除しない。
          if (Date.now() >= deadline) {
            throw new MutationProposalLockError(
              "ownerless_lock",
              "mutation proposal store lock にowner.jsonがありません。全writerの停止を確認してLOCKを手動回収してください",
            );
          }
          await sleep(20);
          continue;
        }
        if (raw !== null) {
          let existing: z.infer<typeof LockOwnerSchema>;
          try {
            existing = LockOwnerSchema.parse(JSON.parse(raw));
          } catch {
            if (Date.now() >= deadline) {
              throw new MutationProposalLockError(
                "corrupt_lock_owner",
                "mutation proposal store lock のowner.jsonが破損しています。全writerの停止を確認してLOCKを手動回収してください",
              );
            }
            await sleep(20);
            continue;
          }
          if (
            existing.hostname === owner.hostname &&
            !this.dependencies.isProcessAlive(existing.pid)
          ) {
            await this.dependencies.afterDeadOwnerObserved(existing.nonce);
            try {
              if (
                await retireObservedDeadOwnerGeneration(
                  lockPath,
                  existing,
                  owner,
                  this.dependencies,
                )
              ) {
                continue;
              }
            } catch (recoveryError) {
              const recoveryCode = (recoveryError as NodeJS.ErrnoException).code;
              if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(recoveryCode ?? "")) {
                throw recoveryError;
              }
            }
          }
        }
        if (Date.now() >= deadline) throw new Error("mutation proposal store は使用中です");
        await sleep(20);
      }
    }
    return async () => {
      const raw = await readOptional(join(lockPath, "owner.json"));
      const current = raw ? LockOwnerSchema.parse(JSON.parse(raw)) : null;
      if (!current || current.nonce !== owner.nonce) {
        throw new Error("mutation proposal store lock の所有権を失いました");
      }
      const retired = `${lockPath}.retired-${owner.nonce}`;
      await rename(lockPath, retired);
      await rm(retired, { recursive: true, force: true });
    };
  }

  private async readRegistry(
    layout: RepositoryCoordinationLayout,
  ): Promise<MutationProposalRegistry> {
    const path = join(layout.mutationProposalRoot, "registry.json");
    const raw = await readOptional(path);
    if (!raw) {
      return {
        schemaVersion: "1",
        projectIdentity: layout.projectIdentity,
        revision: 0,
        proposals: [],
        commandReceipts: [],
        applicationLeases: [],
      };
    }
    const registry = RegistrySchema.parse(JSON.parse(raw));
    if (registry.projectIdentity !== layout.projectIdentity) {
      throw new Error("mutation proposal store のproject identityが一致しません");
    }
    return registry;
  }

  async readAll(): Promise<MutationProposalRegistry> {
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      return structuredClone(await this.readRegistry(layout));
    } finally {
      await release();
    }
  }

  async get(proposalId: string): Promise<MutationProposal | null> {
    const registry = await this.readAll();
    return registry.proposals.find((proposal) => proposal.proposalId === proposalId) ?? null;
  }

  /** 同一apply commandのリモート実行ownerを短期leaseで一意にする。 */
  async claimApplication(
    input: MutationApplicationClaimInput,
  ): Promise<MutationApplicationLeaseResult> {
    const command = z
      .object({
        proposalId: z.string().min(1),
        commandId: z.string().min(1),
        commandFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        ownerNonce: z.string().uuid(),
        leaseDurationSeconds: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      const proposal = registry.proposals.find(
        (candidate) => candidate.proposalId === command.proposalId,
      );
      const receipt = registry.commandReceipts.find(
        (candidate) => candidate.commandId === command.commandId,
      );
      if (
        !proposal ||
        (proposal.status !== "applying" &&
          proposal.status !== "reconciling" &&
          proposal.status !== "compensating") ||
        !receipt ||
        receipt.commandFingerprint !== command.commandFingerprint ||
        receipt.receipt.proposalId !== command.proposalId
      ) {
        return { ok: false, code: "invalid_application" };
      }
      const now = this.dependencies.now();
      const current = registry.applicationLeases.find(
        (candidate) => candidate.proposalId === command.proposalId,
      );
      if (current && Date.parse(current.expiresAt) > Date.parse(now)) {
        if (
          current.commandId === command.commandId &&
          current.commandFingerprint === command.commandFingerprint &&
          current.ownerNonce === command.ownerNonce
        ) {
          return { ok: true, lease: structuredClone(current) };
        }
        return {
          ok: false,
          code: "application_in_progress",
          lease: structuredClone(current),
        };
      }
      const lease = MutationApplicationLeaseSchema.parse({
        proposalId: command.proposalId,
        commandId: command.commandId,
        commandFingerprint: command.commandFingerprint,
        ownerNonce: command.ownerNonce,
        fencingToken: (current?.fencingToken ?? 0) + 1,
        stepId: null,
        expiresAt: new Date(Date.parse(now) + command.leaseDurationSeconds * 1000).toISOString(),
      });
      registry.applicationLeases = registry.applicationLeases.filter(
        (candidate) => candidate.proposalId !== command.proposalId,
      );
      registry.applicationLeases.push(lease);
      const validated = RegistrySchema.parse({ ...registry, revision: registry.revision + 1 });
      await writeAtomic(join(layout.mutationProposalRoot, "registry.json"), validated);
      return { ok: true, lease: structuredClone(lease) };
    } finally {
      await release();
    }
  }

  /** リモートprimitive直前にowner/tokenをCASし、古いprocessをfenceする。 */
  async fenceApplication(input: {
    lease: MutationApplicationLease;
    stepId: string;
    leaseDurationSeconds: number;
  }): Promise<MutationApplicationLeaseResult> {
    const expected = MutationApplicationLeaseSchema.parse(input.lease);
    const stepId = z.string().min(1).parse(input.stepId);
    const duration = z.number().int().positive().parse(input.leaseDurationSeconds);
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      const index = registry.applicationLeases.findIndex(
        (candidate) => candidate.proposalId === expected.proposalId,
      );
      const current = registry.applicationLeases[index];
      if (
        !current ||
        JSON.stringify(current) !== JSON.stringify(expected) ||
        Date.parse(current.expiresAt) <= Date.parse(this.dependencies.now())
      ) {
        return {
          ok: false,
          code: "application_in_progress",
          ...(current ? { lease: structuredClone(current) } : {}),
        };
      }
      const next = MutationApplicationLeaseSchema.parse({
        ...current,
        fencingToken: current.fencingToken + 1,
        stepId,
        expiresAt: new Date(Date.parse(this.dependencies.now()) + duration * 1000).toISOString(),
      });
      registry.applicationLeases[index] = next;
      const validated = RegistrySchema.parse({ ...registry, revision: registry.revision + 1 });
      await writeAtomic(join(layout.mutationProposalRoot, "registry.json"), validated);
      return { ok: true, lease: structuredClone(next) };
    } finally {
      await release();
    }
  }

  /** リモートoutcomeのpublish直前にowner/token/expiryを再照合する。 */
  async assertApplication(lease: MutationApplicationLease): Promise<MutationApplicationLease> {
    const expected = MutationApplicationLeaseSchema.parse(lease);
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      return structuredClone(this.assertApplicationInRegistry(registry, expected));
    } finally {
      await release();
    }
  }

  /** application leaseを照合し、operation完了までproposal registry lockを保持する。 */
  async withApplicationLease<T>(
    lease: MutationApplicationLease,
    operation: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    const expected = MutationApplicationLeaseSchema.parse(lease);
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      const assertCurrent = () => {
        this.assertApplicationInRegistry(registry, expected);
      };
      assertCurrent();
      return await operation(assertCurrent);
    } finally {
      await release();
    }
  }

  async releaseApplication(lease: MutationApplicationLease): Promise<boolean> {
    const expected = MutationApplicationLeaseSchema.parse(lease);
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      const index = registry.applicationLeases.findIndex(
        (candidate) => candidate.proposalId === expected.proposalId,
      );
      if (
        index < 0 ||
        JSON.stringify(registry.applicationLeases[index]) !== JSON.stringify(expected)
      ) {
        return false;
      }
      registry.applicationLeases.splice(index, 1);
      const validated = RegistrySchema.parse({ ...registry, revision: registry.revision + 1 });
      await writeAtomic(join(layout.mutationProposalRoot, "registry.json"), validated);
      return true;
    } finally {
      await release();
    }
  }

  async mutate<T>(operation: (registry: MutationProposalRegistry) => Promise<T> | T): Promise<T> {
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      const result = await operation(registry);
      const validated = RegistrySchema.parse({ ...registry, revision: registry.revision + 1 });
      await writeAtomic(join(layout.mutationProposalRoot, "registry.json"), validated);
      return result;
    } finally {
      await release();
    }
  }

  async recordReceipt(
    proposal: MutationProposal,
    receipt: MutationProposalReceipt,
    options: MutationProposalRecordOptions = {},
  ): Promise<MutationProposalRecordResult> {
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    await this.dependencies.beforeRecordLockAcquire();
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      const fencedOptions = [
        options.applicationLease,
        options.mutationReservation,
        options.withMutationReservation,
      ];
      const hasFence = fencedOptions.some((value) => value !== undefined);
      if (hasFence && fencedOptions.some((value) => value === undefined)) {
        throw new Error("proposal outcomeのdual fence contextが不完全です");
      }
      if (options.applicationLease) {
        this.assertApplicationInRegistry(
          registry,
          MutationApplicationLeaseSchema.parse(options.applicationLease),
        );
      }
      const commit = async (): Promise<MutationProposalRecordResult> => {
        if (options.applicationLease) {
          this.assertApplicationInRegistry(
            registry,
            MutationApplicationLeaseSchema.parse(options.applicationLease),
          );
        }
        const prior = registry.commandReceipts.find((item) => item.commandId === receipt.commandId);
        const currentProposal =
          registry.proposals.find((item) => item.proposalId === proposal.proposalId) ?? null;
        if (prior && prior.commandFingerprint !== receipt.commandFingerprint) {
          return {
            ok: false,
            code: "command_payload_mismatch",
            currentProposal: structuredClone(currentProposal),
          };
        }
        if (prior && prior.receipt.proposalId !== receipt.proposalId) {
          const priorProposal =
            prior.receipt.proposalId === null
              ? null
              : (registry.proposals.find(
                  (candidate) => candidate.proposalId === prior.receipt.proposalId,
                ) ?? null);
          return {
            ok: false,
            code: "command_replayed",
            currentProposal: structuredClone(priorProposal),
            receipt: structuredClone(prior.receipt),
          };
        }
        if (
          options.expectedProposalRevision === null
            ? currentProposal !== null
            : options.expectedProposalRevision !== undefined &&
              currentProposal?.revision !== options.expectedProposalRevision
        ) {
          return {
            ok: false,
            code: "stale_revision",
            currentProposal: structuredClone(currentProposal),
            ...(prior ? { receipt: structuredClone(prior.receipt) } : {}),
          };
        }
        if (
          currentProposal &&
          options.allowedStatuses &&
          !options.allowedStatuses.includes(currentProposal.status)
        ) {
          return {
            ok: false,
            code: "invalid_lifecycle",
            currentProposal: structuredClone(currentProposal),
            ...(prior ? { receipt: structuredClone(prior.receipt) } : {}),
          };
        }
        if (
          prior &&
          (options.expectedProposalRevision === undefined ||
            proposal.revision <= (currentProposal?.revision ?? 0))
        ) {
          return {
            ok: false,
            code: "command_replayed",
            currentProposal: structuredClone(currentProposal),
            receipt: structuredClone(prior.receipt),
          };
        }
        const proposalIndex = registry.proposals.findIndex(
          (item) => item.proposalId === proposal.proposalId,
        );
        if (proposalIndex >= 0)
          registry.proposals[proposalIndex] = MutationProposalSchema.parse(proposal);
        else registry.proposals.push(MutationProposalSchema.parse(proposal));
        const receiptIndex = registry.commandReceipts.findIndex(
          (item) => item.commandId === receipt.commandId,
        );
        const stored = {
          commandId: receipt.commandId,
          commandFingerprint: receipt.commandFingerprint,
          receipt: MutationProposalReceiptSchema.parse(receipt),
        };
        if (receiptIndex >= 0) registry.commandReceipts[receiptIndex] = stored;
        else registry.commandReceipts.push(stored);
        const validated = RegistrySchema.parse({ ...registry, revision: registry.revision + 1 });
        await writeAtomic(join(layout.mutationProposalRoot, "registry.json"), validated);
        return { ok: true };
      };
      if (options.mutationReservation && options.withMutationReservation) {
        return options.withMutationReservation(options.mutationReservation, commit);
      }
      return commit();
    } finally {
      await release();
    }
  }

  private assertApplicationInRegistry(
    registry: MutationProposalRegistry,
    expected: MutationApplicationLease,
  ): MutationApplicationLease {
    const current = registry.applicationLeases.find(
      (candidate) => candidate.proposalId === expected.proposalId,
    );
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(expected) ||
      Date.parse(current.expiresAt) <= Date.parse(this.dependencies.now())
    ) {
      throw new Error("stale_application_lease");
    }
    return current;
  }

  /** 追記成功済みaudit envelopeだけをproposal revision CAS下でoutboxから除去する。 */
  async acknowledgeAudit(
    proposalId: string,
    eventId: string,
    expectedProposalRevision: number,
  ): Promise<boolean> {
    const layout = await this.dependencies.resolveLayout(this.projectRoot);
    const release = await this.acquireLock(layout.mutationProposalRoot);
    try {
      const registry = await this.readRegistry(layout);
      const proposal = registry.proposals.find((item) => item.proposalId === proposalId);
      if (!proposal || proposal.revision !== expectedProposalRevision) return false;
      if (!proposal.pendingAudits.some((event) => event.eventId === eventId)) return true;
      proposal.pendingAudits = proposal.pendingAudits.filter((event) => event.eventId !== eventId);
      proposal.pendingAuditEventIds = proposal.pendingAuditEventIds.filter((id) => id !== eventId);
      const validated = RegistrySchema.parse({ ...registry, revision: registry.revision + 1 });
      await writeAtomic(join(layout.mutationProposalRoot, "registry.json"), validated);
      return true;
    } finally {
      await release();
    }
  }
}
