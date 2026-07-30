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

const RUN_GRAPH_LOCATOR_INDEX_DIR = "locator-index";
const RUN_GRAPH_LOCATOR_INDEX_LIMIT = 50;

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
    claimantNonce: z.string().uuid(),
  })
  .strict();

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

async function acquireLocatorIndexLease(locatorIndexRoot: string): Promise<() => Promise<void>> {
  await mkdir(locatorIndexRoot, { recursive: true });
  const lockDir = join(locatorIndexRoot, "LOCK");
  const owner = RunGraphLocatorIndexLockOwnerSchema.parse({
    schemaVersion: "1",
    pid: process.pid,
    hostname: hostname(),
    nonce: randomUUID(),
  });
  const deadline = Date.now() + 30_000;

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
      if (!recoveryClaim && existing.hostname === owner.hostname && !isProcessAlive(existing.pid)) {
        const claim = RunGraphLocatorIndexRecoveryClaimSchema.parse({
          schemaVersion: "1",
          expectedOwnerNonce: existing.nonce,
          claimantNonce: owner.nonce,
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
        throw new Error(
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
): Promise<T> {
  const release = await acquireLocatorIndexLease(locatorIndexRoot);
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

  constructor(projectRoot: string) {
    this.root = join(projectRoot, GANTT_DIR, RUN_GRAPH_DIR, RUN_GRAPH_RUNS_DIR);
    this.locatorIndexRoot = join(
      projectRoot,
      GANTT_DIR,
      RUN_GRAPH_DIR,
      RUN_GRAPH_LOCATOR_INDEX_DIR,
    );
  }

  private runDir(runId: string): string {
    return join(this.root, safeSegment(runId));
  }

  async appendAccepted(input: RunGraphAcceptedEvent): Promise<void> {
    const event = RunGraphAcceptedEventSchema.parse(input);
    await withLocatorIndexLease(this.locatorIndexRoot, async () => {
      await mkdir(this.locatorIndexRoot, { recursive: true });
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
      await this.updateRunLocator({
        runId: event.runId,
        task: first.command.task,
        updatedAt: event.acceptedAt,
      });
    });
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

  private taskLocatorIndexPath(task: RunGraphRunLocator["task"]): string {
    return join(this.locatorIndexRoot, "tasks", `${safeSegment(taskKey(task))}.json`);
  }

  private locatorIndexStatePath(): string {
    return join(this.locatorIndexRoot, "state.json");
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
    return { runId, task: first.command.task, updatedAt: last.acceptedAt };
  }

  private async updateRunLocator(input: RunGraphRunLocator): Promise<void> {
    const locator = RunGraphRunLocatorSchema.parse(input);
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
    await mkdir(join(this.locatorIndexRoot, "runs"), { recursive: true });
    await mkdir(join(this.locatorIndexRoot, "tasks"), { recursive: true });
    await writeJsonAtomic(locatorPath, locator);
    await writeJsonAtomic(indexPath, index);
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
  }
}
