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
    const filePath = join(
      eventsDir,
      `${String(event.sequence).padStart(12, "0")}-${safeSegment(event.eventId)}.json`,
    );
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
}
