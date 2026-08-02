import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  type Config,
  type Task,
  type TasksFile,
} from "@gh-gantt/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitFixtureEnvironment } from "./git-fixture.js";
import { createRunCommand } from "../commands/run.js";
import { buildProgram } from "../program.js";
import type { RunGraphPrObservation } from "../loop/pr-evidence.js";
import { RunGraphControlPlane } from "../run-graph/control-plane.js";
import { ConfigStore } from "../store/config.js";
import { GraphContractStore } from "../store/graph-contract.js";
import { withProjectStorage } from "../store/project-storage.js";
import { TasksStore } from "../store/tasks.js";

const execFileAsync = promisify(execFile);

function makeConfig(): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
    },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
    run_graph: {
      plan_id: FIXED_DEV_ROLE_GRAPH_CONTRACT.planId,
      plan_version: FIXED_DEV_ROLE_GRAPH_CONTRACT.planVersion,
      schema_version: FIXED_DEV_ROLE_GRAPH_CONTRACT.schemaVersion,
    },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "stanah/gh-gantt#328",
    type: "task",
    github_issue: 328,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: "durable Run Graph",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

const reference = (name: string) => ({
  kind: "workspace" as const,
  uri: `.dev-flow/328/${name}.json`,
  sha256: `sha256:${"d".repeat(64)}`,
  byteLength: 256,
});

describe("[NFR-STABILITY-014-AC9] run bounded dispatch CLI contract", () => {
  it("dispatch/claim/heartbeat/release/reclaim を JSON-first public command として公開する", async () => {
    const originalExitCode = process.exitCode;
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-run-dispatch-command-"));
    const workspaceMapPath = join(root, "workspace-map.json");
    const gateSnapshotPath = join(root, "gate-snapshot.json");
    const dispatchPlanPath = join(root, "dispatch-plan.json");
    await execFileAsync("git", ["init", root], { env: gitFixtureEnvironment() });
    await mkdir(join(root, ".gantt-sync"), { recursive: true });
    const config: Config = {
      ...makeConfig(),
      statuses: {
        field_name: "Status",
        values: { Todo: { color: "#000", done: false, category: "todo" } },
      },
      dispatch: { max_concurrency: 2 },
    };
    await new ConfigStore(root).write(config);
    await withProjectStorage(
      root,
      { mode: "write", scope: "all" },
      async ({ tasksStore, stateStore }) => {
        await tasksStore.write({
          tasks: [makeTask({ custom_fields: { Status: "Todo" } })],
          cache: { comments: {}, reactions: {} },
        });
        await stateStore.write({
          last_synced_at: "2026-08-02T00:00:00.000Z",
          project_node_id: "PVT_fixture",
          id_map: {},
          field_ids: {},
          snapshots: {},
        });
      },
    );
    await writeFile(
      workspaceMapPath,
      `${JSON.stringify({ "stanah/gh-gantt#328": "workspace:328" })}\n`,
    );
    await writeFile(
      gateSnapshotPath,
      `${JSON.stringify({
        schemaVersion: "1",
        sourceRevision: "review-system:1",
        observedAt: "2026-08-02T00:00:00.000Z",
        reviewGateTaskIds: [],
        humanGateTaskIds: [],
      })}\n`,
    );
    await new GraphContractStore(root).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
    const started = await new RunGraphControlPlane(root).start({
      schemaVersion: "1",
      eventId: "dispatch-run-start",
      actor: { id: "orchestrator-1", role: "orchestrator" },
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    });
    if (!started.accepted) throw new Error(started.message);
    const currentNodeId = started.view.currentNode?.id;
    if (!currentNodeId) throw new Error("current node が必要です");
    await new RunGraphControlPlane(root).applyEvent({
      schemaVersion: "1",
      eventId: "dispatch-attempt-start",
      runId: started.view.runId,
      actor: { id: "planner-2", role: "planner" },
      command: { type: "attempt_started", nodeId: currentNodeId, attemptId: "dispatch-attempt" },
    });

    const logs: string[] = [];
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const names = createRunCommand().commands.map((item) => item.name());
      expect(names).toEqual(
        expect.arrayContaining(["dispatch", "claim", "heartbeat", "release", "reclaim"]),
      );

      await createRunCommand().parseAsync(
        [
          "dispatch",
          "--workspace-map",
          workspaceMapPath,
          "--gate-snapshot",
          gateSnapshotPath,
          "--json",
        ],
        { from: "user" },
      );
      const initialPlan = JSON.parse(logs.at(-1)!);
      expect(initialPlan).toMatchObject({
        planVersion: "1",
        registryEntityVersion: 0,
        selected: [{ taskId: "stanah/gh-gantt#328", workspaceId: "workspace:328" }],
        capacity: { global: { limit: 2, used: 0 } },
      });
      await writeFile(dispatchPlanPath, `${JSON.stringify(initialPlan)}\n`);

      await writeFile(
        gateSnapshotPath,
        `${JSON.stringify({
          schemaVersion: "1",
          sourceRevision: "review-system:2",
          observedAt: "2026-08-02T00:01:00.000Z",
          reviewGateTaskIds: ["stanah/gh-gantt#328"],
          humanGateTaskIds: [],
        })}\n`,
      );
      await createRunCommand().parseAsync(
        [
          "claim",
          "--event-id",
          "claim-stale-gate-snapshot",
          "--expected-version",
          "0",
          "--task",
          "stanah/gh-gantt#328",
          "--repository",
          "stanah/gh-gantt",
          "--state",
          "Todo",
          "--owner",
          "planner-2",
          "--workspace",
          "workspace:328",
          "--run",
          started.view.runId,
          "--plan-file",
          dispatchPlanPath,
          "--gate-snapshot",
          gateSnapshotPath,
          "--actor",
          "orchestrator-1",
          "--json",
        ],
        { from: "user" },
      );
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        accepted: false,
        code: "stale_entity_version",
      });
      await writeFile(
        gateSnapshotPath,
        `${JSON.stringify({
          schemaVersion: "1",
          sourceRevision: "review-system:1",
          observedAt: "2026-08-02T00:00:00.000Z",
          reviewGateTaskIds: [],
          humanGateTaskIds: [],
        })}\n`,
      );

      await withProjectStorage(root, { mode: "write", scope: "all" }, async ({ tasksStore }) => {
        const current = await tasksStore.read();
        await tasksStore.write({ ...current, has_conflicts: true });
      });
      await createRunCommand().parseAsync(
        [
          "claim",
          "--event-id",
          "claim-stale-work-graph",
          "--expected-version",
          "0",
          "--task",
          "stanah/gh-gantt#328",
          "--repository",
          "stanah/gh-gantt",
          "--state",
          "Todo",
          "--owner",
          "planner-2",
          "--workspace",
          "workspace:328",
          "--run",
          started.view.runId,
          "--plan-file",
          dispatchPlanPath,
          "--gate-snapshot",
          gateSnapshotPath,
          "--actor",
          "orchestrator-1",
          "--json",
        ],
        { from: "user" },
      );
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        accepted: false,
        code: "stale_entity_version",
      });
      await withProjectStorage(root, { mode: "write", scope: "all" }, async ({ tasksStore }) => {
        const current = await tasksStore.read();
        await tasksStore.write({ ...current, has_conflicts: false });
      });

      await createRunCommand().parseAsync(
        [
          "claim",
          "--event-id",
          "claim-cli-1",
          "--expected-version",
          "0",
          "--task",
          "stanah/gh-gantt#328",
          "--repository",
          "stanah/gh-gantt",
          "--state",
          "Todo",
          "--owner",
          "planner-2",
          "--workspace",
          "workspace:328",
          "--run",
          started.view.runId,
          "--plan-file",
          dispatchPlanPath,
          "--gate-snapshot",
          gateSnapshotPath,
          "--actor",
          "orchestrator-1",
          "--lease-seconds",
          "60",
          "--json",
        ],
        { from: "user" },
      );
      const claimed = JSON.parse(logs.at(-1)!) as {
        accepted: true;
        entityVersion: number;
        claim: { claimId: string; fencingToken: number; ownerId: string; runId: string };
        audit: { recorded: boolean };
      };
      expect(claimed).toMatchObject({
        accepted: true,
        entityVersion: 1,
        audit: { recorded: true },
      });

      await createRunCommand().parseAsync(
        [
          "heartbeat",
          "--event-id",
          "heartbeat-cli-1",
          "--expected-version",
          "1",
          "--claim",
          claimed.claim.claimId,
          "--fencing-token",
          String(claimed.claim.fencingToken),
          "--owner",
          claimed.claim.ownerId,
          "--run",
          claimed.claim.runId,
          "--actor",
          "orchestrator-1",
          "--lease-seconds",
          "60",
          "--json",
        ],
        { from: "user" },
      );
      const heartbeat = JSON.parse(logs.at(-1)!) as { claim: { fencingToken: number } };
      expect(heartbeat).toMatchObject({
        accepted: true,
        entityVersion: 2,
        audit: { recorded: true },
      });

      const authorizedEventPath = join(root, "authorized-event.json");
      await writeFile(
        authorizedEventPath,
        `${JSON.stringify({
          schemaVersion: "1",
          eventId: "authorized-cli-finish",
          actor: { id: "planner-2", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId: currentNodeId,
            attemptId: "dispatch-attempt",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: ["authorized-cli-command"],
          },
          evidence: [
            {
              id: "authorized-cli-command",
              kind: "command_execution",
              artifactIds: [],
              provenance: "authorized-cli-runner",
              reference: {
                kind: "command",
                uri: "command://authorized-cli",
                sha256: `sha256:${"a".repeat(64)}`,
                byteLength: 1,
              },
            },
          ],
          claim: {
            expectedEntityVersion: 2,
            proof: {
              claimId: claimed.claim.claimId,
              fencingToken: heartbeat.claim.fencingToken,
              ownerId: claimed.claim.ownerId,
              runId: claimed.claim.runId,
            },
          },
        })}\n`,
      );
      await createRunCommand().parseAsync(
        ["event", started.view.runId, "--file", authorizedEventPath, "--json"],
        { from: "user" },
      );
      const authorized = JSON.parse(logs.at(-1)!) as {
        claimAuthorization: {
          receipt: { entityVersion: number; operation: string };
          proof: { claimId: string; fencingToken: number; ownerId: string; runId: string };
        };
      };
      expect(authorized).toMatchObject({
        accepted: true,
        claimAuthorization: {
          receipt: { operation: "authorize_event", entityVersion: 3 },
          proof: { fencingToken: 3 },
          audit: { recorded: true },
        },
      });

      await createRunCommand().parseAsync(
        [
          "release",
          "--event-id",
          "release-cli-1",
          "--expected-version",
          "3",
          "--claim",
          authorized.claimAuthorization.proof.claimId,
          "--fencing-token",
          String(authorized.claimAuthorization.proof.fencingToken),
          "--owner",
          authorized.claimAuthorization.proof.ownerId,
          "--run",
          authorized.claimAuthorization.proof.runId,
          "--actor",
          "orchestrator-1",
          "--json",
        ],
        { from: "user" },
      );
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        accepted: true,
        entityVersion: 4,
        audit: { recorded: true },
      });

      await createRunCommand().parseAsync(
        [
          "dispatch",
          "--workspace-map",
          workspaceMapPath,
          "--gate-snapshot",
          gateSnapshotPath,
          "--json",
        ],
        { from: "user" },
      );
      const secondPlan = JSON.parse(logs.at(-1)!);
      expect(secondPlan).toMatchObject({ registryEntityVersion: 4 });
      await writeFile(dispatchPlanPath, `${JSON.stringify(secondPlan)}\n`);

      await createRunCommand().parseAsync(
        [
          "claim",
          "--event-id",
          "claim-cli-2",
          "--expected-version",
          "4",
          "--task",
          "stanah/gh-gantt#328",
          "--repository",
          "stanah/gh-gantt",
          "--state",
          "Todo",
          "--owner",
          "planner-2",
          "--workspace",
          "workspace:328",
          "--run",
          started.view.runId,
          "--plan-file",
          dispatchPlanPath,
          "--gate-snapshot",
          gateSnapshotPath,
          "--actor",
          "orchestrator-1",
          "--lease-seconds",
          "60",
          "--json",
        ],
        { from: "user" },
      );
      const claimedAgain = JSON.parse(logs.at(-1)!) as {
        claim: { claimId: string; fencingToken: number; ownerId: string; runId: string };
      };
      await createRunCommand().parseAsync(
        [
          "reclaim",
          "--event-id",
          "reclaim-cli-1",
          "--expected-version",
          "5",
          "--claim",
          claimedAgain.claim.claimId,
          "--reason",
          "owner_stopped",
          "--owner-stopped-evidence",
          "process-exit:planner-2",
          "--actor",
          "orchestrator-1",
          "--json",
        ],
        { from: "user" },
      );
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        accepted: true,
        entityVersion: 6,
        audit: { recorded: true },
      });

      const staleEventPath = join(root, "stale-completion.json");
      await writeFile(
        staleEventPath,
        `${JSON.stringify({
          schemaVersion: "1",
          eventId: "stale-cli-completion",
          actor: { id: "planner-2", role: "planner" },
          command: {
            type: "node_outcome_submitted",
            nodeId: currentNodeId,
            attemptId: "dispatch-attempt",
            outcome: "plan_valid",
            artifactIds: ["stale-cli-plan"],
            evidenceIds: ["stale-cli-plan-validation"],
          },
          artifacts: [
            {
              id: "stale-cli-plan",
              schemaId: "dev-role.plan",
              schemaVersion: "1",
              derivedFromArtifactIds: [],
              reference: {
                kind: "workspace",
                uri: ".dev-flow/328/stale-cli-plan.json",
                sha256: `sha256:${"b".repeat(64)}`,
                byteLength: 1,
              },
            },
          ],
          evidence: [
            {
              id: "stale-cli-plan-validation",
              kind: "artifact_validation",
              artifactIds: ["stale-cli-plan"],
              provenance: "stale-cli-runner",
              reference: {
                kind: "workspace",
                uri: ".dev-flow/328/stale-cli-plan-validation.json",
                sha256: `sha256:${"a".repeat(64)}`,
                byteLength: 1,
              },
            },
          ],
          claim: {
            expectedEntityVersion: 6,
            proof: {
              claimId: claimedAgain.claim.claimId,
              fencingToken: claimedAgain.claim.fencingToken,
              ownerId: claimedAgain.claim.ownerId,
              runId: claimedAgain.claim.runId,
            },
          },
        })}\n`,
      );
      await createRunCommand().parseAsync(
        ["event", started.view.runId, "--file", staleEventPath, "--json"],
        { from: "user" },
      );
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        accepted: false,
        code: "stale_claim",
        stateUnchanged: true,
      });

      const missingProofPath = join(root, "missing-claim-proof.json");
      await writeFile(
        missingProofPath,
        `${JSON.stringify({
          schemaVersion: "1",
          eventId: "missing-cli-proof",
          actor: { id: "planner-2", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId: currentNodeId,
            attemptId: "dispatch-attempt",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: [],
          },
        })}\n`,
      );
      await createRunCommand().parseAsync(
        ["event", started.view.runId, "--file", missingProofPath, "--json"],
        { from: "user" },
      );
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        accepted: false,
        code: "stale_claim",
        stateUnchanged: true,
      });
    } finally {
      process.exitCode = originalExitCode;
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function expectedBoundedReference(kind: "command" | "github", uri: string, value: unknown) {
  const canonicalJson = JSON.stringify(value);
  return {
    kind,
    uri,
    sha256: `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`,
    byteLength: Buffer.byteLength(canonicalJson, "utf8"),
  };
}

type ExecutionRole = "planner" | "implementer" | "executor" | "reviewer";

async function completeCurrentNode(params: {
  control: RunGraphControlPlane;
  runId: string;
  role: ExecutionRole;
  outcome: string;
  schemaId: string;
  prefix: string;
}) {
  const { control, runId, role, outcome, schemaId, prefix } = params;
  const before = await control.inspect(runId);
  if (!before.currentNode) throw new Error("current node がありません");
  const nodeId = before.currentNode.id;
  const attemptId = `${prefix}-attempt`;
  await control.applyEvent({
    schemaVersion: "1",
    eventId: `${prefix}-start`,
    runId,
    actor: { id: `${role}-agent`, role },
    command: { type: "attempt_started", nodeId, attemptId },
  });
  await control.applyEvent({
    schemaVersion: "1",
    eventId: `${prefix}-finish`,
    runId,
    actor: { id: `${role}-agent`, role },
    command: {
      type: "attempt_finished",
      nodeId,
      attemptId,
      outcome: "succeeded",
      artifactIds: [],
      evidenceIds: [`${prefix}-command-evidence`],
    },
    evidence: [
      {
        id: `${prefix}-command-evidence`,
        kind: "command_execution",
        artifactIds: [],
        provenance: "external-runner",
        reference: reference(`${prefix}-command`),
      },
    ],
  });
  const artifactId = `${prefix}-artifact`;
  const evidenceId = `${prefix}-outcome-evidence`;
  const result = await control.applyEvent({
    schemaVersion: "1",
    eventId: `${prefix}-outcome`,
    runId,
    actor: { id: `${role}-agent`, role },
    command: {
      type: "node_outcome_submitted",
      nodeId,
      attemptId,
      outcome,
      artifactIds: [artifactId],
      evidenceIds: [evidenceId],
    },
    artifacts: [
      {
        id: artifactId,
        schemaId,
        schemaVersion: "1",
        derivedFromArtifactIds: [],
        reference: reference(`${prefix}-artifact`),
      },
    ],
    evidence: [
      {
        id: evidenceId,
        kind: role === "reviewer" ? "independent_review" : "artifact_validation",
        artifactIds: [artifactId],
        provenance: `${role}-agent`,
        reference: reference(`${prefix}-outcome`),
      },
    ],
  });
  if (!result.accepted) throw new Error(result.message);
}

async function advanceToHumanGate(projectRoot: string, runId: string): Promise<void> {
  const control = new RunGraphControlPlane(projectRoot);
  await completeCurrentNode({
    control,
    runId,
    role: "planner",
    outcome: "plan_valid",
    schemaId: "dev-role.plan",
    prefix: "plan",
  });
  await completeCurrentNode({
    control,
    runId,
    role: "implementer",
    outcome: "implementation_valid",
    schemaId: "dev-role.implementation",
    prefix: "implementation",
  });
  await completeCurrentNode({
    control,
    runId,
    role: "executor",
    outcome: "verify_passed",
    schemaId: "dev-role.verify",
    prefix: "verify",
  });
  await completeCurrentNode({
    control,
    runId,
    role: "reviewer",
    outcome: "approve",
    schemaId: "dev-role.review",
    prefix: "review",
  });
}

describe("[NFR-STABILITY-014-AC1] run CLI は durable control plane を操作する", () => {
  let projectRoot = "";
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "gh-gantt-run-command-"));
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await new ConfigStore(projectRoot).write(makeConfig());
    const tasks: TasksFile = {
      tasks: [makeTask()],
      cache: { comments: {}, reactions: {} },
    };
    await new TasksStore(projectRoot).write(tasks);
  });

  afterEach(async () => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function startAtPrGate(): Promise<string> {
    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-start",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );
    const started = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      view: { runId: string };
    };
    await advanceToHumanGate(projectRoot, started.view.runId);
    await createRunCommand().parseAsync(
      [
        "decide",
        started.view.runId,
        "--event-id",
        "event-human-before-pr",
        "--actor",
        "human-1",
        "--decision",
        "approved",
        "--evidence-id",
        "human-evidence-before-pr",
        "--json",
      ],
      { from: "user" },
    );
    return started.view.runId;
  }

  it("run group を登録し、OPEN Issue から exact-bound run を開始して bounded view を表示する", async () => {
    const runGroup = buildProgram().commands.find((command) => command.name() === "run");
    expect(runGroup?.commands.map((command) => command.name())).toEqual([
      "dispatch",
      "claim",
      "heartbeat",
      "release",
      "reclaim",
      "start",
      "event",
      "show",
      "resume",
      "decide",
      "observe-pr",
    ]);

    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-start",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );
    const started = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      accepted: boolean;
      view: { runId: string; currentNode: { contractNodeId: string } };
    };
    expect(started).toMatchObject({
      accepted: true,
      view: { currentNode: { contractNodeId: "planner" } },
    });

    logSpy.mockClear();
    await createRunCommand().parseAsync(["show", started.view.runId, "--limit", "1", "--json"], {
      from: "user",
    });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      runId: started.view.runId,
      artifacts: { limit: 1, total: 0, truncated: false, items: [] },
      evidence: { limit: 1, total: 0, truncated: false, items: [] },
    });

    logSpy.mockClear();
    await createRunCommand().parseAsync(["show", started.view.runId, "--limit", "1"], {
      from: "user",
    });
    const human = logSpy.mock.calls[0]?.[0] as string;
    expect(human).toContain("current node:");
    expect(human).toContain("wait:");
    expect(human).toContain("attempt:");
    expect(human).toContain("budgets:");
    expect(human).toContain("transitions:");
    expect(human).toContain("artifacts: 0/0");
    expect(human).toContain("evidence: 0/0");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("run start は同期 task の repository casing が異なっても同じ Issue として扱う", async () => {
    await new TasksStore(projectRoot).write({
      tasks: [makeTask({ github_repo: "STANAH/GH-GANTT" })],
      cache: { comments: {}, reactions: {} },
    });

    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-case-insensitive",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );

    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: true,
      view: { task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 } },
    });
  });

  it.each([
    { option: "--event-id", value: "   ", otherOption: "--actor", otherValue: "orchestrator-1" },
    { option: "--actor", value: "   ", otherOption: "--event-id", otherValue: "event-start" },
  ])("run start は空の $option を invalid_input で拒否する", async (params) => {
    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        params.option,
        params.value,
        params.otherOption,
        params.otherValue,
        "--json",
      ],
      { from: "user" },
    );

    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "invalid_input",
    });
    expect(process.exitCode).toBe(1);
  });

  it("外部 event JSON を適用し、checkpoint と副作用状態を明示して再開する", async () => {
    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-start",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );
    const started = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      view: { runId: string; currentNode: { id: string } };
    };
    const runId = started.view.runId;
    const nodeId = started.view.currentNode.id;
    const eventFile = join(projectRoot, "runner-event.json");
    const actor = { id: "planner-1", role: "planner" } as const;

    await writeFile(
      eventFile,
      JSON.stringify({
        schemaVersion: "1",
        eventId: "event-attempt-start",
        actor,
        command: { type: "attempt_started", nodeId, attemptId: "attempt-1" },
      }),
    );
    logSpy.mockClear();
    await createRunCommand().parseAsync(["event", runId, "--file", eventFile, "--json"], {
      from: "user",
    });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: true,
      view: { activeAttempt: { id: "attempt-1", state: "running" } },
    });

    const reference = {
      kind: "workspace",
      uri: ".dev-flow/328/checkpoint.json",
      sha256: `sha256:${"c".repeat(64)}`,
      byteLength: 256,
    } as const;
    await writeFile(
      eventFile,
      JSON.stringify({
        schemaVersion: "1",
        eventId: "event-pause",
        actor,
        command: {
          type: "run_paused",
          checkpointArtifactId: "checkpoint-1",
          evidenceIds: ["checkpoint-evidence-1"],
          reason: "外部 runner を安全に停止する",
        },
        artifacts: [
          {
            id: "checkpoint-1",
            schemaId: "run.checkpoint",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference,
          },
        ],
        evidence: [
          {
            id: "checkpoint-evidence-1",
            kind: "checkpoint",
            artifactIds: ["checkpoint-1"],
            provenance: "planner-1",
            reference,
          },
        ],
      }),
    );
    logSpy.mockClear();
    await createRunCommand().parseAsync(["event", runId, "--file", eventFile, "--json"], {
      from: "user",
    });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: true,
      view: { state: "paused" },
    });

    logSpy.mockClear();
    await createRunCommand().parseAsync(
      [
        "resume",
        runId,
        "--event-id",
        "event-resume",
        "--actor",
        "orchestrator-1",
        "--checkpoint",
        "checkpoint-1",
        "--evidence",
        "checkpoint-evidence-1",
        "--side-effect-state",
        "not_started",
        "--json",
      ],
      { from: "user" },
    );
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: true,
      view: { state: "running" },
    });

    await writeFile(
      eventFile,
      JSON.stringify({
        schemaVersion: "1",
        eventId: "event-resume",
        actor,
        command: { type: "attempt_started", nodeId, attemptId: "attempt-2" },
      }),
    );
    logSpy.mockClear();
    process.exitCode = undefined;
    await createRunCommand().parseAsync(["event", runId, "--file", eventFile, "--json"], {
      from: "user",
    });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "duplicate_event",
      stateUnchanged: true,
    });
    expect(process.exitCode).toBe(1);
  });

  it("run event は schema に一致しない runner command JSON を invalid_input で拒否する", async () => {
    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-start",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );
    const started = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      view: { runId: string };
    };
    const eventFile = join(projectRoot, "invalid-runner-event.json");
    await writeFile(
      eventFile,
      JSON.stringify({
        schemaVersion: "1",
        eventId: "event-invalid-schema",
        actor: { id: "planner-1", role: "planner" },
        command: { type: "attempt_started", nodeId: "node-1", attemptId: "" },
      }),
    );

    logSpy.mockClear();
    process.exitCode = undefined;
    await createRunCommand().parseAsync(
      ["event", started.view.runId, "--file", eventFile, "--json"],
      { from: "user" },
    );

    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "invalid_input",
    });
    expect(process.exitCode).toBe(1);
  });

  it("run start の control plane 拒否は start 固有ラベルで表示する", async () => {
    const args = [
      "start",
      "--issue",
      "328",
      "--event-id",
      "event-duplicate-start",
      "--actor",
      "orchestrator-1",
    ];
    await createRunCommand().parseAsync(args, { from: "user" });

    errorSpy.mockClear();
    process.exitCode = undefined;
    await createRunCommand().parseAsync(args, { from: "user" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Run start rejected \[duplicate_event\]:/),
    );
    expect(process.exitCode).toBe(1);
  });

  it("CLOSED Issue からの start を fail-closed で拒否する", async () => {
    await new TasksStore(projectRoot).write({
      tasks: [makeTask({ state: "closed" })],
      cache: { comments: {}, reactions: {} },
    });

    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-closed",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );

    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "issue_not_open",
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    {
      name: "human_decision",
      command: {
        type: "human_decision",
        decision: "approved",
        reason: null,
        evidenceIds: ["self-reported-human"],
      },
    },
    {
      name: "pr_observed",
      command: {
        type: "pr_observed",
        repository: "stanah/gh-gantt",
        pullRequestNumber: 334,
        state: "merged",
        isDraft: false,
        linkedIssue: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
        linkageComplete: true,
        evidenceIds: ["self-reported-pr"],
      },
    },
  ])("raw run event の $name 自己申告を authority_denied で拒否する", async ({ command }) => {
    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-start",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );
    const started = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      view: { runId: string };
    };
    const eventFile = join(projectRoot, "untrusted-event.json");
    await writeFile(
      eventFile,
      JSON.stringify({
        schemaVersion: "1",
        eventId: `event-${command.type}`,
        actor: { id: "self-reported", role: "human" },
        command,
      }),
    );

    logSpy.mockClear();
    process.exitCode = undefined;
    await createRunCommand().parseAsync(
      ["event", started.view.runId, "--file", eventFile, "--json"],
      { from: "user" },
    );

    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "authority_denied",
    });
    expect(process.exitCode).toBe(1);
  });

  it("run decide は human authority と canonical decision evidence で human gate を解除する", async () => {
    await createRunCommand().parseAsync(
      [
        "start",
        "--issue",
        "328",
        "--event-id",
        "event-start",
        "--actor",
        "orchestrator-1",
        "--json",
      ],
      { from: "user" },
    );
    const started = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      view: { runId: string };
    };
    await advanceToHumanGate(projectRoot, started.view.runId);

    logSpy.mockClear();
    await createRunCommand().parseAsync(
      [
        "decide",
        started.view.runId,
        "--event-id",
        "event-human-approved",
        "--actor",
        "human-1",
        "--decision",
        "approved",
        "--evidence-id",
        "human-evidence-1",
        "--json",
      ],
      { from: "user" },
    );

    const result = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      accepted: boolean;
      view: { evidence: { items: Array<Record<string, unknown>> } };
    };
    expect(result.accepted).toBe(true);
    expect(result.view.evidence.items).toContainEqual(
      expect.objectContaining({
        id: "human-evidence-1",
        kind: "human_decision",
        actor: { id: "human-1", role: "human" },
        reference: expectedBoundedReference("command", "command:gh-gantt/run/decide", {
          actor: { id: "human-1", role: "human" },
          decision: "approved",
          reason: null,
        }),
      }),
    );
  });

  it("run decide は理由のない override を control plane より前に拒否する", async () => {
    await createRunCommand().parseAsync(
      [
        "decide",
        "run-1",
        "--event-id",
        "event-human-override",
        "--actor",
        "human-1",
        "--decision",
        "override",
        "--evidence-id",
        "human-evidence-1",
        "--json",
      ],
      { from: "user" },
    );

    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "invalid_input",
    });
    expect(process.exitCode).toBe(1);
  });

  it("run observe-pr は対象 Issue と無関係な同一 repository の merged PR を拒否する", async () => {
    const runId = await startAtPrGate();
    const liveState: RunGraphPrObservation = {
      owner: "stanah",
      repo: "gh-gantt",
      number: 334,
      crossRepo: false,
      state: "MERGED",
      isDraft: false,
      linkedIssue: null,
      linkageComplete: true,
      reviewDecision: "APPROVED",
      unresolvedThreads: 0,
      pendingChecks: 0,
    };
    const fetcher = vi.fn(async () => liveState);

    logSpy.mockClear();
    await createRunCommand({ fetchRunGraphPrObservation: fetcher }).parseAsync(
      [
        "observe-pr",
        runId,
        "--repository",
        "stanah/gh-gantt",
        "--number",
        "334",
        "--event-id",
        "event-pr-live",
        "--actor",
        "orchestrator-1",
        "--evidence-id",
        "pr-evidence-1",
        "--json",
      ],
      { from: "user" },
    );

    expect(fetcher).toHaveBeenCalledWith({
      target: { owner: "stanah", repo: "gh-gantt", number: 334, crossRepo: false },
      expectedIssue: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
    });
    const result = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      accepted: boolean;
      view: { state: string };
    };
    expect(result).toMatchObject({
      accepted: false,
      code: "pr_not_linked_to_task",
      stateUnchanged: true,
      view: { state: "running" },
    });
  });

  it.each([
    { state: "MERGED" as const, isDraft: false, expectedRunState: "completed" },
    { state: "CLOSED" as const, isDraft: false, expectedRunState: "completed" },
    { state: "CLOSED" as const, isDraft: true, expectedRunState: "completed" },
    { state: "OPEN" as const, isDraft: false, expectedRunState: "running" },
    { state: "OPEN" as const, isDraft: true, expectedRunState: "running" },
  ])(
    "run observe-pr は linked $state (draft=$isDraft) の live semantics だけを Run へ反映する",
    async ({ state, isDraft, expectedRunState }) => {
      const runId = await startAtPrGate();
      const liveState: RunGraphPrObservation = {
        owner: "stanah",
        repo: "gh-gantt",
        number: 400,
        crossRepo: false,
        state,
        isDraft,
        linkedIssue: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
        linkageComplete: true,
        reviewDecision: "APPROVED",
        unresolvedThreads: 0,
        pendingChecks: 0,
      };
      const fetcher = vi.fn(async () => liveState);

      logSpy.mockClear();
      await createRunCommand({ fetchRunGraphPrObservation: fetcher }).parseAsync(
        [
          "observe-pr",
          runId,
          "--repository",
          "stanah/gh-gantt",
          "--number",
          "400",
          "--event-id",
          "event-pr-linked",
          "--actor",
          "orchestrator-1",
          "--evidence-id",
          "pr-evidence-linked",
          "--json",
        ],
        { from: "user" },
      );

      const result = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
        accepted: boolean;
        view: { state: string; evidence: { items: Array<Record<string, unknown>> } };
      };
      expect(result).toMatchObject({ accepted: true, view: { state: expectedRunState } });
      if (state === "MERGED") {
        const canonicalLiveState = {
          owner: liveState.owner,
          repo: liveState.repo,
          number: liveState.number,
          state: liveState.state,
          isDraft: liveState.isDraft,
          linkedIssue: liveState.linkedIssue,
          linkageComplete: liveState.linkageComplete,
          reviewDecision: liveState.reviewDecision,
          unresolvedThreads: liveState.unresolvedThreads,
          pendingChecks: liveState.pendingChecks ?? null,
        };
        expect(result.view.evidence.items).toContainEqual(
          expect.objectContaining({
            id: "pr-evidence-linked",
            kind: "github_pr_live",
            reference: expectedBoundedReference(
              "github",
              "https://github.com/stanah/gh-gantt/pull/400",
              canonicalLiveState,
            ),
          }),
        );
      }
    },
  );

  it("run observe-pr は GitHub live 取得失敗時に state/revision を変えない", async () => {
    const runId = await startAtPrGate();
    const before = await new RunGraphControlPlane(projectRoot).inspect(runId);
    const fetcher = vi.fn(async (): Promise<RunGraphPrObservation> => {
      throw new Error("GitHub API unavailable");
    });

    logSpy.mockClear();
    await createRunCommand({ fetchRunGraphPrObservation: fetcher }).parseAsync(
      [
        "observe-pr",
        runId,
        "--repository",
        "stanah/gh-gantt",
        "--number",
        "400",
        "--event-id",
        "event-pr-unavailable",
        "--actor",
        "orchestrator-1",
        "--evidence-id",
        "pr-evidence-unavailable",
        "--json",
      ],
      { from: "user" },
    );

    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "github_live_state_unavailable",
      stateUnchanged: true,
      view: { revision: before.revision, state: before.state },
    });
    await expect(new RunGraphControlPlane(projectRoot).inspect(runId)).resolves.toEqual(before);
  });

  it("run observe-pr は Run と異なる repository を live fetch 前に拒否する", async () => {
    const runId = await startAtPrGate();
    const fetcher = vi.fn();

    logSpy.mockClear();
    await createRunCommand({ fetchRunGraphPrObservation: fetcher }).parseAsync(
      [
        "observe-pr",
        runId,
        "--repository",
        "someone/other-repo",
        "--number",
        "400",
        "--event-id",
        "event-pr-wrong-repo",
        "--actor",
        "orchestrator-1",
        "--evidence-id",
        "pr-evidence-wrong-repo",
        "--json",
      ],
      { from: "user" },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      accepted: false,
      code: "pr_not_linked_to_task",
      stateUnchanged: true,
      view: { state: "running" },
    });
  });

  it("resume は side-effect-state 未指定を command parsing で拒否する", async () => {
    const resume = createRunCommand().commands.find((command) => command.name() === "resume");
    if (!resume) throw new Error("resume command がありません");
    resume.exitOverride();
    resume.configureOutput({ writeErr: () => {} });

    await expect(
      resume.parseAsync(
        [
          "run-1",
          "--event-id",
          "event-resume",
          "--actor",
          "orchestrator-1",
          "--checkpoint",
          "checkpoint-1",
          "--evidence",
          "checkpoint-evidence-1",
        ],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
  });
});
