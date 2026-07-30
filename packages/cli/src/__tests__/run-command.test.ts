import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  type Config,
  type Task,
  type TasksFile,
} from "@gh-gantt/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunCommand } from "../commands/run.js";
import { buildProgram } from "../program.js";
import type { PrGateState } from "../loop/pr-evidence.js";
import { RunGraphControlPlane } from "../run-graph/control-plane.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";

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

  it("run group を登録し、OPEN Issue から exact-bound run を開始して bounded view を表示する", async () => {
    const runGroup = buildProgram().commands.find((command) => command.name() === "run");
    expect(runGroup?.commands.map((command) => command.name())).toEqual([
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
        reference: {
          kind: "command",
          uri: "command:gh-gantt/run/decide",
          sha256: "sha256:68326ecec4486dd727e93480ad238a35bdc877d0fc8807cb68180187f78eac7a",
          byteLength: 77,
        },
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

  it("run observe-pr は注入した fetcher の live state だけから PR evidence を生成する", async () => {
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
    const liveState: PrGateState = {
      owner: "stanah",
      repo: "gh-gantt",
      number: 334,
      crossRepo: false,
      state: "MERGED",
      reviewDecision: "APPROVED",
      unresolvedThreads: 0,
      pendingChecks: 0,
    };
    const fetcher = vi.fn(async () => [liveState]);

    logSpy.mockClear();
    await createRunCommand({ fetchPrGateStates: fetcher }).parseAsync(
      [
        "observe-pr",
        started.view.runId,
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
      targets: [{ owner: "stanah", repo: "gh-gantt", number: 334, crossRepo: false }],
    });
    const result = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      accepted: boolean;
      view: { state: string; evidence: { items: Array<Record<string, unknown>> } };
    };
    expect(result).toMatchObject({ accepted: true, view: { state: "completed" } });
    expect(result.view.evidence.items).toContainEqual(
      expect.objectContaining({
        id: "pr-evidence-1",
        kind: "github_pr_live",
        actor: { id: "orchestrator-1", role: "orchestrator" },
        reference: {
          kind: "github",
          uri: "https://github.com/stanah/gh-gantt/pull/334",
          sha256: "sha256:e5f420fb998d0b76c6321c81102de77af854683553b798038067ff831576bf2f",
          byteLength: 134,
        },
      }),
    );
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
