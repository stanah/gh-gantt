import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  GANTT_DIR,
  RUN_GRAPH_DIR,
  RUN_GRAPH_RUNS_DIR,
  type RunGraphAcceptedEvent,
  type RunGraphRejection,
} from "@gh-gantt/shared";
import { GraphContractStore } from "../store/graph-contract.js";
import { RunGraphEventStore } from "../store/run-graph.js";

const actor = { id: "orchestrator-1", role: "orchestrator" } as const;
const startEvent: RunGraphAcceptedEvent = {
  recordType: "accepted",
  eventId: "start-328",
  sequence: 1,
  runId: "run-328",
  acceptedAt: "2026-07-30T00:00:00.000Z",
  actor,
  command: {
    type: "run_started",
    task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
    contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    firstNodeId: "node-planner-1",
  },
  artifactIds: [],
  evidenceIds: [],
};

describe("[NFR-STABILITY-014-AC1] GraphContractStore は exact version binding を永続化する", () => {
  it("install 後に別 instance から同じ contract を取得できる", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-contract-"));
    const store = new GraphContractStore(root);
    await store.install(FIXED_DEV_ROLE_GRAPH_CONTRACT);

    await expect(
      new GraphContractStore(root).read({
        planId: "dev-role-fixed",
        planVersion: "1",
        schemaVersion: "1",
      }),
    ).resolves.toEqual(FIXED_DEV_ROLE_GRAPH_CONTRACT);
    await expect(
      store.read({ planId: "dev-role-fixed", planVersion: "2", schemaVersion: "1" }),
    ).rejects.toThrow(/contract/i);
  });
});

describe("[NFR-STABILITY-014-AC4] RunGraphEventStore は immutable sequence segment を正本にする", () => {
  it("accepted event と rejection evidence を process 再生成後も同じ順序で読める", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-run-store-"));
    const store = new RunGraphEventStore(root);
    await store.appendAccepted(startEvent);

    const rejection: RunGraphRejection = {
      recordType: "rejected",
      rejectionId: "rejection-1",
      eventId: startEvent.eventId,
      runId: startEvent.runId,
      rejectedAt: "2026-07-30T00:01:00.000Z",
      actor,
      command: {
        type: "attempt_started",
        nodeId: "node-planner-1",
        attemptId: "attempt-planner-1",
      },
      code: "duplicate_event",
      message: "受理済み event ID です",
      stateUnchanged: true,
    };
    await store.appendRejection(rejection);

    const journal = await new RunGraphEventStore(root).readJournal(startEvent.runId);
    expect(journal.acceptedEvents).toEqual([startEvent]);
    expect(journal.rejections).toEqual([rejection]);
    await expect(new RunGraphEventStore(root).listRunIds()).resolves.toEqual(["run-328"]);
  });

  it("duplicate event と連続しない sequence を追記しない", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-run-store-"));
    const store = new RunGraphEventStore(root);
    await store.appendAccepted(startEvent);

    await expect(store.appendAccepted(startEvent)).rejects.toThrow(/duplicate/i);
    await expect(
      store.appendAccepted({
        ...startEvent,
        eventId: "event-gap",
        sequence: 3,
        command: {
          type: "attempt_started",
          nodeId: "node-planner-1",
          attemptId: "attempt-planner-1",
        },
      }),
    ).rejects.toThrow(/sequence/i);
    expect((await store.readJournal(startEvent.runId)).acceptedEvents).toHaveLength(1);
  });

  it("同じ sequence の concurrent append は一件だけを受理する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-run-store-"));
    const store = new RunGraphEventStore(root);
    await store.appendAccepted(startEvent);
    const events = ["attempt-started-a", "attempt-started-b"].map(
      (eventId, index): RunGraphAcceptedEvent => ({
        ...startEvent,
        eventId,
        sequence: 2,
        acceptedAt: `2026-07-30T00:0${index + 1}:00.000Z`,
        command: {
          type: "attempt_started",
          nodeId: "node-planner-1",
          attemptId: `attempt-planner-${index + 1}`,
        },
      }),
    );
    const results = await Promise.allSettled([
      store.appendAccepted(events[0]),
      new RunGraphEventStore(root).appendAccepted(events[1]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/duplicate event segment/i),
      }),
    });
    await expect(store.readJournal(startEvent.runId)).resolves.toMatchObject({
      acceptedEvents: [{ sequence: 1 }, { sequence: 2 }],
    });
  });

  it("旧 schema v1 の pr_observed accepted event を不変のまま安全な未証明 linkage へ read migration する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-run-store-"));
    const store = new RunGraphEventStore(root);
    await store.appendAccepted(startEvent);
    const runSegment = Buffer.from(startEvent.runId, "utf8").toString("base64url");
    const eventId = "legacy-pr-observed";
    const eventSegment = Buffer.from(eventId, "utf8").toString("base64url");
    const eventsDir = join(
      root,
      GANTT_DIR,
      RUN_GRAPH_DIR,
      RUN_GRAPH_RUNS_DIR,
      runSegment,
      "events",
    );
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, `000000000002-${eventSegment}.json`),
      JSON.stringify({
        recordType: "accepted",
        eventId,
        sequence: 2,
        runId: startEvent.runId,
        acceptedAt: "2026-07-30T00:01:00.000Z",
        actor,
        command: {
          type: "pr_observed",
          repository: "stanah/gh-gantt",
          pullRequestNumber: 334,
          state: "merged",
          evidenceIds: ["legacy-pr-evidence"],
        },
        artifactIds: [],
        evidenceIds: ["legacy-pr-evidence"],
      }),
    );

    await expect(store.readJournal(startEvent.runId)).resolves.toMatchObject({
      acceptedEvents: [
        {},
        {
          command: {
            type: "pr_observed",
            isDraft: false,
            linkedIssue: null,
            linkageComplete: false,
          },
        },
      ],
    });
  });

  it("旧 schema v1 の pr_observed rejection を不変のまま安全な未証明 linkage へ read migration する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-run-store-"));
    const store = new RunGraphEventStore(root);
    await store.appendAccepted(startEvent);
    const runSegment = Buffer.from(startEvent.runId, "utf8").toString("base64url");
    const rejectionId = "legacy-pr-rejection";
    const rejectionSegment = Buffer.from(rejectionId, "utf8").toString("base64url");
    const rejectionsDir = join(
      root,
      GANTT_DIR,
      RUN_GRAPH_DIR,
      RUN_GRAPH_RUNS_DIR,
      runSegment,
      "rejections",
    );
    await mkdir(rejectionsDir, { recursive: true });
    const filePath = join(rejectionsDir, `${rejectionSegment}.json`);
    const legacyJson = JSON.stringify({
      recordType: "rejected",
      rejectionId,
      eventId: "legacy-pr-observed-rejected",
      runId: startEvent.runId,
      rejectedAt: "2026-07-30T00:01:00.000Z",
      actor,
      command: {
        type: "pr_observed",
        repository: "stanah/gh-gantt",
        pullRequestNumber: 334,
        state: "merged",
        evidenceIds: ["legacy-pr-evidence"],
      },
      code: "invalid_transition",
      message: "human-pr gate 前の observation です",
      stateUnchanged: true,
    });
    await expect(
      store.appendRejection(JSON.parse(legacyJson) as RunGraphRejection),
    ).rejects.toThrow(/isDraft/);
    await writeFile(filePath, legacyJson);

    await expect(store.readJournal(startEvent.runId)).resolves.toMatchObject({
      rejections: [
        {
          command: {
            type: "pr_observed",
            isDraft: false,
            linkedIssue: null,
            linkageComplete: false,
          },
        },
      ],
    });
    await expect(readFile(filePath, "utf8")).resolves.toBe(legacyJson);
  });
});
