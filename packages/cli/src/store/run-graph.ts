import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  GANTT_DIR,
  RUN_GRAPH_DIR,
  RUN_GRAPH_RUNS_DIR,
  RunGraphAcceptedEventReadSchema,
  RunGraphAcceptedEventSchema,
  RunGraphJournalSchema,
  RunGraphRejectionReadSchema,
  RunGraphRejectionSchema,
  type RunGraphAcceptedEvent,
  type RunGraphJournal,
  type RunGraphRejection,
} from "@gh-gantt/shared";

export interface RunGraphRunLocator {
  runId: string;
  task: { owner: string; repo: string; issueNumber: number };
  updatedAt: string;
}

export interface RunGraphRunLocatorQuery {
  task: { owner: string; repo: string; issueNumber: number };
  limit: number;
  selectedRunId?: string;
}

interface RunGraphTaskLocatorIndex {
  schemaVersion: "1";
  task: { owner: string; repo: string; issueNumber: number };
  total: number;
  items: RunGraphRunLocator[];
}

interface RunGraphPendingLocatorTransaction {
  schemaVersion: "1";
  event: { runId: string; eventId: string; sequence: number };
  locator: RunGraphRunLocator;
  taskIndex: RunGraphTaskLocatorIndex;
  restoreCompleteState: boolean;
}

export interface RunGraphEventStoreDependencies {
  /** test only: journal commit と派生 index commit の境界を模擬する。 */
  afterJournalCommit?: () => Promise<void>;
}

const RUN_GRAPH_LOCATOR_INDEX_DIR = "locator-index";
const RUN_GRAPH_LOCATOR_INDEX_LIMIT = 50;
const RECOVERY_CLAIM_STALE_MS = 60_000;
const RUN_GRAPH_LOCATOR_READ_LEASE_TIMEOUT_MS = 100;

export class RunGraphLocatorIndexBusyError extends Error {
  override readonly name = "RunGraphLocatorIndexBusyError";
}

export class RunGraphLocatorIndexNotReadyError extends Error {
  override readonly name = "RunGraphLocatorIndexNotReadyError";
}

const RunGraphTaskSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
  })
  .strict();

const RunGraphRunLocatorSchema: z.ZodType<RunGraphRunLocator> = z
  .object({
    runId: z.string().min(1),
    task: RunGraphTaskSchema,
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const RunGraphTaskLocatorIndexSchema: z.ZodType<RunGraphTaskLocatorIndex> = z
  .object({
    schemaVersion: z.literal("1"),
    task: RunGraphTaskSchema,
    total: z.number().int().nonnegative(),
    items: z.array(RunGraphRunLocatorSchema).max(RUN_GRAPH_LOCATOR_INDEX_LIMIT),
  })
  .strict()
  .superRefine((index, context) => {
    if (index.items.length > index.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "locator items は total 以下である必要があります",
      });
    }
    if (new Set(index.items.map((item) => item.runId)).size !== index.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "locator runId は一意である必要があります",
      });
    }
    if (index.items.some((item) => !sameTask(item.task, index.task))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "locator task は index task と一致する必要があります",
      });
    }
  });

const RunGraphLocatorIndexStateSchema = z
  .object({
    schemaVersion: z.literal("1"),
    rebuiltAt: z.string().datetime({ offset: true }),
  })
  .strict();

const RunGraphLocatorIndexLockOwnerSchema = z
  .object({
    schemaVersion: z.literal("1"),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    nonce: z.string().uuid(),
  })
  .strict();

const RunGraphLocatorIndexRecoveryClaimSchema = z
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

const RunGraphPendingLocatorTransactionSchema: z.ZodType<RunGraphPendingLocatorTransaction> = z
  .object({
    schemaVersion: z.literal("1"),
    event: z
      .object({
        runId: z.string().min(1),
        eventId: z.string().min(1),
        sequence: z.number().int().positive(),
      })
      .strict(),
    locator: RunGraphRunLocatorSchema,
    taskIndex: RunGraphTaskLocatorIndexSchema,
    restoreCompleteState: z.boolean(),
  })
  .strict()
  .superRefine((transaction, context) => {
    if (
      transaction.event.runId !== transaction.locator.runId ||
      !sameTask(transaction.locator.task, transaction.taskIndex.task)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["locator"],
        message: "pending transaction の event・locator・task index は一致する必要があります",
      });
    }
  });

function safeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function restoreSegment(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function normalizedTask(task: RunGraphRunLocator["task"]): RunGraphRunLocator["task"] {
  return {
    owner: task.owner.toLowerCase(),
    repo: task.repo.toLowerCase(),
    issueNumber: task.issueNumber,
  };
}

function taskKey(task: RunGraphRunLocator["task"]): string {
  const normalized = normalizedTask(task);
  return `${normalized.owner}/${normalized.repo}#${normalized.issueNumber}`;
}

function sameTask(left: RunGraphRunLocator["task"], right: RunGraphRunLocator["task"]): boolean {
  return taskKey(left) === taskKey(right);
}

function sortLocators(locators: RunGraphRunLocator[]): RunGraphRunLocator[] {
  return [...locators].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.runId.localeCompare(right.runId),
  );
}

async function readJsonOptional<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLocatorIndexLease(
  locatorIndexRoot: string,
  timeoutMs = 30_000,
): Promise<() => Promise<void>> {
  await mkdir(locatorIndexRoot, { recursive: true });
  const lockDir = join(locatorIndexRoot, "LOCK");
  const owner = RunGraphLocatorIndexLockOwnerSchema.parse({
    schemaVersion: "1",
    pid: process.pid,
    hostname: hostname(),
    nonce: randomUUID(),
  });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const candidate = `${lockDir}.candidate-${owner.nonce}`;
    try {
      await mkdir(candidate);
      await writeJsonAtomic(join(candidate, "owner.json"), owner);
      await rename(candidate, lockDir);
      break;
    } catch (error) {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;

      const existing = await readJsonOptional(
        join(lockDir, "owner.json"),
        RunGraphLocatorIndexLockOwnerSchema,
      );
      if (!existing) continue;
      const claimPath = join(lockDir, "recovery-claim.json");
      const recoveryClaim = await readJsonOptional(
        claimPath,
        RunGraphLocatorIndexRecoveryClaimSchema,
      );
      if (recoveryClaim && recoveryClaim.expectedOwnerNonce !== existing.nonce) {
        throw new Error("Run Graph locator index の recovery claim が owner と一致しません");
      }
      const claimAge = recoveryClaim
        ? Date.now() - Date.parse(recoveryClaim.claimant.claimedAt)
        : 0;
      const claimantDead =
        recoveryClaim?.claimant.hostname === owner.hostname &&
        !isProcessAlive(recoveryClaim.claimant.pid);
      if (recoveryClaim && (claimantDead || claimAge >= RECOVERY_CLAIM_STALE_MS)) {
        const confirmedOwner = await readJsonOptional(
          join(lockDir, "owner.json"),
          RunGraphLocatorIndexLockOwnerSchema,
        );
        const confirmedClaim = await readJsonOptional(
          claimPath,
          RunGraphLocatorIndexRecoveryClaimSchema,
        );
        if (
          confirmedOwner?.nonce === recoveryClaim.expectedOwnerNonce &&
          confirmedClaim?.claimant.nonce === recoveryClaim.claimant.nonce
        ) {
          const recovered = `${lockDir}.recovered-${existing.nonce}-${randomUUID()}`;
          try {
            await rename(lockDir, recovered);
            await rm(recovered, { recursive: true, force: true });
            continue;
          } catch (recoveryError) {
            const recoveryCode = (recoveryError as NodeJS.ErrnoException).code;
            if (
              recoveryCode !== "ENOENT" &&
              recoveryCode !== "EEXIST" &&
              recoveryCode !== "ENOTEMPTY"
            ) {
              throw recoveryError;
            }
            continue;
          }
        }
      }
      if (!recoveryClaim && existing.hostname === owner.hostname && !isProcessAlive(existing.pid)) {
        const claim = RunGraphLocatorIndexRecoveryClaimSchema.parse({
          schemaVersion: "1",
          expectedOwnerNonce: existing.nonce,
          claimant: {
            pid: owner.pid,
            hostname: owner.hostname,
            nonce: owner.nonce,
            claimedAt: new Date().toISOString(),
          },
        });
        try {
          await writeFile(claimPath, JSON.stringify(claim, null, 2) + "\n", { flag: "wx" });
          const confirmed = await readJsonOptional(
            join(lockDir, "owner.json"),
            RunGraphLocatorIndexLockOwnerSchema,
          );
          if (confirmed?.nonce === claim.expectedOwnerNonce) {
            const recovered = `${lockDir}.recovered-${existing.nonce}-${randomUUID()}`;
            await rename(lockDir, recovered);
            await rm(recovered, { recursive: true, force: true });
            continue;
          }
        } catch (recoveryError) {
          const recoveryCode = (recoveryError as NodeJS.ErrnoException).code;
          if (
            recoveryCode !== "ENOENT" &&
            recoveryCode !== "EEXIST" &&
            recoveryCode !== "ENOTEMPTY"
          ) {
            throw recoveryError;
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new RunGraphLocatorIndexBusyError(
          `Run Graph locator index は別 process が使用中です (pid=${existing.pid}, host=${existing.hostname})`,
        );
      }
      await sleep(25);
    }
  }

  return async () => {
    const current = await readJsonOptional(
      join(lockDir, "owner.json"),
      RunGraphLocatorIndexLockOwnerSchema,
    );
    if (!current || current.nonce !== owner.nonce) {
      throw new Error("Run Graph locator index lock の所有権を失いました");
    }
    const retired = `${lockDir}.retired-${owner.nonce}-${randomUUID()}`;
    await rename(lockDir, retired);
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
  };
}

async function withLocatorIndexLease<T>(
  locatorIndexRoot: string,
  operation: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const release = await acquireLocatorIndexLease(locatorIndexRoot, timeoutMs);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function listJsonFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** run ごとの accepted event を immutable sequence segment として保持する。 */
export class RunGraphEventStore {
  private readonly root: string;
  private readonly locatorIndexRoot: string;
  private readonly dependencies: RunGraphEventStoreDependencies;

  constructor(projectRoot: string, dependencies: RunGraphEventStoreDependencies = {}) {
    this.root = join(projectRoot, GANTT_DIR, RUN_GRAPH_DIR, RUN_GRAPH_RUNS_DIR);
    this.locatorIndexRoot = join(
      projectRoot,
      GANTT_DIR,
      RUN_GRAPH_DIR,
      RUN_GRAPH_LOCATOR_INDEX_DIR,
    );
    this.dependencies = dependencies;
  }

  private runDir(runId: string): string {
    return join(this.root, safeSegment(runId));
  }

  async appendAccepted(input: RunGraphAcceptedEvent): Promise<void> {
    const event = RunGraphAcceptedEventSchema.parse(input);
    const release = await acquireLocatorIndexLease(this.locatorIndexRoot);
    let journalCommitted = false;
    let failure: unknown = null;
    try {
      await mkdir(this.locatorIndexRoot, { recursive: true });
      await this.recoverPendingLocatorTransaction();
      const eventsDir = join(this.runDir(event.runId), "events");
      await mkdir(eventsDir, { recursive: true });
      const journal = await this.readJournalOrEmpty(event.runId);
      if (journal.acceptedEvents.some((item) => item.eventId === event.eventId)) {
        throw new Error(`duplicate event ID: ${event.eventId}`);
      }
      const expected = journal.acceptedEvents.length + 1;
      if (event.sequence < expected) {
        throw new Error(`duplicate event segment: ${event.eventId}`);
      }
      if (event.sequence !== expected) {
        throw new Error(`event sequence は ${expected} である必要があります`);
      }
      const first = event.sequence === 1 ? event : journal.acceptedEvents[0];
      if (first?.command.type !== "run_started") {
        throw new Error(`Run Graph の先頭 event が run_started ではありません: ${event.runId}`);
      }
      const transaction = await this.prepareLocatorTransaction(event, {
        runId: event.runId,
        task: first.command.task,
        updatedAt: event.acceptedAt,
      });
      await writeJsonAtomic(this.pendingLocatorTransactionPath(), transaction);
      await rm(this.locatorIndexStatePath(), { force: true });
      const filePath = join(eventsDir, `${String(event.sequence).padStart(12, "0")}.json`);
      try {
        await writeFile(filePath, JSON.stringify(event, null, 2) + "\n", { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`duplicate event segment: ${event.eventId}`);
        }
        throw error;
      }
      journalCommitted = true;
      await this.dependencies.afterJournalCommit?.();
      await this.applyPendingLocatorTransaction(transaction);
    } catch (error) {
      failure = error;
      if (!journalCommitted) {
        await rm(this.pendingLocatorTransactionPath(), { force: true }).catch(() => undefined);
      }
    }
    try {
      await release();
    } catch (error) {
      failure ??= error;
    }
    // event segment が確定した後は accepted を正本とし、残った WAL を次回 bounded 修復する。
    if (failure && !journalCommitted) throw failure;
  }

  async appendRejection(input: RunGraphRejection): Promise<void> {
    const rejection = RunGraphRejectionSchema.parse(input);
    const rejectionDir = join(this.runDir(rejection.runId), "rejections");
    await mkdir(rejectionDir, { recursive: true });
    const filePath = join(rejectionDir, `${safeSegment(rejection.rejectionId)}.json`);
    try {
      await writeFile(filePath, JSON.stringify(rejection, null, 2) + "\n", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`duplicate rejection ID: ${rejection.rejectionId}`);
      }
      throw error;
    }
  }

  async readJournal(runId: string): Promise<RunGraphJournal> {
    const journal = await this.readJournalOrEmpty(runId);
    if (journal.acceptedEvents.length === 0) {
      throw new Error(`Run Graph が見つかりません: ${runId}`);
    }
    return journal;
  }

  private async readJournalOrEmpty(runId: string): Promise<RunGraphJournal> {
    const runDir = this.runDir(runId);
    const acceptedEvents = await Promise.all(
      (await listJsonFiles(join(runDir, "events"))).map(async (name) =>
        RunGraphAcceptedEventReadSchema.parse(
          JSON.parse(await readFile(join(runDir, "events", name), "utf8")),
        ),
      ),
    );
    const rejections = await Promise.all(
      (await listJsonFiles(join(runDir, "rejections"))).map(async (name) =>
        RunGraphRejectionReadSchema.parse(
          JSON.parse(await readFile(join(runDir, "rejections", name), "utf8")),
        ),
      ),
    );
    return RunGraphJournalSchema.parse({ schemaVersion: "1", runId, acceptedEvents, rejections });
  }

  async listRunIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => restoreSegment(entry.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private locatorPath(runId: string): string {
    return join(this.locatorIndexRoot, "runs", `${safeSegment(runId)}.json`);
  }

  private eventPath(runId: string, sequence: number): string {
    return join(this.runDir(runId), "events", `${String(sequence).padStart(12, "0")}.json`);
  }

  private taskLocatorIndexPath(task: RunGraphRunLocator["task"]): string {
    return join(this.locatorIndexRoot, "tasks", `${safeSegment(taskKey(task))}.json`);
  }

  private locatorIndexStatePath(): string {
    return join(this.locatorIndexRoot, "state.json");
  }

  private pendingLocatorTransactionPath(): string {
    return join(this.locatorIndexRoot, "pending-transaction.json");
  }

  private async readJournalLocator(runId: string): Promise<RunGraphRunLocator | null> {
    const eventsDir = join(this.runDir(runId), "events");
    const files = await listJsonFiles(eventsDir);
    const firstFile = files[0];
    const lastFile = files.at(-1);
    if (!firstFile || !lastFile) return null;
    const first = RunGraphAcceptedEventReadSchema.parse(
      JSON.parse(await readFile(join(eventsDir, firstFile), "utf8")),
    );
    if (first.command.type !== "run_started") {
      throw new Error(`Run Graph の先頭 event が run_started ではありません: ${runId}`);
    }
    const last =
      lastFile === firstFile
        ? first
        : RunGraphAcceptedEventReadSchema.parse(
            JSON.parse(await readFile(join(eventsDir, lastFile), "utf8")),
          );
    return { runId, task: normalizedTask(first.command.task), updatedAt: last.acceptedAt };
  }

  private async prepareLocatorTransaction(
    event: RunGraphAcceptedEvent,
    input: RunGraphRunLocator,
  ): Promise<RunGraphPendingLocatorTransaction> {
    const locator = RunGraphRunLocatorSchema.parse({
      ...input,
      task: normalizedTask(input.task),
    });
    const locatorPath = this.locatorPath(locator.runId);
    const previousLocator = await readJsonOptional(locatorPath, RunGraphRunLocatorSchema);
    if (previousLocator && !sameTask(previousLocator.task, locator.task)) {
      throw new Error(`Run Graph locator の task は変更できません: ${locator.runId}`);
    }
    const task = normalizedTask(locator.task);
    const indexPath = this.taskLocatorIndexPath(task);
    const current = await readJsonOptional(indexPath, RunGraphTaskLocatorIndexSchema);
    if (current && !sameTask(current.task, task)) {
      throw new Error(`Run Graph task locator index が一致しません: ${taskKey(task)}`);
    }
    const items = sortLocators([
      locator,
      ...(current?.items ?? []).filter((item) => item.runId !== locator.runId),
    ]).slice(0, RUN_GRAPH_LOCATOR_INDEX_LIMIT);
    const index = RunGraphTaskLocatorIndexSchema.parse({
      schemaVersion: "1",
      task,
      total: (current?.total ?? 0) + (previousLocator ? 0 : 1),
      items,
    });
    const state = await readJsonOptional(
      this.locatorIndexStatePath(),
      RunGraphLocatorIndexStateSchema,
    );
    return RunGraphPendingLocatorTransactionSchema.parse({
      schemaVersion: "1",
      event: { runId: event.runId, eventId: event.eventId, sequence: event.sequence },
      locator,
      taskIndex: index,
      restoreCompleteState: state !== null,
    });
  }

  private async applyPendingLocatorTransaction(
    input: RunGraphPendingLocatorTransaction,
  ): Promise<void> {
    const transaction = RunGraphPendingLocatorTransactionSchema.parse(input);
    await mkdir(join(this.locatorIndexRoot, "runs"), { recursive: true });
    await mkdir(join(this.locatorIndexRoot, "tasks"), { recursive: true });
    await writeJsonAtomic(this.locatorPath(transaction.locator.runId), transaction.locator);
    await writeJsonAtomic(
      this.taskLocatorIndexPath(transaction.taskIndex.task),
      transaction.taskIndex,
    );
    if (transaction.restoreCompleteState) {
      await writeJsonAtomic(
        this.locatorIndexStatePath(),
        RunGraphLocatorIndexStateSchema.parse({
          schemaVersion: "1",
          rebuiltAt: new Date().toISOString(),
        }),
      );
    }
    await rm(this.pendingLocatorTransactionPath(), { force: true });
  }

  private async recoverPendingLocatorTransaction(): Promise<void> {
    const transaction = await readJsonOptional(
      this.pendingLocatorTransactionPath(),
      RunGraphPendingLocatorTransactionSchema,
    );
    if (!transaction) return;
    const event = (await readJsonOptional(
      this.eventPath(transaction.event.runId, transaction.event.sequence),
      RunGraphAcceptedEventReadSchema,
    )) as RunGraphAcceptedEvent | null;
    if (!event) {
      await rm(this.pendingLocatorTransactionPath(), { force: true });
      return;
    }
    if (
      event.runId !== transaction.event.runId ||
      event.eventId !== transaction.event.eventId ||
      event.sequence !== transaction.event.sequence
    ) {
      throw new Error("Run Graph pending transaction と accepted event が一致しません");
    }
    await this.applyPendingLocatorTransaction(transaction);
  }

  private async rebuildRunLocatorIndex(): Promise<void> {
    const locators: RunGraphRunLocator[] = [];
    for (const runId of await this.listRunIds()) {
      const locator = await this.readJournalLocator(runId);
      if (locator) locators.push(locator);
    }
    const byTask = new Map<string, RunGraphRunLocator[]>();
    for (const locator of locators) {
      const key = taskKey(locator.task);
      byTask.set(key, [...(byTask.get(key) ?? []), locator]);
    }
    await mkdir(join(this.locatorIndexRoot, "runs"), { recursive: true });
    await mkdir(join(this.locatorIndexRoot, "tasks"), { recursive: true });
    for (const locator of locators) {
      await writeJsonAtomic(
        this.locatorPath(locator.runId),
        RunGraphRunLocatorSchema.parse(locator),
      );
    }
    for (const taskLocators of byTask.values()) {
      const sorted = sortLocators(taskLocators);
      const task = normalizedTask(sorted[0]!.task);
      await writeJsonAtomic(
        this.taskLocatorIndexPath(task),
        RunGraphTaskLocatorIndexSchema.parse({
          schemaVersion: "1",
          task,
          total: sorted.length,
          items: sorted.slice(0, RUN_GRAPH_LOCATOR_INDEX_LIMIT),
        }),
      );
    }
    await writeJsonAtomic(
      this.locatorIndexStatePath(),
      RunGraphLocatorIndexStateSchema.parse({
        schemaVersion: "1",
        rebuiltAt: new Date().toISOString(),
      }),
    );
  }

  /** 旧 journal の locator を server 起動時に再構築し、request path の全 Run 走査を避ける。 */
  async ensureRunLocatorIndex(): Promise<void> {
    await withLocatorIndexLease(this.locatorIndexRoot, async () => {
      await this.recoverPendingLocatorTransaction();
      const state = await readJsonOptional(
        this.locatorIndexStatePath(),
        RunGraphLocatorIndexStateSchema,
      );
      if (state) return;
      await this.rebuildRunLocatorIndex();
    });
  }

  /**
   * task 単位の bounded locator index と選択 run の locator だけで候補を絞る。
   * 詳細 replay は返却した最大 limit 件だけを caller が実行する。
   */
  async listRunLocators(input: RunGraphRunLocatorQuery): Promise<{
    total: number;
    items: RunGraphRunLocator[];
  }> {
    const readStableIndex = async () => {
      const limit = Math.min(50, Math.max(1, input.limit));
      const index = await readJsonOptional(
        this.taskLocatorIndexPath(input.task),
        RunGraphTaskLocatorIndexSchema,
      );
      if (index && !sameTask(index.task, input.task)) {
        throw new Error(`Run Graph task locator index が一致しません: ${taskKey(input.task)}`);
      }
      let items = (index?.items ?? []).slice(0, limit);
      if (input.selectedRunId && !items.some((item) => item.runId === input.selectedRunId)) {
        const selected = await readJsonOptional(
          this.locatorPath(input.selectedRunId),
          RunGraphRunLocatorSchema,
        );
        if (selected && sameTask(selected.task, input.task)) {
          if (!index || index.total < 1) {
            throw new Error(`Run Graph locator index が不完全です: ${taskKey(input.task)}`);
          }
          items = [selected, ...items.filter((item) => item.runId !== selected.runId)].slice(
            0,
            limit,
          );
        }
      }
      return { total: index?.total ?? 0, items };
    };
    return withLocatorIndexLease(
      this.locatorIndexRoot,
      async () => {
        await this.recoverPendingLocatorTransaction();
        const state = await readJsonOptional(
          this.locatorIndexStatePath(),
          RunGraphLocatorIndexStateSchema,
        );
        if (!state) {
          throw new RunGraphLocatorIndexNotReadyError(
            "Run Graph locator index の complete state がありません",
          );
        }
        return readStableIndex();
      },
      RUN_GRAPH_LOCATOR_READ_LEASE_TIMEOUT_MS,
    );
  }
}
