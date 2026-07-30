import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  task?: { owner: string; repo: string; issueNumber: number };
  limit: number;
  selectedRunId?: string;
}

function safeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function restoreSegment(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
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

  constructor(projectRoot: string) {
    this.root = join(projectRoot, GANTT_DIR, RUN_GRAPH_DIR, RUN_GRAPH_RUNS_DIR);
  }

  private runDir(runId: string): string {
    return join(this.root, safeSegment(runId));
  }

  async appendAccepted(input: RunGraphAcceptedEvent): Promise<void> {
    const event = RunGraphAcceptedEventSchema.parse(input);
    const eventsDir = join(this.runDir(event.runId), "events");
    await mkdir(eventsDir, { recursive: true });
    const journal = await this.readJournalOrEmpty(event.runId);
    if (journal.acceptedEvents.some((item) => item.eventId === event.eventId)) {
      throw new Error(`duplicate event ID: ${event.eventId}`);
    }
    const expected = journal.acceptedEvents.length + 1;
    if (event.sequence !== expected) {
      throw new Error(`event sequence は ${expected} である必要があります`);
    }
    const filePath = join(eventsDir, `${String(event.sequence).padStart(12, "0")}.json`);
    try {
      await writeFile(filePath, JSON.stringify(event, null, 2) + "\n", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`duplicate event segment: ${event.eventId}`);
      }
      throw error;
    }
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

  private async readRunLocator(runId: string): Promise<RunGraphRunLocator | null> {
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

  /**
   * journal 全文を replay せず、各 run の先頭・末尾 event だけで候補を絞る。
   * file read は直列に行い、詳細 replay は返却した最大 limit 件だけを caller が実行する。
   */
  async listRunLocators(input: RunGraphRunLocatorQuery): Promise<{
    total: number;
    items: RunGraphRunLocator[];
  }> {
    const limit = Math.min(50, Math.max(1, input.limit));
    const locators: RunGraphRunLocator[] = [];
    for (const runId of await this.listRunIds()) {
      const locator = await this.readRunLocator(runId);
      if (!locator) continue;
      if (
        input.task &&
        (locator.task.issueNumber !== input.task.issueNumber ||
          locator.task.owner.toLowerCase() !== input.task.owner.toLowerCase() ||
          locator.task.repo.toLowerCase() !== input.task.repo.toLowerCase())
      ) {
        continue;
      }
      locators.push(locator);
    }
    locators.sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.runId.localeCompare(right.runId),
    );
    let items = locators.slice(0, limit);
    if (input.selectedRunId && !items.some((item) => item.runId === input.selectedRunId)) {
      const selected = locators.find((item) => item.runId === input.selectedRunId);
      if (selected) {
        items = [selected, ...items.filter((item) => item.runId !== selected.runId)].slice(
          0,
          limit,
        );
      }
    }
    return { total: locators.length, items };
  }
}
