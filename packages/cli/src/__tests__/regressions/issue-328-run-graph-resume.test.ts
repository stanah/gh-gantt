import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyLoopState, FIXED_DEV_ROLE_GRAPH_CONTRACT } from "@gh-gantt/shared";
import { RunGraphControlPlane } from "../../run-graph/control-plane.js";
import { GraphContractStore } from "../../store/graph-contract.js";
import { LoopStateStore } from "../../store/loop-state.js";
import { RunGraphEventStore } from "../../store/run-graph.js";

const reference = (name: string) => ({
  kind: "workspace" as const,
  uri: `.dev-flow/328/${name}.json`,
  sha256: `sha256:${"a".repeat(64)}`,
  byteLength: 128,
});

function dependencies() {
  let node = 0;
  let rejection = 0;
  return {
    now: () => "2026-07-30T00:00:00.000Z",
    nextId: (kind: string) => {
      if (kind === "run") return "run-regression-328";
      if (kind === "node") return `node-${++node}`;
      if (kind === "rejection") return `rejection-${++rejection}`;
      return `${kind}-1`;
    },
  };
}

describe("[NFR-STABILITY-014-AC5] [Issue #328] Run Graph 再開は旧 loop-state と完了 node を変更しない", () => {
  it("再起動と event 再送後も planner outcome を一度だけ replay する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-issue-328-regression-"));
    const legacyLoopState = createEmptyLoopState();
    const legacyStore = new LoopStateStore(root);
    await legacyStore.write(legacyLoopState);
    await new GraphContractStore(root).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
    const control = new RunGraphControlPlane(root, dependencies());
    const started = await control.start({
      schemaVersion: "1",
      eventId: "start-regression-328",
      actor: { id: "orchestrator-1", role: "orchestrator" },
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    });
    if (!started.accepted || !started.view.currentNode) throw new Error("Run Graph start failure");
    const runId = started.view.runId;
    const nodeId = started.view.currentNode.id;
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "planner-start",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: { type: "attempt_started", nodeId, attemptId: "planner-attempt" },
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "planner-finish",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "attempt_finished",
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded",
        artifactIds: [],
        evidenceIds: ["planner-command"],
      },
      evidence: [
        {
          id: "planner-command",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("planner-command"),
        },
      ],
    });
    const outcomeInput = {
      schemaVersion: "1" as const,
      eventId: "planner-outcome",
      runId,
      actor: { id: "planner-1", role: "planner" as const },
      command: {
        type: "node_outcome_submitted" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "plan_valid",
        artifactIds: ["planner-artifact"],
        evidenceIds: ["planner-validation"],
      },
      artifacts: [
        {
          id: "planner-artifact",
          schemaId: "dev-role.plan",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("planner-artifact"),
        },
      ],
      evidence: [
        {
          id: "planner-validation",
          kind: "artifact_validation",
          artifactIds: ["planner-artifact"],
          provenance: "schema-validator",
          reference: reference("planner-validation"),
        },
      ],
    };
    await expect(control.applyEvent(outcomeInput)).resolves.toMatchObject({
      accepted: true,
      view: { revision: 4, currentNode: { contractNodeId: "implementer", state: "ready" } },
    });

    const restored = new RunGraphControlPlane(root, dependencies());
    await expect(restored.applyEvent(outcomeInput)).resolves.toMatchObject({
      accepted: false,
      code: "duplicate_event",
      stateUnchanged: true,
      view: { revision: 4, currentNode: { contractNodeId: "implementer", state: "ready" } },
    });
    const journal = await new RunGraphEventStore(root).readJournal(runId);
    expect(
      journal.acceptedEvents.filter((event) => event.command.type === "node_outcome_submitted"),
    ).toHaveLength(1);
    expect(await legacyStore.readOrNull()).toEqual(legacyLoopState);
  });
});
