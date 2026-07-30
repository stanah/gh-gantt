import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
});
