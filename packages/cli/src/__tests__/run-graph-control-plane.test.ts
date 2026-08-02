import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { gitFixtureEnvironment } from "./git-fixture.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJsonStringify,
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  GANTT_DIR,
  RUN_GRAPH_DIR,
  RUN_GRAPH_RUNS_DIR,
  type RunGraphRunnerCommandInput,
} from "@gh-gantt/shared";
import { RunGraphControlPlane, type DispatchClaimAuthority } from "../run-graph/control-plane.js";
import { GraphContractStore } from "../store/graph-contract.js";
import { RunGraphEventStore } from "../store/run-graph.js";
import {
  DispatchClaimStore,
  createDispatchClaimStoreDependencies,
  type DispatchClaimStoreDependencies,
} from "../store/dispatch-claims.js";

const execFileAsync = promisify(execFile);

const timestamp = "2026-07-30T00:00:00.000Z";

function deterministicDependencies() {
  const counters = new Map<string, number>();
  return {
    now: () => timestamp,
    nextId: (kind: string) => {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${kind}-${next}`;
    },
  };
}

async function createControlPlane() {
  const root = await mkdtemp(join(tmpdir(), "gh-gantt-control-plane-"));
  await new GraphContractStore(root).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
  return { root, control: new RunGraphControlPlane(root, deterministicDependencies()) };
}

const reference = (name: string) => ({
  kind: "workspace" as const,
  uri: `.dev-flow/328/${name}.json`,
  sha256: `sha256:${"d".repeat(64)}`,
  byteLength: 256,
});

async function createClaimedControlPlane(
  storeOverrides: Partial<DispatchClaimStoreDependencies> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "gh-gantt-claimed-control-"));
  await execFileAsync("git", ["init", root], { env: gitFixtureEnvironment() });
  await mkdir(join(root, GANTT_DIR), { recursive: true });
  await writeFile(
    join(root, GANTT_DIR, "gantt.config.json"),
    `${JSON.stringify({
      version: "1",
      project: {
        name: "fixture",
        github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
      },
      sync: {
        auto_create_issues: false,
        field_mapping: { start_date: "Start", end_date: "End" },
      },
      task_types: {
        task: { label: "Task", display: "bar", color: "#000", github_label: null },
      },
      type_hierarchy: { task: [] },
      statuses: { field_name: "Status", values: { Todo: { color: "#000", done: false } } },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" },
      },
      dispatch: { max_concurrency: 1 },
    })}\n`,
  );
  await new GraphContractStore(root).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
  const claims = new DispatchClaimStore(
    root,
    createDispatchClaimStoreDependencies({
      now: () => "2026-08-02T00:00:00.000Z",
      nextId: () => "claim-ready-frontier",
      readCurrentSnapshotFingerprint: async () => "d".repeat(64),
      ...storeOverrides,
    }),
  );
  const control = new RunGraphControlPlane(root, deterministicDependencies(), claims);
  const runId = await startRun(control, "claimed-fixture-start");
  const started = await control.inspect(runId);
  const nodeId = started.currentNode?.id;
  if (!nodeId) throw new Error("current node が必要です");
  await control.applyEvent({
    schemaVersion: "1",
    eventId: "claimed-fixture-attempt-start",
    runId,
    actor: { id: "task-runner", role: "planner" },
    command: { type: "attempt_started", nodeId, attemptId: "planner-attempt" },
  });
  const claimed = await claims.claim({
    schemaVersion: "1",
    eventId: "claimed-fixture-claim",
    expectedEntityVersion: 0,
    taskId: "stanah/gh-gantt#328",
    repository: "stanah/gh-gantt",
    state: "Todo",
    ownerId: "task-runner",
    workspaceId: "workspace:ready-frontier",
    runId,
    leaseDurationSeconds: 300,
    dispatchPlanId: "dispatch-plan:ready-frontier",
    dispatchPlanVersion: "1",
    snapshotFingerprint: "d".repeat(64),
  });
  if (!claimed.accepted) throw new Error(claimed.message);
  return { root, claims, control, runId, nodeId, claimed };
}

function commandEvidence(id: string) {
  return {
    id,
    kind: "command_execution" as const,
    artifactIds: [],
    provenance: "task-runner",
    reference: reference(id),
  };
}

function withClaimAuthorityOverrides(
  claims: DispatchClaimStore,
  overrides: Partial<DispatchClaimAuthority>,
): DispatchClaimAuthority {
  return new Proxy(claims, {
    get(target, property) {
      const override = overrides[property as keyof DispatchClaimAuthority];
      if (override) return override;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DispatchClaimAuthority;
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
  return control.applyEvent({
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
}

async function startRun(control: RunGraphControlPlane, eventId: string) {
  const result = await control.start({
    schemaVersion: "1",
    eventId,
    actor: { id: "orchestrator-1", role: "orchestrator" },
    task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
    contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
  });
  if (!result.accepted) throw new Error(result.message);
  return result.view.runId;
}

async function advanceToHumanPr(control: RunGraphControlPlane, runId: string): Promise<void> {
  await completeCurrentNode({
    control,
    runId,
    role: "planner",
    outcome: "plan_valid",
    schemaId: "dev-role.plan",
    prefix: "legacy-plan",
  });
  await completeCurrentNode({
    control,
    runId,
    role: "implementer",
    outcome: "implementation_valid",
    schemaId: "dev-role.implementation",
    prefix: "legacy-implementation",
  });
  await completeCurrentNode({
    control,
    runId,
    role: "executor",
    outcome: "verify_passed",
    schemaId: "dev-role.verify",
    prefix: "legacy-verification",
  });
  await completeCurrentNode({
    control,
    runId,
    role: "reviewer",
    outcome: "approve",
    schemaId: "dev-role.review",
    prefix: "legacy-review",
  });
  const approved = await control.applyEvent({
    schemaVersion: "1",
    eventId: "legacy-human-approved",
    runId,
    actor: { id: "maintainer-1", role: "human" },
    command: {
      type: "human_decision",
      decision: "approved",
      reason: null,
      evidenceIds: ["legacy-human-evidence"],
    },
    evidence: [
      {
        id: "legacy-human-evidence",
        kind: "human_decision",
        artifactIds: [],
        provenance: "maintainer-1",
        reference: reference("legacy-human-evidence"),
      },
    ],
  });
  if (!approved.accepted) throw new Error(approved.message);
}

async function writeLegacyPrObservedEvent(params: {
  root: string;
  runId: string;
  sequence: number;
}): Promise<void> {
  const eventId = "legacy-pr-observed";
  const runSegment = Buffer.from(params.runId, "utf8").toString("base64url");
  const eventSegment = Buffer.from(eventId, "utf8").toString("base64url");
  const eventsDir = join(
    params.root,
    GANTT_DIR,
    RUN_GRAPH_DIR,
    RUN_GRAPH_RUNS_DIR,
    runSegment,
    "events",
  );
  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, `${String(params.sequence).padStart(12, "0")}-${eventSegment}.json`),
    JSON.stringify({
      recordType: "accepted",
      eventId,
      sequence: params.sequence,
      runId: params.runId,
      acceptedAt: "2026-07-30T00:05:00.000Z",
      actor: { id: "orchestrator-1", role: "orchestrator" },
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
}

async function writeLegacyPrObservedRejection(params: {
  root: string;
  runId: string;
}): Promise<void> {
  const rejectionId = "legacy-pr-rejection";
  const runSegment = Buffer.from(params.runId, "utf8").toString("base64url");
  const rejectionSegment = Buffer.from(rejectionId, "utf8").toString("base64url");
  const rejectionsDir = join(
    params.root,
    GANTT_DIR,
    RUN_GRAPH_DIR,
    RUN_GRAPH_RUNS_DIR,
    runSegment,
    "rejections",
  );
  await mkdir(rejectionsDir, { recursive: true });
  await writeFile(
    join(rejectionsDir, `${rejectionSegment}.json`),
    JSON.stringify({
      recordType: "rejected",
      rejectionId,
      eventId: "legacy-pr-observed-rejected",
      runId: params.runId,
      rejectedAt: "2026-07-30T00:01:00.000Z",
      actor: { id: "orchestrator-1", role: "orchestrator" },
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
    }),
  );
}

describe("[NFR-STABILITY-014-AC2] RunGraphControlPlane は start/applyEvent/inspect に統制を隠す", () => {
  it("exact-bound contract と Issue から planner ready の durable run を開始する", async () => {
    const { root, control } = await createControlPlane();
    const result = await control.start({
      schemaVersion: "1",
      eventId: "start-328",
      actor: { id: "orchestrator-1", role: "orchestrator" },
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("start が拒否されました");
    expect(result.view).toMatchObject({
      state: "running",
      revision: 1,
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      createdAt: timestamp,
      updatedAt: timestamp,
      currentNode: { contractNodeId: "planner", state: "ready", activeAttemptId: null },
      activeAttempt: null,
      waitReason: null,
      allowedNextTransitions: ["attempt_started"],
      nodes: { total: 1, limit: 20, truncated: false, items: [{ contractNodeId: "planner" }] },
      attempts: { total: 0, limit: 20, truncated: false, items: [] },
    });

    const restored = await new RunGraphControlPlane(root, deterministicDependencies()).inspect(
      result.view.runId,
    );
    expect(restored).toEqual(result.view);
  });

  it("node と attempt の履歴を指定 limit で bounded view にする", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-bounded-project-map-view");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_valid",
      schemaId: "dev-role.plan",
      prefix: "bounded-plan",
    });

    const view = await control.inspect(runId, 1);

    expect(view.nodes).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(view.nodes.items).toHaveLength(1);
    expect(view.nodes.items[0]?.contractNodeId).toBe("implementer");
    expect(view.attempts).toMatchObject({ total: 1, limit: 1, truncated: false });
    expect(view.attempts.items[0]?.actor.id).toBe("planner-agent");
  });

  it("deep link 対象 node が末尾の limit 外でも bounded view に含める", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-focused-project-map-view");
    const started = await control.inspect(runId);
    const plannerNodeId = started.currentNode?.id;
    if (!plannerNodeId) throw new Error("planner node がありません");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_valid",
      schemaId: "dev-role.plan",
      prefix: "focused-plan",
    });

    const view = await control.inspect(runId, 1, plannerNodeId);

    expect(view.nodes).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(view.nodes.items.map((node) => node.id)).toEqual([plannerNodeId]);
    expect(view.attempts.items.map((attempt) => attempt.nodeId)).toEqual([plannerNodeId]);
    expect(view.artifacts.items.map((artifact) => artifact.nodeId)).toEqual([plannerNodeId]);
    expect(view.evidence.items.map((evidence) => evidence.nodeId)).toEqual([plannerNodeId]);
  });

  it("unsupported binding と orchestrator 以外の start を fail-closed で拒否する", async () => {
    const { control } = await createControlPlane();
    await expect(
      control.start({
        schemaVersion: "1",
        eventId: "start-unsupported",
        actor: { id: "orchestrator-1", role: "orchestrator" },
        task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
        contract: { planId: "dev-role-fixed", planVersion: "2", schemaVersion: "1" },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "unsupported_contract_binding",
      stateUnchanged: true,
    });
    await expect(
      control.start({
        schemaVersion: "1",
        eventId: "start-runner",
        actor: { id: "runner-1", role: "executor" },
        task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
        contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "authority_denied", stateUnchanged: true });
  });
});

describe("[NFR-STABILITY-014-AC6] fixed dev-role transition は accepted outcome event だけで進む", () => {
  it("non-Git standalone completion は process locale に依存せず従来動作を保つ", async () => {
    const previousLocale = process.env.LC_ALL;
    process.env.LC_ALL = "ja_JP.UTF-8";
    try {
      const { control } = await createControlPlane();
      const started = await control.start({
        schemaVersion: "1",
        eventId: "standalone-locale-start",
        actor: { id: "orchestrator-1", role: "orchestrator" },
        task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
        contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      });
      if (!started.accepted || !started.view.currentNode) throw new Error("start failure");
      const runId = started.view.runId;
      const nodeId = started.view.currentNode.id;
      await control.applyEvent({
        schemaVersion: "1",
        eventId: "standalone-locale-attempt-start",
        runId,
        actor: { id: "planner-1", role: "planner" },
        command: { type: "attempt_started", nodeId, attemptId: "standalone-locale-attempt" },
      });

      await expect(
        control.applyEvent({
          schemaVersion: "1",
          eventId: "standalone-locale-attempt-finish",
          runId,
          actor: { id: "planner-1", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId,
            attemptId: "standalone-locale-attempt",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: ["standalone-locale-evidence"],
          },
          evidence: [
            {
              id: "standalone-locale-evidence",
              kind: "command_execution",
              artifactIds: [],
              provenance: "external-runner",
              reference: reference("standalone-locale-command"),
            },
          ],
        }),
      ).resolves.toMatchObject({ accepted: true });
    } finally {
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
  });

  it("planner の schema-valid outcome から新しい implementer Run Node を作る", async () => {
    const { root, control } = await createControlPlane();
    const started = await control.start({
      schemaVersion: "1",
      eventId: "start-328",
      actor: { id: "orchestrator-1", role: "orchestrator" },
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    });
    if (!started.accepted || !started.view.currentNode) throw new Error("start failure");
    const runId = started.view.runId;
    const plannerNodeId = started.view.currentNode.id;

    const attemptStarted = await control.applyEvent({
      schemaVersion: "1",
      eventId: "planner-attempt-started",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "attempt_started",
        nodeId: plannerNodeId,
        attemptId: "attempt-planner-1",
      },
    });
    expect(attemptStarted).toMatchObject({
      accepted: true,
      view: { activeAttempt: { id: "attempt-planner-1", state: "running" } },
    });

    const attemptFinished = await control.applyEvent({
      schemaVersion: "1",
      eventId: "planner-attempt-finished",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "attempt_finished",
        nodeId: plannerNodeId,
        attemptId: "attempt-planner-1",
        outcome: "succeeded",
        artifactIds: [],
        evidenceIds: ["evidence-planner-command"],
      },
      evidence: [
        {
          id: "evidence-planner-command",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("planner-command"),
        },
      ],
    });
    expect(attemptFinished).toMatchObject({
      accepted: true,
      view: {
        activeAttempt: { id: "attempt-planner-1", state: "succeeded" },
        allowedNextTransitions: ["node_outcome_submitted", "run_paused"],
      },
    });

    const outcome = await control.applyEvent({
      schemaVersion: "1",
      eventId: "planner-outcome",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "node_outcome_submitted",
        nodeId: plannerNodeId,
        attemptId: "attempt-planner-1",
        outcome: "plan_valid",
        artifactIds: ["artifact-plan"],
        evidenceIds: ["evidence-plan-validation"],
      },
      artifacts: [
        {
          id: "artifact-plan",
          schemaId: "dev-role.plan",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("01-plan"),
        },
      ],
      evidence: [
        {
          id: "evidence-plan-validation",
          kind: "artifact_validation",
          artifactIds: ["artifact-plan"],
          provenance: "schema-validator",
          reference: reference("plan-validation"),
        },
      ],
    });
    expect(outcome).toMatchObject({
      accepted: true,
      view: {
        revision: 4,
        currentNode: { contractNodeId: "implementer", state: "ready" },
        activeAttempt: null,
        artifacts: { total: 1, truncated: false },
        evidence: { total: 2, truncated: false },
      },
    });
    if (!outcome.accepted) throw new Error("outcome failure");
    await expect(
      new RunGraphControlPlane(root, deterministicDependencies()).inspect(runId),
    ).resolves.toEqual(outcome.view);

    const duplicate = await control.applyEvent({
      schemaVersion: "1",
      eventId: "planner-outcome",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "node_outcome_submitted",
        nodeId: plannerNodeId,
        attemptId: "attempt-planner-1",
        outcome: "plan_valid",
        artifactIds: ["artifact-plan"],
        evidenceIds: ["evidence-plan-validation"],
      },
    });
    expect(duplicate).toMatchObject({
      accepted: false,
      code: "duplicate_event",
      stateUnchanged: true,
      view: { revision: 4 },
    });
  });

  it("invalid transition、stale attempt、artifact schema mismatch は state を変えない", async () => {
    const { control } = await createControlPlane();
    const started = await control.start({
      schemaVersion: "1",
      eventId: "start-invalid-cases",
      actor: { id: "orchestrator-1", role: "orchestrator" },
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    });
    if (!started.accepted || !started.view.currentNode) throw new Error("start failure");
    const { runId } = started.view;
    const nodeId = started.view.currentNode.id;
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "pr-before-human-gate",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "pr_observed",
          repository: "stanah/gh-gantt",
          pullRequestNumber: 400,
          state: "merged",
          isDraft: false,
          linkedIssue: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
          linkageComplete: true,
          evidenceIds: ["pr-before-human-evidence"],
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "invalid_transition",
      stateUnchanged: true,
      view: { revision: 1 },
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "attempt-start",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: { type: "attempt_started", nodeId, attemptId: "attempt-current" },
    });

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "attempt-start-again",
        runId,
        actor: { id: "planner-1", role: "planner" },
        command: { type: "attempt_started", nodeId, attemptId: "attempt-second" },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "invalid_transition",
      stateUnchanged: true,
      view: { revision: 2 },
    });
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "stale-attempt-finish",
        runId,
        actor: { id: "planner-1", role: "planner" },
        command: {
          type: "attempt_finished",
          nodeId,
          attemptId: "attempt-old",
          outcome: "succeeded",
          artifactIds: [],
          evidenceIds: ["evidence-stale"],
        },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "stale_attempt", view: { revision: 2 } });

    await control.applyEvent({
      schemaVersion: "1",
      eventId: "attempt-finish-current",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "attempt_finished",
        nodeId,
        attemptId: "attempt-current",
        outcome: "succeeded",
        artifactIds: [],
        evidenceIds: ["evidence-command-current"],
      },
      evidence: [
        {
          id: "evidence-command-current",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("command-current"),
        },
      ],
    });
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "wrong-plan-schema",
        runId,
        actor: { id: "planner-1", role: "planner" },
        command: {
          type: "node_outcome_submitted",
          nodeId,
          attemptId: "attempt-current",
          outcome: "plan_valid",
          artifactIds: ["artifact-wrong"],
          evidenceIds: ["evidence-wrong"],
        },
        artifacts: [
          {
            id: "artifact-wrong",
            schemaId: "dev-role.review",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("wrong-artifact"),
          },
        ],
        evidence: [
          {
            id: "evidence-wrong",
            kind: "artifact_validation",
            artifactIds: ["artifact-wrong"],
            provenance: "schema-validator",
            reference: reference("wrong-validation"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "artifact_schema_mismatch",
      stateUnchanged: true,
      view: { revision: 3 },
    });
  });

  it("active attempt と異なる actor による node outcome を拒否する", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-actor-lineage");
    const started = await control.inspect(runId);
    if (!started.currentNode) throw new Error("current node がありません");
    const nodeId = started.currentNode.id;

    await control.applyEvent({
      schemaVersion: "1",
      eventId: "actor-lineage-attempt-start",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: { type: "attempt_started", nodeId, attemptId: "actor-lineage-attempt" },
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "actor-lineage-attempt-finish",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "attempt_finished",
        nodeId,
        attemptId: "actor-lineage-attempt",
        outcome: "succeeded",
        artifactIds: [],
        evidenceIds: ["actor-lineage-command-evidence"],
      },
      evidence: [
        {
          id: "actor-lineage-command-evidence",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("actor-lineage-command"),
        },
      ],
    });

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "actor-lineage-outcome",
        runId,
        actor: { id: "planner-2", role: "planner" },
        command: {
          type: "node_outcome_submitted",
          nodeId,
          attemptId: "actor-lineage-attempt",
          outcome: "plan_valid",
          artifactIds: ["actor-lineage-artifact"],
          evidenceIds: ["actor-lineage-validation"],
        },
        artifacts: [
          {
            id: "actor-lineage-artifact",
            schemaId: "dev-role.plan",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("actor-lineage-artifact"),
          },
        ],
        evidence: [
          {
            id: "actor-lineage-validation",
            kind: "artifact_validation",
            artifactIds: ["actor-lineage-artifact"],
            provenance: "schema-validator",
            reference: reference("actor-lineage-validation"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "authority_denied",
      stateUnchanged: true,
      view: { revision: 3, currentNode: { id: nodeId, state: "running" } },
    });

    const validOutcome = await control.applyEvent({
      schemaVersion: "1",
      eventId: "actor-lineage-outcome-valid",
      runId,
      actor: { id: "planner-1", role: "planner" },
      command: {
        type: "node_outcome_submitted",
        nodeId,
        attemptId: "actor-lineage-attempt",
        outcome: "plan_valid",
        artifactIds: ["actor-lineage-artifact"],
        evidenceIds: ["actor-lineage-validation"],
      },
      artifacts: [
        {
          id: "actor-lineage-artifact",
          schemaId: "dev-role.plan",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("actor-lineage-artifact"),
        },
      ],
      evidence: [
        {
          id: "actor-lineage-validation",
          kind: "artifact_validation",
          artifactIds: ["actor-lineage-artifact"],
          provenance: "schema-validator",
          reference: reference("actor-lineage-validation"),
        },
      ],
    });
    expect(validOutcome).toMatchObject({ accepted: true, view: { revision: 4 } });
    if (!validOutcome.accepted) throw new Error("正しい actor の outcome が拒否されました");
    expect(validOutcome.view.artifacts.items).toEqual([
      expect.objectContaining({
        producerAttemptId: "actor-lineage-attempt",
        actor: { id: "planner-1", role: "planner" },
      }),
    ]);
    expect(validOutcome.view.evidence.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "actor-lineage-validation",
          producerAttemptId: "actor-lineage-attempt",
          actor: { id: "planner-1", role: "planner" },
        }),
      ]),
    );
  });

  it("過去 attempt の evidence/artifact を attempt finish と node outcome に再利用できない", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-stale-lineage");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_valid",
      schemaId: "dev-role.plan",
      prefix: "stale-lineage-plan",
    });
    await completeCurrentNode({
      control,
      runId,
      role: "implementer",
      outcome: "implementation_valid",
      schemaId: "dev-role.implementation",
      prefix: "stale-lineage-old-implementation",
    });
    await completeCurrentNode({
      control,
      runId,
      role: "executor",
      outcome: "verify_failed",
      schemaId: "dev-role.verify",
      prefix: "stale-lineage-verify",
    });

    const retry = await control.inspect(runId);
    if (!retry.currentNode) throw new Error("retry node がありません");
    const nodeId = retry.currentNode.id;
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-lineage-retry-start",
      runId,
      actor: { id: "implementer-agent", role: "implementer" },
      command: {
        type: "attempt_started",
        nodeId,
        attemptId: "stale-lineage-current-attempt",
      },
    });
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "stale-lineage-reused-finish",
        runId,
        actor: { id: "implementer-agent", role: "implementer" },
        command: {
          type: "attempt_finished",
          nodeId,
          attemptId: "stale-lineage-current-attempt",
          outcome: "succeeded",
          artifactIds: [],
          evidenceIds: ["stale-lineage-old-implementation-command-evidence"],
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "stale_attempt",
      stateUnchanged: true,
      view: {
        revision: 11,
        activeAttempt: { id: "stale-lineage-current-attempt", state: "running" },
      },
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-lineage-retry-finish",
      runId,
      actor: { id: "implementer-agent", role: "implementer" },
      command: {
        type: "attempt_finished",
        nodeId,
        attemptId: "stale-lineage-current-attempt",
        outcome: "succeeded",
        artifactIds: [],
        evidenceIds: ["stale-lineage-current-command"],
      },
      evidence: [
        {
          id: "stale-lineage-current-command",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("stale-lineage-current-command"),
        },
      ],
    });

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "stale-lineage-reused-outcome",
        runId,
        actor: { id: "implementer-agent", role: "implementer" },
        command: {
          type: "node_outcome_submitted",
          nodeId,
          attemptId: "stale-lineage-current-attempt",
          outcome: "implementation_valid",
          artifactIds: ["stale-lineage-old-implementation-artifact"],
          evidenceIds: ["stale-lineage-old-implementation-outcome-evidence"],
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "stale_attempt",
      stateUnchanged: true,
      view: { revision: 12, currentNode: { id: nodeId, state: "running" } },
    });
    await expect(control.inspect(runId)).resolves.toMatchObject({
      revision: 12,
      currentNode: { id: nodeId, activeAttemptId: "stale-lineage-current-attempt" },
    });
  });

  it("過去と重複する attempt ID を accepted journal に追記しない", async () => {
    const { root, control } = await createControlPlane();
    const runId = await startRun(control, "start-duplicate-attempt-id");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_valid",
      schemaId: "dev-role.plan",
      prefix: "duplicate-attempt-id",
    });
    const implementer = await control.inspect(runId);
    if (!implementer.currentNode) throw new Error("implementer node がありません");

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "duplicate-attempt-id-reuse",
        runId,
        actor: { id: "implementer-agent", role: "implementer" },
        command: {
          type: "attempt_started",
          nodeId: implementer.currentNode.id,
          attemptId: "duplicate-attempt-id-attempt",
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "stale_attempt",
      stateUnchanged: true,
      view: {
        revision: 4,
        currentNode: { id: implementer.currentNode.id, state: "ready", activeAttemptId: null },
      },
    });
    await expect(control.inspect(runId)).resolves.toMatchObject({
      revision: 4,
      currentNode: { id: implementer.currentNode.id, state: "ready", activeAttemptId: null },
    });
    const journal = await new RunGraphEventStore(root).readJournal(runId);
    expect(journal.acceptedEvents).toHaveLength(4);
    expect(
      journal.acceptedEvents.filter(
        (event) =>
          event.command.type === "attempt_started" &&
          event.command.attemptId === "duplicate-attempt-id-attempt",
      ),
    ).toHaveLength(1);
  });

  it("artifact を active attempt のない human gate へ渡すと破棄せず拒否する", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-artifact-without-attempt");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_invalid",
      schemaId: "dev-role.plan",
      prefix: "artifact-without-attempt-plan",
    });
    const before = await control.inspect(runId);

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "artifact-without-attempt-override",
        runId,
        actor: { id: "maintainer-1", role: "human" },
        command: {
          type: "human_decision",
          decision: "override",
          reason: "計画を人手で確認したため続行する",
          evidenceIds: ["artifact-without-attempt-evidence"],
        },
        artifacts: [
          {
            id: "artifact-without-attempt",
            schemaId: "dev-role.plan",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("artifact-without-attempt"),
          },
        ],
        evidence: [
          {
            id: "artifact-without-attempt-evidence",
            kind: "human_decision",
            artifactIds: [],
            provenance: "maintainer-1",
            reference: reference("artifact-without-attempt-evidence"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "artifact_schema_mismatch",
      stateUnchanged: true,
      view: { revision: before.revision },
    });
  });

  it("失敗した attempt は human gate から contract の自己 edge で同じ role を再試行する", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-failed-attempt-recovery");
    const started = await control.inspect(runId);
    if (!started.currentNode) throw new Error("planner node がありません");
    const failedNodeId = started.currentNode.id;

    await control.applyEvent({
      schemaVersion: "1",
      eventId: "failed-attempt-start",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_started",
        nodeId: failedNodeId,
        attemptId: "failed-attempt",
      },
    });
    const failed = await control.applyEvent({
      schemaVersion: "1",
      eventId: "failed-attempt-finish",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_finished",
        nodeId: failedNodeId,
        attemptId: "failed-attempt",
        outcome: "failed",
        artifactIds: [],
        evidenceIds: ["failed-attempt-evidence"],
      },
      evidence: [
        {
          id: "failed-attempt-evidence",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("failed-attempt-evidence"),
        },
      ],
    });
    expect(failed).toMatchObject({
      accepted: true,
      view: {
        state: "waiting_human",
        waitReason: "attempt_failed",
        currentNode: { id: failedNodeId, contractNodeId: "planner", state: "waiting_human" },
        activeAttempt: { id: "failed-attempt", state: "failed" },
        allowedNextTransitions: ["human_decision"],
      },
    });

    const override = await control.applyEvent({
      schemaVersion: "1",
      eventId: "failed-attempt-override",
      runId,
      actor: { id: "maintainer-1", role: "human" },
      command: {
        type: "human_decision",
        decision: "override",
        reason: "失敗原因を確認したため planner を再実行する",
        evidenceIds: ["failed-attempt-override-evidence"],
      },
      evidence: [
        {
          id: "failed-attempt-override-evidence",
          kind: "human_decision",
          artifactIds: [],
          provenance: "maintainer-1",
          reference: reference("failed-attempt-override-evidence"),
        },
      ],
    });
    expect(override).toMatchObject({
      accepted: true,
      view: {
        state: "running",
        currentNode: {
          contractNodeId: "planner",
          state: "ready",
          previousNodeId: failedNodeId,
        },
        activeAttempt: null,
        allowedNextTransitions: ["attempt_started"],
      },
    });
  });

  it("cancelled attempt は Run を終端させ human override を許可しない", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-cancelled-attempt");
    const started = await control.inspect(runId);
    if (!started.currentNode) throw new Error("planner node がありません");

    await control.applyEvent({
      schemaVersion: "1",
      eventId: "cancelled-attempt-start",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_started",
        nodeId: started.currentNode.id,
        attemptId: "cancelled-attempt",
      },
    });
    const cancelled = await control.applyEvent({
      schemaVersion: "1",
      eventId: "cancelled-attempt-finish",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_finished",
        nodeId: started.currentNode.id,
        attemptId: "cancelled-attempt",
        outcome: "cancelled",
        artifactIds: [],
        evidenceIds: ["cancelled-attempt-evidence"],
      },
      evidence: [
        {
          id: "cancelled-attempt-evidence",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("cancelled-attempt-evidence"),
        },
      ],
    });
    expect(cancelled).toMatchObject({
      accepted: true,
      view: {
        state: "cancelled",
        currentNode: { state: "cancelled" },
        activeAttempt: { state: "cancelled" },
        allowedNextTransitions: [],
      },
    });
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "cancelled-attempt-override",
        runId,
        actor: { id: "maintainer-1", role: "human" },
        command: {
          type: "human_decision",
          decision: "override",
          reason: "取消後の続行は許可しない",
          evidenceIds: ["cancelled-attempt-override-evidence"],
        },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "invalid_transition", stateUnchanged: true });
  });

  it("human override は現在 node からの明示 contract edge がなければ拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-control-plane-no-override-edge-"));
    await new GraphContractStore(root).install({
      ...FIXED_DEV_ROLE_GRAPH_CONTRACT,
      edges: FIXED_DEV_ROLE_GRAPH_CONTRACT.edges.filter(
        (edge) => !(edge.from === "human-pr" && edge.condition === "human_override"),
      ),
    });
    const control = new RunGraphControlPlane(root, deterministicDependencies());
    const runId = await startRun(control, "start-no-override-edge");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_invalid",
      schemaId: "dev-role.plan",
      prefix: "no-override-edge-plan",
    });
    const before = await control.inspect(runId);

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "no-override-edge-decision",
        runId,
        actor: { id: "maintainer-1", role: "human" },
        command: {
          type: "human_decision",
          decision: "override",
          reason: "明示 edge がない場合は続行しない",
          evidenceIds: ["no-override-edge-evidence"],
        },
        evidence: [
          {
            id: "no-override-edge-evidence",
            kind: "human_decision",
            artifactIds: [],
            provenance: "maintainer-1",
            reference: reference("no-override-edge-evidence"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "invalid_transition",
      stateUnchanged: true,
      view: { revision: before.revision },
    });
  });
});

describe("[NFR-STABILITY-014-AC6] verify retry と review improvement は独立 bounded budget に従う", () => {
  it("3回目の verify failure で retry を増やさず human gate に停止する", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-verify-budget");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_valid",
      schemaId: "dev-role.plan",
      prefix: "budget-plan",
    });

    for (let pass = 1; pass <= 3; pass += 1) {
      await completeCurrentNode({
        control,
        runId,
        role: "implementer",
        outcome: "implementation_valid",
        schemaId: "dev-role.implementation",
        prefix: `budget-impl-${pass}`,
      });
      const result = await completeCurrentNode({
        control,
        runId,
        role: "executor",
        outcome: "verify_failed",
        schemaId: "dev-role.verify",
        prefix: `budget-verify-${pass}`,
      });
      expect(result.accepted).toBe(true);
    }

    const view = await control.inspect(runId);
    expect(view).toMatchObject({
      state: "waiting_human",
      waitReason: "verify_budget_exhausted",
      budgets: { executorRetries: 2, improvementIterations: 0 },
      currentNode: { contractNodeId: "human-pr", state: "waiting_human" },
      allowedNextTransitions: ["human_decision"],
    });
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "runner-bypass",
        runId,
        actor: { id: "executor-agent", role: "executor" },
        command: {
          type: "human_decision",
          decision: "override",
          reason: "runner override",
          evidenceIds: ["runner-evidence"],
        },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "authority_denied" });

    const override = await control.applyEvent({
      schemaVersion: "1",
      eventId: "human-budget-override",
      runId,
      actor: { id: "maintainer-1", role: "human" },
      command: {
        type: "human_decision",
        decision: "override",
        reason: "失敗証跡を確認し、追加修正を1回だけ許可する",
        evidenceIds: ["human-budget-evidence"],
      },
      evidence: [
        {
          id: "human-budget-evidence",
          kind: "human_decision",
          artifactIds: [],
          provenance: "maintainer-1",
          reference: reference("human-budget-decision"),
        },
      ],
    });
    expect(override).toMatchObject({
      accepted: true,
      view: {
        state: "running",
        currentNode: { contractNodeId: "implementer", state: "ready" },
      },
    });
  });

  it("review request-changes は executor retry を消費せず4回目で human gate に停止する", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-review-budget");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_valid",
      schemaId: "dev-role.plan",
      prefix: "review-plan",
    });
    for (let pass = 1; pass <= 4; pass += 1) {
      await completeCurrentNode({
        control,
        runId,
        role: "implementer",
        outcome: "implementation_valid",
        schemaId: "dev-role.implementation",
        prefix: `review-impl-${pass}`,
      });
      await completeCurrentNode({
        control,
        runId,
        role: "executor",
        outcome: "verify_passed",
        schemaId: "dev-role.verify",
        prefix: `review-exec-${pass}`,
      });
      await completeCurrentNode({
        control,
        runId,
        role: "reviewer",
        outcome: "request_changes",
        schemaId: "dev-role.review",
        prefix: `review-reviewer-${pass}`,
      });
    }
    expect(await control.inspect(runId)).toMatchObject({
      state: "waiting_human",
      waitReason: "review_budget_exhausted",
      budgets: { executorRetries: 0, improvementIterations: 3 },
    });
  });
});

describe("[NFR-STABILITY-014-AC5] checkpoint は同じ attempt を重複 dispatch せず再開する", () => {
  it("プロセス再起動後も active attempt と checkpoint を保って resume する", async () => {
    const { root, control } = await createControlPlane();
    const runId = await startRun(control, "start-checkpoint");
    const before = await control.inspect(runId);
    if (!before.currentNode) throw new Error("planner node がありません");
    const nodeId = before.currentNode.id;
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "checkpoint-attempt-start",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: { type: "attempt_started", nodeId, attemptId: "checkpoint-attempt" },
    });
    const paused = await control.applyEvent({
      schemaVersion: "1",
      eventId: "checkpoint-pause",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_paused",
        checkpointArtifactId: "checkpoint-artifact",
        evidenceIds: ["checkpoint-evidence"],
        reason: "runner process を安全に停止する",
      },
      artifacts: [
        {
          id: "checkpoint-artifact",
          schemaId: "run.checkpoint",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("checkpoint"),
        },
      ],
      evidence: [
        {
          id: "checkpoint-evidence",
          kind: "checkpoint",
          artifactIds: ["checkpoint-artifact"],
          provenance: "external-runner",
          reference: reference("checkpoint-evidence"),
        },
      ],
    });
    expect(paused).toMatchObject({
      accepted: true,
      view: {
        state: "paused",
        activeAttempt: { id: "checkpoint-attempt", state: "running" },
        allowedNextTransitions: ["run_resumed"],
        artifacts: {
          items: [
            {
              id: "checkpoint-artifact",
              nodeId,
              producerAttemptId: "checkpoint-attempt",
              actor: { id: "planner-agent", role: "planner" },
            },
          ],
        },
        evidence: {
          items: [
            {
              id: "checkpoint-evidence",
              nodeId,
              producerAttemptId: "checkpoint-attempt",
              actor: { id: "planner-agent", role: "planner" },
            },
          ],
        },
      },
    });
    if (!paused.accepted) throw new Error("pause が拒否されました");

    const restored = new RunGraphControlPlane(root, deterministicDependencies());
    expect(await restored.inspect(runId)).toEqual(paused.view);
    await expect(
      restored.applyEvent({
        schemaVersion: "1",
        eventId: "checkpoint-resume-unknown",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_resumed",
          checkpointArtifactId: "checkpoint-artifact",
          evidenceIds: ["checkpoint-evidence"],
          sideEffectState: "unknown",
        },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "evidence_required", stateUnchanged: true });
    await expect(
      restored.applyEvent({
        schemaVersion: "1",
        eventId: "checkpoint-resume-committed-without-reconciliation",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_resumed",
          checkpointArtifactId: "checkpoint-artifact",
          evidenceIds: ["checkpoint-evidence"],
          sideEffectState: "committed",
        },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "evidence_required", stateUnchanged: true });
    const resumed = await restored.applyEvent({
      schemaVersion: "1",
      eventId: "checkpoint-resume",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_resumed",
        checkpointArtifactId: "checkpoint-artifact",
        evidenceIds: ["checkpoint-evidence"],
        sideEffectState: "not_started",
      },
    });
    expect(resumed).toMatchObject({
      accepted: true,
      view: {
        state: "running",
        activeAttempt: { id: "checkpoint-attempt", state: "running" },
        allowedNextTransitions: ["attempt_finished", "run_paused"],
      },
    });
  });

  it("checkpoint schema、evidence kind、artifact ID 再利用を fail-closed で拒否する", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-invalid-checkpoint");
    const view = await control.inspect(runId);
    if (!view.currentNode) throw new Error("planner node がありません");
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "invalid-checkpoint-attempt",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_started",
        nodeId: view.currentNode.id,
        attemptId: "invalid-checkpoint-attempt",
      },
    });
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "wrong-checkpoint-schema",
        runId,
        actor: { id: "planner-agent", role: "planner" },
        command: {
          type: "run_paused",
          checkpointArtifactId: "not-checkpoint",
          evidenceIds: ["not-checkpoint-evidence"],
          reason: "schema 検証",
        },
        artifacts: [
          {
            id: "not-checkpoint",
            schemaId: "dev-role.plan",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("not-checkpoint"),
          },
        ],
        evidence: [
          {
            id: "not-checkpoint-evidence",
            kind: "artifact_validation",
            artifactIds: ["not-checkpoint"],
            provenance: "external-runner",
            reference: reference("not-checkpoint-evidence"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "artifact_schema_mismatch",
      stateUnchanged: true,
    });

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "wrong-checkpoint-evidence-kind",
        runId,
        actor: { id: "planner-agent", role: "planner" },
        command: {
          type: "run_paused",
          checkpointArtifactId: "valid-checkpoint",
          evidenceIds: ["wrong-kind-evidence"],
          reason: "evidence kind 検証",
        },
        artifacts: [
          {
            id: "valid-checkpoint",
            schemaId: "run.checkpoint",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("valid-checkpoint"),
          },
        ],
        evidence: [
          {
            id: "wrong-kind-evidence",
            kind: "artifact_validation",
            artifactIds: ["valid-checkpoint"],
            provenance: "external-runner",
            reference: reference("wrong-kind-evidence"),
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: false, code: "evidence_required", stateUnchanged: true });

    await control.applyEvent({
      schemaVersion: "1",
      eventId: "valid-checkpoint-pause",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "run_paused",
        checkpointArtifactId: "valid-checkpoint",
        evidenceIds: ["valid-checkpoint-evidence"],
        reason: "ID 再利用検証の前提",
      },
      artifacts: [
        {
          id: "valid-checkpoint",
          schemaId: "run.checkpoint",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("valid-checkpoint"),
        },
      ],
      evidence: [
        {
          id: "valid-checkpoint-evidence",
          kind: "checkpoint",
          artifactIds: ["valid-checkpoint"],
          provenance: "external-runner",
          reference: reference("valid-checkpoint-evidence"),
        },
      ],
    });
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "duplicate-checkpoint-artifact",
        runId,
        actor: { id: "planner-agent", role: "planner" },
        command: {
          type: "run_resumed",
          checkpointArtifactId: "valid-checkpoint",
          evidenceIds: ["valid-checkpoint-evidence"],
          sideEffectState: "not_started",
        },
        artifacts: [
          {
            id: "valid-checkpoint",
            schemaId: "run.checkpoint",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("duplicate-checkpoint"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "artifact_schema_mismatch",
      stateUnchanged: true,
    });
  });

  it("過去 attempt の checkpoint を現在の attempt の pause に再利用できない", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-stale-checkpoint-attempt");
    const planner = await control.inspect(runId);
    if (!planner.currentNode) throw new Error("planner node がありません");
    const plannerNodeId = planner.currentNode.id;

    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-checkpoint-planner-start",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_started",
        nodeId: plannerNodeId,
        attemptId: "stale-checkpoint-planner-attempt",
      },
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-checkpoint-planner-pause",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_paused",
        checkpointArtifactId: "stale-checkpoint-planner-artifact",
        evidenceIds: ["stale-checkpoint-planner-evidence"],
        reason: "planner checkpoint を保存する",
      },
      artifacts: [
        {
          id: "stale-checkpoint-planner-artifact",
          schemaId: "run.checkpoint",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("stale-checkpoint-planner"),
        },
      ],
      evidence: [
        {
          id: "stale-checkpoint-planner-evidence",
          kind: "checkpoint",
          artifactIds: ["stale-checkpoint-planner-artifact"],
          provenance: "external-runner",
          reference: reference("stale-checkpoint-planner-evidence"),
        },
      ],
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-checkpoint-planner-resume",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_resumed",
        checkpointArtifactId: "stale-checkpoint-planner-artifact",
        evidenceIds: ["stale-checkpoint-planner-evidence"],
        sideEffectState: "not_started",
      },
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-checkpoint-planner-finish",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_finished",
        nodeId: plannerNodeId,
        attemptId: "stale-checkpoint-planner-attempt",
        outcome: "succeeded",
        artifactIds: [],
        evidenceIds: ["stale-checkpoint-planner-command"],
      },
      evidence: [
        {
          id: "stale-checkpoint-planner-command",
          kind: "command_execution",
          artifactIds: [],
          provenance: "external-runner",
          reference: reference("stale-checkpoint-planner-command"),
        },
      ],
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-checkpoint-planner-outcome",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "node_outcome_submitted",
        nodeId: plannerNodeId,
        attemptId: "stale-checkpoint-planner-attempt",
        outcome: "plan_valid",
        artifactIds: ["stale-checkpoint-plan"],
        evidenceIds: ["stale-checkpoint-plan-validation"],
      },
      artifacts: [
        {
          id: "stale-checkpoint-plan",
          schemaId: "dev-role.plan",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("stale-checkpoint-plan"),
        },
      ],
      evidence: [
        {
          id: "stale-checkpoint-plan-validation",
          kind: "artifact_validation",
          artifactIds: ["stale-checkpoint-plan"],
          provenance: "schema-validator",
          reference: reference("stale-checkpoint-plan-validation"),
        },
      ],
    });

    const implementer = await control.inspect(runId);
    if (!implementer.currentNode) throw new Error("implementer node がありません");
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-checkpoint-implementer-start",
      runId,
      actor: { id: "implementer-agent", role: "implementer" },
      command: {
        type: "attempt_started",
        nodeId: implementer.currentNode.id,
        attemptId: "stale-checkpoint-current-attempt",
      },
    });
    const beforeRejectedPause = await control.inspect(runId);

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "stale-checkpoint-reused-pause",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_paused",
          checkpointArtifactId: "stale-checkpoint-planner-artifact",
          evidenceIds: ["stale-checkpoint-planner-evidence"],
          reason: "過去 checkpoint の再利用を試す",
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "stale_attempt",
      stateUnchanged: true,
      view: {
        revision: beforeRejectedPause.revision,
        state: "running",
        activeAttempt: { id: "stale-checkpoint-current-attempt", state: "running" },
      },
    });
    await expect(control.inspect(runId)).resolves.toEqual(beforeRejectedPause);
  });

  it("最新 pause より古い checkpoint では resume できない", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-stale-resume-checkpoint");
    const planner = await control.inspect(runId);
    if (!planner.currentNode) throw new Error("planner node がありません");
    const nodeId = planner.currentNode.id;
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-resume-attempt-start",
      runId,
      actor: { id: "planner-agent", role: "planner" },
      command: {
        type: "attempt_started",
        nodeId,
        attemptId: "stale-resume-attempt",
      },
    });

    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-resume-first-pause",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_paused",
        checkpointArtifactId: "stale-resume-first-checkpoint",
        evidenceIds: ["stale-resume-first-evidence"],
        reason: "最初の checkpoint",
      },
      artifacts: [
        {
          id: "stale-resume-first-checkpoint",
          schemaId: "run.checkpoint",
          schemaVersion: "1",
          derivedFromArtifactIds: [],
          reference: reference("stale-resume-first-checkpoint"),
        },
      ],
      evidence: [
        {
          id: "stale-resume-first-evidence",
          kind: "checkpoint",
          artifactIds: ["stale-resume-first-checkpoint"],
          provenance: "external-runner",
          reference: reference("stale-resume-first-evidence"),
        },
      ],
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-resume-first-resume",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_resumed",
        checkpointArtifactId: "stale-resume-first-checkpoint",
        evidenceIds: ["stale-resume-first-evidence"],
        sideEffectState: "not_started",
      },
    });
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "stale-resume-second-pause",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_paused",
        checkpointArtifactId: "stale-resume-current-checkpoint",
        evidenceIds: ["stale-resume-current-evidence"],
        reason: "最新の checkpoint",
      },
      artifacts: [
        {
          id: "stale-resume-current-checkpoint",
          schemaId: "run.checkpoint",
          schemaVersion: "1",
          derivedFromArtifactIds: ["stale-resume-first-checkpoint"],
          reference: reference("stale-resume-current-checkpoint"),
        },
      ],
      evidence: [
        {
          id: "stale-resume-current-evidence",
          kind: "checkpoint",
          artifactIds: ["stale-resume-current-checkpoint"],
          provenance: "external-runner",
          reference: reference("stale-resume-current-evidence"),
        },
      ],
    });
    const beforeRejectedResume = await control.inspect(runId);

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "stale-resume-old-checkpoint",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_resumed",
          checkpointArtifactId: "stale-resume-first-checkpoint",
          evidenceIds: ["stale-resume-first-evidence"],
          sideEffectState: "not_started",
        },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "stale_attempt",
      stateUnchanged: true,
      view: {
        revision: beforeRejectedResume.revision,
        state: "paused",
        activeAttempt: { id: "stale-resume-attempt", state: "running" },
      },
    });
    await expect(control.inspect(runId)).resolves.toEqual(beforeRejectedResume);

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "stale-resume-current-checkpoint",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_resumed",
          checkpointArtifactId: "stale-resume-current-checkpoint",
          evidenceIds: ["stale-resume-current-evidence"],
          sideEffectState: "not_started",
        },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      view: {
        revision: beforeRejectedResume.revision + 1,
        state: "running",
        activeAttempt: { id: "stale-resume-attempt", state: "running" },
      },
    });
  });
});

describe("[NFR-STABILITY-014-AC7] human/PR gate は authority と live evidence を要求する", () => {
  it("独立 review 後に human approval と対象 PR の live evidence だけで完了する", async () => {
    const { control } = await createControlPlane();
    const runId = await startRun(control, "start-pr-gate");
    await completeCurrentNode({
      control,
      runId,
      role: "planner",
      outcome: "plan_valid",
      schemaId: "dev-role.plan",
      prefix: "pr-plan",
    });
    await completeCurrentNode({
      control,
      runId,
      role: "implementer",
      outcome: "implementation_valid",
      schemaId: "dev-role.implementation",
      prefix: "pr-implementation",
    });
    await completeCurrentNode({
      control,
      runId,
      role: "executor",
      outcome: "verify_passed",
      schemaId: "dev-role.verify",
      prefix: "pr-verification",
    });
    expect((await control.inspect(runId)).currentNode?.inputArtifactIds).toEqual([
      "pr-plan-artifact",
      "pr-implementation-artifact",
      "pr-verification-artifact",
    ]);
    await completeCurrentNode({
      control,
      runId,
      role: "reviewer",
      outcome: "approve",
      schemaId: "dev-role.review",
      prefix: "pr-review",
    });
    expect(await control.inspect(runId)).toMatchObject({
      state: "waiting_human",
      waitReason: "human_approval_required",
    });

    const approved = await control.applyEvent({
      schemaVersion: "1",
      eventId: "pr-human-approved",
      runId,
      actor: { id: "maintainer-1", role: "human" },
      command: {
        type: "human_decision",
        decision: "approved",
        reason: null,
        evidenceIds: ["pr-human-evidence"],
      },
      evidence: [
        {
          id: "pr-human-evidence",
          kind: "human_decision",
          artifactIds: [],
          provenance: "maintainer-1",
          reference: reference("pr-human-evidence"),
        },
      ],
    });
    expect(approved).toMatchObject({
      accepted: true,
      view: {
        state: "running",
        currentNode: { contractNodeId: "human-pr", state: "running" },
        activeAttempt: null,
        allowedNextTransitions: ["pr_observed"],
      },
    });

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "pr-wrong-repository",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "pr_observed",
          repository: "someone/another-repo",
          pullRequestNumber: 400,
          state: "merged",
          isDraft: false,
          linkedIssue: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
          linkageComplete: true,
          evidenceIds: ["pr-wrong-evidence"],
        },
        evidence: [
          {
            id: "pr-wrong-evidence",
            kind: "github_pr_live",
            artifactIds: [],
            provenance: "github-graphql",
            reference: reference("pr-wrong-evidence"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "pr_not_linked_to_task",
      stateUnchanged: true,
    });

    const beforeLinkageRejections = await control.inspect(runId);
    for (const [eventId, linkedIssue, linkageComplete, expectedCode] of [
      ["pr-definitive-unlinked", null, true, "pr_not_linked_to_task"],
      ["pr-linkage-unavailable", null, false, "github_live_state_unavailable"],
      [
        "pr-linked-to-another-issue",
        { owner: "stanah", repo: "gh-gantt", issueNumber: 999 },
        true,
        "pr_not_linked_to_task",
      ],
    ] as const) {
      await expect(
        control.applyEvent({
          schemaVersion: "1",
          eventId,
          runId,
          actor: { id: "orchestrator-1", role: "orchestrator" },
          command: {
            type: "pr_observed",
            repository: "stanah/gh-gantt",
            pullRequestNumber: 400,
            state: "merged",
            isDraft: false,
            linkedIssue,
            linkageComplete,
            evidenceIds: [`${eventId}-evidence`],
          },
          evidence: [
            {
              id: `${eventId}-evidence`,
              kind: "github_pr_live",
              artifactIds: [],
              provenance: "github-graphql",
              reference: reference(`${eventId}-evidence`),
            },
          ],
        }),
      ).resolves.toMatchObject({
        accepted: false,
        code: expectedCode,
        stateUnchanged: true,
        view: { revision: beforeLinkageRejections.revision, state: "running" },
      });
      await expect(control.inspect(runId)).resolves.toEqual(beforeLinkageRejections);
    }

    const draft = await control.applyEvent({
      schemaVersion: "1",
      eventId: "pr-linked-draft",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "pr_observed",
        repository: "STANAH/GH-GANTT",
        pullRequestNumber: 400,
        state: "open",
        isDraft: true,
        linkedIssue: { owner: "STANAH", repo: "GH-GANTT", issueNumber: 328 },
        linkageComplete: false,
        evidenceIds: ["pr-draft-evidence"],
      },
      evidence: [
        {
          id: "pr-draft-evidence",
          kind: "github_pr_live",
          artifactIds: [],
          provenance: "github-graphql",
          reference: reference("pr-draft-evidence"),
        },
      ],
    });
    expect(draft).toMatchObject({
      accepted: true,
      view: { state: "running", currentNode: { state: "running" } },
    });

    const merged = await control.applyEvent({
      schemaVersion: "1",
      eventId: "pr-merged",
      runId,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "pr_observed",
        repository: "STANAH/GH-GANTT",
        pullRequestNumber: 400,
        state: "merged",
        isDraft: false,
        linkedIssue: { owner: "STANAH", repo: "GH-GANTT", issueNumber: 328 },
        linkageComplete: true,
        evidenceIds: ["pr-live-evidence"],
      },
      evidence: [
        {
          id: "pr-live-evidence",
          kind: "github_pr_live",
          artifactIds: [],
          provenance: "github-graphql",
          reference: reference("pr-live-evidence"),
        },
      ],
    });
    expect(merged).toMatchObject({
      accepted: true,
      view: { state: "completed", currentNode: { state: "completed" } },
    });
  });
});

describe("[NFR-STABILITY-014-AC7] 旧 PR observation は未証明 linkage として replay する", () => {
  it("旧 merged event を読んでも Run を completed へ昇格せず、別 Run も start できる", async () => {
    const { root, control } = await createControlPlane();
    const runId = await startRun(control, "legacy-run-start");
    await advanceToHumanPr(control, runId);
    const beforeLegacyEvent = await control.inspect(runId);
    expect(beforeLegacyEvent).toMatchObject({
      state: "running",
      currentNode: { contractNodeId: "human-pr", state: "running" },
    });
    await writeLegacyPrObservedEvent({
      root,
      runId,
      sequence: beforeLegacyEvent.revision + 1,
    });

    await expect(control.inspect(runId)).resolves.toMatchObject({
      revision: beforeLegacyEvent.revision + 1,
      state: "running",
      currentNode: { contractNodeId: "human-pr", state: "running" },
    });
    await expect(
      control.start({
        schemaVersion: "1",
        eventId: "fresh-run-after-legacy-journal",
        actor: { id: "orchestrator-1", role: "orchestrator" },
        task: { owner: "stanah", repo: "gh-gantt", issueNumber: 329 },
        contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      }),
    ).resolves.toMatchObject({ accepted: true, view: { state: "running", revision: 1 } });
  });

  it("旧 rejected observation を含む journal を読めて、別 Run も start できる", async () => {
    const { root, control } = await createControlPlane();
    const runId = await startRun(control, "legacy-rejection-run-start");
    await writeLegacyPrObservedRejection({ root, runId });

    await expect(new RunGraphEventStore(root).readJournal(runId)).resolves.toMatchObject({
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
    await expect(
      control.start({
        schemaVersion: "1",
        eventId: "fresh-run-after-legacy-rejection",
        actor: { id: "orchestrator-1", role: "orchestrator" },
        task: { owner: "stanah", repo: "gh-gantt", issueNumber: 329 },
        contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      }),
    ).resolves.toMatchObject({ accepted: true, view: { state: "running", revision: 1 } });
  });
});

describe("[NFR-STABILITY-014-AC9] claim lifecycle audit と completion fencing", () => {
  it("claim audit は fixed dev-role topology を変えず、reclaim 後の旧 completion を拒否する", async () => {
    let now = "2026-08-02T00:00:00.000Z";
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-claimed-control-"));
    await execFileAsync("git", ["init", root], { env: gitFixtureEnvironment() });
    await mkdir(join(root, GANTT_DIR), { recursive: true });
    await writeFile(
      join(root, GANTT_DIR, "gantt.config.json"),
      `${JSON.stringify(
        {
          version: "1",
          project: {
            name: "fixture",
            github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
          },
          sync: {
            auto_create_issues: false,
            field_mapping: { start_date: "Start", end_date: "End" },
          },
          task_types: {
            task: { label: "Task", display: "bar", color: "#000", github_label: null },
          },
          type_hierarchy: { task: [] },
          statuses: { field_name: "Status", values: { Todo: { color: "#000", done: false } } },
          gantt: {
            default_view: "month",
            working_days: [1, 2, 3, 4, 5],
            colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" },
          },
          dispatch: { max_concurrency: 1 },
        },
        null,
        2,
      )}\n`,
    );
    await new GraphContractStore(root).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
    const claims = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => now,
        nextId: () => "claim-329",
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
      }),
    );
    const control = new RunGraphControlPlane(root, deterministicDependencies(), claims);
    const runId = await startRun(control, "claimed-run-start");
    const started = await control.inspect(runId);
    const nodeId = started.currentNode?.id;
    if (!nodeId) throw new Error("current node が必要です");
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "claimed-attempt-start",
      runId,
      actor: { id: "planner-claimed", role: "planner" },
      command: { type: "attempt_started", nodeId, attemptId: "attempt-claimed" },
    });

    const claimed = await claims.claim({
      schemaVersion: "1",
      eventId: "registry-claim",
      expectedEntityVersion: 0,
      taskId: "stanah/gh-gantt#328",
      repository: "stanah/gh-gantt",
      state: "Todo",
      ownerId: "planner-claimed",
      workspaceId: "workspace:claimed",
      runId,
      leaseDurationSeconds: 60,
      dispatchPlanId: "dispatch-plan:test",
      dispatchPlanVersion: "1",
      snapshotFingerprint: "d".repeat(64),
    });
    if (!claimed.accepted) throw new Error(claimed.message);
    const audit = await control.recordClaimAudit({
      schemaVersion: "1",
      eventId: `audit:${claimed.eventId}`,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      receipt: claimed,
    });
    expect(audit).toMatchObject({
      accepted: true,
      view: {
        revision: 3,
        currentNode: { id: nodeId, state: "running", activeAttemptId: "attempt-claimed" },
        nodes: { total: 1 },
        claimAudits: {
          total: 1,
          items: [
            {
              command: {
                type: "claim_acquired",
                claim: {
                  taskId: "stanah/gh-gantt#328",
                  ownerId: "planner-claimed",
                  runId,
                  fencingToken: 1,
                },
              },
            },
          ],
        },
      },
    });
    await expect(
      control.recordClaimAudit({
        schemaVersion: "1",
        eventId: `audit:${claimed.eventId}`,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        receipt: claimed,
      }),
    ).resolves.toEqual(audit);
    await expect(
      control.recordClaimAudit({
        schemaVersion: "1",
        eventId: `audit:${claimed.eventId}:alternate`,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        receipt: claimed,
      }),
    ).resolves.toMatchObject({ accepted: false, code: "duplicate_event", stateUnchanged: true });
    await expect(
      control.recordClaimAudit({
        schemaVersion: "1",
        eventId: "audit:forged-registry-receipt",
        actor: { id: "orchestrator-1", role: "orchestrator" },
        receipt: { ...claimed, eventId: "forged-registry-receipt" },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });

    const beforeBypass = await control.inspect(runId);
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "raw-completion-bypass",
        runId,
        actor: { id: "planner-claimed", role: "planner" },
        command: {
          type: "attempt_finished",
          nodeId,
          attemptId: "attempt-claimed",
          outcome: "succeeded",
          artifactIds: [],
          evidenceIds: ["cross-run-command-evidence"],
        },
        evidence: [
          {
            id: "cross-run-command-evidence",
            kind: "command_execution",
            artifactIds: [],
            provenance: "cross-runner",
            reference: reference("cross-run-command"),
          },
        ],
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "stale_claim",
      stateUnchanged: true,
      view: { revision: beforeBypass.revision, activeAttempt: { state: "running" } },
    });

    const otherRunId = await startRun(control, "other-run-start");
    const otherView = await control.inspect(otherRunId);
    const otherNodeId = otherView.currentNode?.id;
    if (!otherNodeId) throw new Error("other current node が必要です");
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "other-attempt-start",
      runId: otherRunId,
      actor: { id: "planner-claimed", role: "planner" },
      command: { type: "attempt_started", nodeId: otherNodeId, attemptId: "other-attempt" },
    });
    await expect(
      control.applyClaimedEvent(
        {
          schemaVersion: "1",
          eventId: "cross-run-completion",
          runId: otherRunId,
          actor: { id: "planner-claimed", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId: otherNodeId,
            attemptId: "other-attempt",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: ["stale-command-evidence"],
          },
          evidence: [
            {
              id: "stale-command-evidence",
              kind: "command_execution",
              artifactIds: [],
              provenance: "stale-runner",
              reference: reference("stale-command"),
            },
          ],
        },
        {
          claimId: claimed.claim.claimId,
          fencingToken: claimed.claim.fencingToken,
          ownerId: claimed.claim.ownerId,
          runId,
        },
        1,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });

    now = "2026-08-02T00:02:00.000Z";
    const reclaimed = await claims.reclaim({
      schemaVersion: "1",
      eventId: "registry-reclaim",
      expectedEntityVersion: 1,
      claimId: claimed.claim.claimId,
      reason: "expired",
    });
    if (!reclaimed.accepted || !reclaimed.claim) throw new Error("reclaim receipt が必要です");
    const reclaimAudit = await control.recordClaimAudit({
      schemaVersion: "1",
      eventId: `audit:${reclaimed.eventId}`,
      actor: { id: "orchestrator-1", role: "orchestrator" },
      receipt: { ...reclaimed, claim: reclaimed.claim },
    });
    expect(reclaimAudit).toMatchObject({
      accepted: true,
      view: {
        claimAudits: {
          total: 2,
          items: [
            {},
            {
              command: {
                type: "claim_reclaimed",
                reclaimReason: "expired",
                claim: { ownerId: "planner-claimed", runId, taskId: "stanah/gh-gantt#328" },
              },
            },
          ],
        },
      },
    });
    const beforeStale = await control.inspect(runId);
    await expect(
      control.applyClaimedEvent(
        {
          schemaVersion: "1",
          eventId: "stale-completion",
          runId,
          actor: { id: "planner-claimed", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId,
            attemptId: "attempt-claimed",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: ["stale-completion-command"],
          },
          evidence: [
            {
              id: "stale-completion-command",
              kind: "command_execution",
              artifactIds: [],
              provenance: "stale-completion-runner",
              reference: reference("stale-completion-command"),
            },
          ],
        },
        {
          claimId: claimed.claim.claimId,
          fencingToken: claimed.claim.fencingToken,
          ownerId: claimed.claim.ownerId,
          runId,
        },
        2,
      ),
    ).resolves.toMatchObject({
      accepted: false,
      code: "stale_claim",
      stateUnchanged: true,
      view: { revision: beforeStale.revision, activeAttempt: { state: "running" } },
    });
  });

  it("同じ claim で複数 event を認可し、更新 proof で heartbeat と release を継続する", async () => {
    const { claims, control, runId, nodeId, claimed } = await createClaimedControlPlane();
    const first = await control.applyClaimedEvent(
      {
        schemaVersion: "1",
        eventId: "claimed-planner-finish",
        runId,
        actor: { id: "task-runner", role: "planner" },
        command: {
          type: "attempt_finished",
          nodeId,
          attemptId: "planner-attempt",
          outcome: "succeeded",
          artifactIds: [],
          evidenceIds: ["claimed-planner-command"],
        },
        evidence: [commandEvidence("claimed-planner-command")],
      },
      {
        claimId: claimed.claim.claimId,
        fencingToken: claimed.claim.fencingToken,
        ownerId: claimed.claim.ownerId,
        runId,
      },
      claimed.entityVersion,
    );
    expect(first).toMatchObject({
      accepted: true,
      claimAuthorization: {
        receipt: { entityVersion: 2, claim: { entityVersion: 2, fencingToken: 2 } },
        proof: { fencingToken: 2 },
        audit: { recorded: true },
      },
    });
    if (!first.accepted || !first.claimAuthorization) throw new Error("更新 proof が必要です");

    const outcome = await control.applyClaimedEvent(
      {
        schemaVersion: "1",
        eventId: "claimed-planner-outcome",
        runId,
        actor: { id: "task-runner", role: "planner" },
        command: {
          type: "node_outcome_submitted",
          nodeId,
          attemptId: "planner-attempt",
          outcome: "plan_valid",
          artifactIds: ["claimed-plan"],
          evidenceIds: ["claimed-plan-validation"],
        },
        artifacts: [
          {
            id: "claimed-plan",
            schemaId: "dev-role.plan",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("claimed-plan"),
          },
        ],
        evidence: [
          {
            id: "claimed-plan-validation",
            kind: "artifact_validation",
            artifactIds: ["claimed-plan"],
            provenance: "task-runner",
            reference: reference("claimed-plan-validation"),
          },
        ],
      },
      first.claimAuthorization.proof,
      first.claimAuthorization.receipt.entityVersion,
    );
    expect(outcome).toMatchObject({
      accepted: true,
      view: { currentNode: { contractNodeId: "implementer" } },
      claimAuthorization: { proof: { fencingToken: 3 } },
    });
    if (!outcome.accepted || !outcome.claimAuthorization)
      throw new Error("outcome 更新 proof が必要です");
    const implementerNodeId = outcome.view.currentNode?.id;
    if (!implementerNodeId) throw new Error("implementer node が必要です");
    await control.applyEvent({
      schemaVersion: "1",
      eventId: "claimed-implementer-start",
      runId,
      actor: { id: "task-runner", role: "implementer" },
      command: {
        type: "attempt_started",
        nodeId: implementerNodeId,
        attemptId: "implementer-attempt",
      },
    });
    const implementerFinished = await control.applyClaimedEvent(
      {
        schemaVersion: "1",
        eventId: "claimed-implementer-finish",
        runId,
        actor: { id: "task-runner", role: "implementer" },
        command: {
          type: "attempt_finished",
          nodeId: implementerNodeId,
          attemptId: "implementer-attempt",
          outcome: "succeeded",
          artifactIds: [],
          evidenceIds: ["claimed-implementer-command"],
        },
        evidence: [commandEvidence("claimed-implementer-command")],
      },
      outcome.claimAuthorization.proof,
      outcome.claimAuthorization.receipt.entityVersion,
    );
    expect(implementerFinished).toMatchObject({
      accepted: true,
      claimAuthorization: { proof: { fencingToken: 4 } },
    });
    if (!implementerFinished.accepted || !implementerFinished.claimAuthorization)
      throw new Error("implementer 更新 proof が必要です");

    const heartbeat = await claims.heartbeat({
      schemaVersion: "1",
      eventId: "claimed-after-events-heartbeat",
      expectedEntityVersion: implementerFinished.claimAuthorization.receipt.entityVersion,
      proof: implementerFinished.claimAuthorization.proof,
      leaseDurationSeconds: 300,
    });
    expect(heartbeat).toMatchObject({
      accepted: true,
      entityVersion: 5,
      claim: { fencingToken: 5 },
    });
    if (!heartbeat.accepted || !heartbeat.claim) throw new Error("heartbeat claim が必要です");
    const released = await claims.release({
      schemaVersion: "1",
      eventId: "claimed-after-events-release",
      expectedEntityVersion: heartbeat.entityVersion,
      proof: {
        claimId: heartbeat.claim.claimId,
        fencingToken: heartbeat.claim.fencingToken,
        ownerId: heartbeat.claim.ownerId,
        runId: heartbeat.claim.runId,
      },
    });
    expect(released).toMatchObject({ accepted: true, entityVersion: 6 });
    await expect(claims.snapshot()).resolves.toMatchObject({ entityVersion: 6, claims: [] });
  });

  it("domain reject は registry/journal を変更せず、同じ proof の修正 retry を受理する", async () => {
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane();
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const initialRegistry = await claims.snapshot();
    const initialJournal = await new RunGraphEventStore(root).readJournal(runId);
    await expect(
      control.applyClaimedEvent(
        {
          schemaVersion: "1",
          eventId: "claimed-missing-evidence",
          runId,
          actor: { id: "task-runner", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId,
            attemptId: "planner-attempt",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: [],
          },
        },
        proof,
        claimed.entityVersion,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "evidence_required" });
    await expect(claims.snapshot()).resolves.toEqual(initialRegistry);
    await expect(new RunGraphEventStore(root).readJournal(runId)).resolves.toEqual(initialJournal);

    await expect(
      control.applyClaimedEvent(
        {
          schemaVersion: "1",
          eventId: "claimed-stale-attempt",
          runId,
          actor: { id: "task-runner", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId,
            attemptId: "other-attempt",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: ["claimed-stale-command"],
          },
          evidence: [commandEvidence("claimed-stale-command")],
        },
        proof,
        claimed.entityVersion,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "stale_attempt" });
    await expect(claims.snapshot()).resolves.toEqual(initialRegistry);
    await expect(new RunGraphEventStore(root).readJournal(runId)).resolves.toEqual(initialJournal);

    const correctedFinish = await control.applyClaimedEvent(
      {
        schemaVersion: "1",
        eventId: "claimed-corrected-finish",
        runId,
        actor: { id: "task-runner", role: "planner" },
        command: {
          type: "attempt_finished",
          nodeId,
          attemptId: "planner-attempt",
          outcome: "succeeded",
          artifactIds: [],
          evidenceIds: ["claimed-corrected-command"],
        },
        evidence: [commandEvidence("claimed-corrected-command")],
      },
      proof,
      claimed.entityVersion,
    );
    if (!correctedFinish.accepted || !correctedFinish.claimAuthorization)
      throw new Error("修正後 completion が必要です");
    const afterFinishRegistry = await claims.snapshot();

    const outcomeBase = {
      schemaVersion: "1" as const,
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "node_outcome_submitted" as const,
        nodeId,
        attemptId: "planner-attempt",
        artifactIds: ["claimed-retry-plan"],
        evidenceIds: ["claimed-retry-validation"],
      },
      artifacts: [
        {
          id: "claimed-retry-plan",
          schemaId: "dev-role.plan",
          schemaVersion: "1" as const,
          derivedFromArtifactIds: [],
          reference: reference("claimed-retry-plan"),
        },
      ],
      evidence: [
        {
          id: "claimed-retry-validation",
          kind: "artifact_validation" as const,
          artifactIds: ["claimed-retry-plan"],
          provenance: "task-runner",
          reference: reference("claimed-retry-validation"),
        },
      ],
    };
    await expect(
      control.applyClaimedEvent(
        {
          ...outcomeBase,
          eventId: "claimed-invalid-outcome",
          command: { ...outcomeBase.command, outcome: "not-a-contract-edge" },
        },
        correctedFinish.claimAuthorization.proof,
        correctedFinish.claimAuthorization.receipt.entityVersion,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "invalid_transition" });
    await expect(claims.snapshot()).resolves.toEqual(afterFinishRegistry);

    await expect(
      control.applyClaimedEvent(
        {
          ...outcomeBase,
          eventId: "claimed-corrected-outcome",
          command: { ...outcomeBase.command, outcome: "plan_valid" },
        },
        correctedFinish.claimAuthorization.proof,
        correctedFinish.claimAuthorization.receipt.entityVersion,
      ),
    ).resolves.toMatchObject({
      accepted: true,
      claimAuthorization: { proof: { fencingToken: 3 } },
    });
  });

  it("append 競合は pending を解除し、同じ proof で修正 event を継続できる", async () => {
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane();
    const originalAppend = RunGraphEventStore.prototype.appendAccepted;
    let injected = false;
    const appendSpy = vi
      .spyOn(RunGraphEventStore.prototype, "appendAccepted")
      .mockImplementation(async (event) => {
        if (event.eventId === "claimed-conflicted-finish" && !injected) {
          injected = true;
          await originalAppend.call(new RunGraphEventStore(root), {
            ...event,
            eventId: "competing-finish",
          });
        }
        return originalAppend.call(new RunGraphEventStore(root), event);
      });
    try {
      const conflict = await control.applyClaimedEvent(
        {
          schemaVersion: "1",
          eventId: "claimed-conflicted-finish",
          runId,
          actor: { id: "task-runner", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId,
            attemptId: "planner-attempt",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: ["claimed-conflict-command"],
          },
          evidence: [commandEvidence("claimed-conflict-command")],
        },
        {
          claimId: claimed.claim.claimId,
          fencingToken: claimed.claim.fencingToken,
          ownerId: claimed.claim.ownerId,
          runId,
        },
        claimed.entityVersion,
      );
      expect(conflict).toMatchObject({
        accepted: false,
        code: "stale_attempt",
        view: { activeAttempt: { state: "succeeded" } },
      });
      await expect(claims.snapshot()).resolves.toMatchObject({
        entityVersion: 1,
        claims: [{ claimId: claimed.claim.claimId, fencingToken: 1 }],
        pendingAuthorizations: [],
      });

      await expect(
        control.applyClaimedEvent(
          {
            schemaVersion: "1",
            eventId: "claimed-after-conflict-outcome",
            runId,
            actor: { id: "task-runner", role: "planner" },
            command: {
              type: "node_outcome_submitted",
              nodeId,
              attemptId: "planner-attempt",
              outcome: "plan_valid",
              artifactIds: ["claimed-after-conflict-plan"],
              evidenceIds: ["claimed-after-conflict-validation"],
            },
            artifacts: [
              {
                id: "claimed-after-conflict-plan",
                schemaId: "dev-role.plan",
                schemaVersion: "1",
                derivedFromArtifactIds: [],
                reference: reference("claimed-after-conflict-plan"),
              },
            ],
            evidence: [
              {
                id: "claimed-after-conflict-validation",
                kind: "artifact_validation",
                artifactIds: ["claimed-after-conflict-plan"],
                provenance: "task-runner",
                reference: reference("claimed-after-conflict-validation"),
              },
            ],
          },
          {
            claimId: claimed.claim.claimId,
            fencingToken: claimed.claim.fencingToken,
            ownerId: claimed.claim.ownerId,
            runId,
          },
          claimed.entityVersion,
        ),
      ).resolves.toMatchObject({
        accepted: true,
        view: { currentNode: { contractNodeId: "implementer" } },
        claimAuthorization: { proof: { fencingToken: 2 } },
      });
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("dispatch config 有効時は claim 取得との race でも raw completion を fail-closed にする", async () => {
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane();
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const released = await claims.release({
      schemaVersion: "1",
      eventId: "raw-race-release",
      expectedEntityVersion: claimed.entityVersion,
      proof,
    });
    if (!released.accepted) throw new Error(released.message);

    const rawInput = {
      schemaVersion: "1" as const,
      eventId: "raw-race-completion",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["raw-race-evidence"],
      },
      evidence: [commandEvidence("raw-race-evidence")],
    };
    const [raw, reacquired] = await Promise.all([
      control.applyEvent(rawInput),
      claims.claim({
        schemaVersion: "1",
        eventId: "raw-race-reclaim-owner",
        expectedEntityVersion: released.entityVersion,
        taskId: claimed.claim.taskId,
        repository: claimed.claim.repository,
        state: claimed.claim.state,
        ownerId: claimed.claim.ownerId,
        workspaceId: "workspace:raw-race",
        runId,
        leaseDurationSeconds: 300,
        dispatchPlanId: "dispatch-plan:raw-race",
        dispatchPlanVersion: "1",
        snapshotFingerprint: "d".repeat(64),
      }),
    ]);
    expect(raw).toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });
    expect(reacquired).toMatchObject({ accepted: true });
    const journal = await new RunGraphEventStore(root).readJournal(runId);
    expect(journal.acceptedEvents.some((event) => event.eventId === rawInput.eventId)).toBe(false);
  });

  it("同一 control plane の concurrent completion は event/binding を混線させない", async () => {
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane();
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = (suffix: string) => ({
      schemaVersion: "1" as const,
      eventId: `concurrent-${suffix}`,
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: [`concurrent-evidence-${suffix}`],
      },
      evidence: [commandEvidence(`concurrent-evidence-${suffix}`)],
    });
    const results = await Promise.all([
      control.applyClaimedEvent(completion("a"), proof, claimed.entityVersion),
      control.applyClaimedEvent(completion("b"), proof, claimed.entityVersion),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toMatchObject([
      { code: "stale_claim", stateUnchanged: true },
    ]);
    const acceptedInput = results[0]!.accepted ? completion("a") : completion("b");
    const journal = await new RunGraphEventStore(root).readJournal(runId);
    const completionEvents = journal.acceptedEvents.filter(
      (event) => event.command.type === "attempt_finished",
    );
    expect(completionEvents).toHaveLength(1);
    expect(completionEvents[0]).toMatchObject({
      eventId: acceptedInput.eventId,
      command: acceptedInput.command,
      dispatchAuthorization: {
        claimId: proof.claimId,
        fencingToken: proof.fencingToken,
        ownerId: proof.ownerId,
        runId,
      },
    });
    await expect(claims.snapshot()).resolves.toMatchObject({ entityVersion: 2, claims: [{}] });
  });

  it("key 順を変えた claimed completion の exact retry を canonical binding に収束させる", async () => {
    const { root, control, runId, nodeId, claimed } = await createClaimedControlPlane();
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "canonical-key-order-completion",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["canonical-key-order-evidence"],
      },
      evidence: [commandEvidence("canonical-key-order-evidence")],
    } satisfies RunGraphRunnerCommandInput;
    const evidence = completion.evidence[0]!;
    const reordered = {
      evidence: [
        {
          reference: {
            byteLength: evidence.reference.byteLength,
            sha256: evidence.reference.sha256,
            uri: evidence.reference.uri,
            kind: evidence.reference.kind,
          },
          provenance: evidence.provenance,
          artifactIds: evidence.artifactIds,
          kind: evidence.kind,
          id: evidence.id,
        },
      ],
      command: {
        evidenceIds: completion.command.evidenceIds,
        artifactIds: completion.command.artifactIds,
        outcome: completion.command.outcome,
        attemptId: completion.command.attemptId,
        nodeId: completion.command.nodeId,
        type: completion.command.type,
      },
      actor: { role: completion.actor.role, id: completion.actor.id },
      runId: completion.runId,
      eventId: completion.eventId,
      schemaVersion: completion.schemaVersion,
    } satisfies RunGraphRunnerCommandInput;
    const expectedFingerprint = createHash("sha256")
      .update(canonicalJsonStringify(completion))
      .digest("hex");

    await expect(
      control.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      control.applyClaimedEvent(reordered, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: true });

    const journal = await new RunGraphEventStore(root).readJournal(runId);
    const accepted = journal.acceptedEvents.filter((event) => event.eventId === completion.eventId);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.dispatchAuthorization?.commandFingerprint).toBe(expectedFingerprint);
  });

  it("receipt publish 後に reclaim された exact retry は旧 claim 継続 proof を返さない", async () => {
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane();
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "published-before-reclaim",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["published-before-reclaim-evidence"],
      },
      evidence: [commandEvidence("published-before-reclaim-evidence")],
    };
    const committed = await control.applyClaimedEvent(completion, proof, claimed.entityVersion);
    if (!committed.accepted || !committed.claimAuthorization)
      throw new Error("publish 済み authorization が必要です");
    const reclaimed = await claims.reclaim({
      schemaVersion: "1",
      eventId: "reclaim-after-published-receipt",
      expectedEntityVersion: committed.claimAuthorization.receipt.entityVersion,
      claimId: claimed.claim.claimId,
      reason: "owner_stopped",
      ownerStoppedEvidenceId: "process-exit:published-owner",
    });
    expect(reclaimed).toMatchObject({ accepted: true, entityVersion: 3 });

    const retry = await control.applyClaimedEvent(completion, proof, claimed.entityVersion);
    expect(retry).toMatchObject({
      accepted: true,
      view: { activeAttempt: { state: "succeeded" } },
    });
    expect(retry).not.toHaveProperty("claimAuthorization");
    await expect(
      control.applyClaimedEvent(
        { ...completion, eventId: "new-event-after-published-reclaim" },
        committed.claimAuthorization.proof,
        reclaimed.entityVersion,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });

    const journal = await new RunGraphEventStore(root).readJournal(runId);
    expect(
      journal.acceptedEvents.filter((event) => event.eventId === completion.eventId),
    ).toHaveLength(1);
    expect(
      journal.acceptedEvents.some((event) => event.eventId === "new-event-after-published-reclaim"),
    ).toBe(false);
  });

  it("pending 永続化後・append 前 crash は heartbeat を止め、同一 event retry だけを許可する", async () => {
    let crashBeforeAppend = false;
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane({
      afterAuthorizationPendingPublish: async () => {
        if (crashBeforeAppend) throw new Error("authorization interrupted before append");
      },
    });
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "crash-before-append",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["crash-before-append-evidence"],
      },
      evidence: [commandEvidence("crash-before-append-evidence")],
    };

    crashBeforeAppend = true;
    await expect(control.applyClaimedEvent(completion, proof, 1)).resolves.toMatchObject({
      accepted: false,
      code: "stale_attempt",
      stateUnchanged: true,
    });
    crashBeforeAppend = false;
    const afterCrash = await new RunGraphEventStore(root).readJournal(runId);
    expect(afterCrash.acceptedEvents.some((event) => event.eventId === completion.eventId)).toBe(
      false,
    );
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      pendingAuthorizations: [{ eventId: completion.eventId, claimId: proof.claimId }],
    });
    await expect(
      claims.heartbeat({
        schemaVersion: "1",
        eventId: "heartbeat-before-exact-retry",
        expectedEntityVersion: 1,
        proof,
        leaseDurationSeconds: 300,
      }),
    ).resolves.toMatchObject({ accepted: false, code: "authorization_pending" });

    await expect(control.applyClaimedEvent(completion, proof, 1)).resolves.toMatchObject({
      accepted: true,
      claimAuthorization: { proof: { fencingToken: 2 } },
      view: { activeAttempt: { state: "succeeded" } },
    });
    const afterRetry = await new RunGraphEventStore(root).readJournal(runId);
    expect(
      afterRetry.acceptedEvents.filter((event) => event.eventId === completion.eventId),
    ).toHaveLength(1);
  });

  it("pending exact retry が state 遷移で拒否された場合は pending を解除して修正を許可する", async () => {
    let crashBeforeAppend = true;
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane({
      afterAuthorizationPendingPublish: async () => {
        if (crashBeforeAppend) throw new Error("authorization interrupted before append");
      },
    });
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "pending-invalidated-completion",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["pending-invalidated-evidence"],
      },
      evidence: [commandEvidence("pending-invalidated-evidence")],
    };

    await expect(
      control.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: false, code: "stale_attempt" });
    crashBeforeAppend = false;
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      pendingAuthorizations: [{ eventId: completion.eventId, claimId: proof.claimId }],
    });

    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "pending-invalidated-pause",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_paused",
          checkpointArtifactId: "pending-invalidated-checkpoint",
          evidenceIds: ["pending-invalidated-checkpoint-evidence"],
          reason: "pending 中に accepted state を変更する",
        },
        artifacts: [
          {
            id: "pending-invalidated-checkpoint",
            schemaId: "run.checkpoint",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("pending-invalidated-checkpoint"),
          },
        ],
        evidence: [
          {
            id: "pending-invalidated-checkpoint-evidence",
            kind: "checkpoint",
            artifactIds: ["pending-invalidated-checkpoint"],
            provenance: "orchestrator-1",
            reference: reference("pending-invalidated-checkpoint-evidence"),
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: true, view: { state: "paused" } });

    await expect(
      control.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: false, code: "invalid_transition" });
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      claims: [{ claimId: proof.claimId, fencingToken: 1 }],
      pendingAuthorizations: [],
    });

    const heartbeat = await claims.heartbeat({
      schemaVersion: "1",
      eventId: "pending-invalidated-heartbeat",
      expectedEntityVersion: 1,
      proof,
      leaseDurationSeconds: 300,
    });
    if (!heartbeat.accepted) throw new Error(heartbeat.message);
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: "pending-invalidated-resume",
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_resumed",
          checkpointArtifactId: "pending-invalidated-checkpoint",
          evidenceIds: ["pending-invalidated-checkpoint-evidence"],
          sideEffectState: "not_started",
        },
      }),
    ).resolves.toMatchObject({ accepted: true, view: { state: "running" } });
    await expect(
      control.applyClaimedEvent(
        { ...completion, eventId: "pending-invalidated-corrected-completion" },
        {
          claimId: heartbeat.claim.claimId,
          fencingToken: heartbeat.claim.fencingToken,
          ownerId: heartbeat.claim.ownerId,
          runId: heartbeat.claim.runId,
        },
        heartbeat.entityVersion,
      ),
    ).resolves.toMatchObject({
      accepted: true,
      claimAuthorization: { proof: { fencingToken: 3 } },
    });
    const journal = await new RunGraphEventStore(root).readJournal(runId);
    expect(journal.acceptedEvents.some((event) => event.eventId === completion.eventId)).toBe(
      false,
    );
  });

  it("B が journal absent 観測後に A append crash と reclaim を挟んでも historical receipt へ収束する", async () => {
    let crashBeforeFinalize = true;
    const {
      root,
      claims,
      control: controlA,
      runId,
      nodeId,
      claimed,
    } = await createClaimedControlPlane({
      beforeAuthorizationFinalizePublish: async () => {
        if (crashBeforeFinalize) throw new Error("authorization finalize interrupted");
      },
    });
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "concurrent-absent-before-append",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["concurrent-absent-evidence"],
      },
      evidence: [commandEvidence("concurrent-absent-evidence")],
    };
    let resumeB!: () => void;
    const waitForA = new Promise<void>((resolveBarrier) => {
      resumeB = resolveBarrier;
    });
    let bObservedAbsent!: () => void;
    const bObservedAbsentBarrier = new Promise<void>((resolveObserved) => {
      bObservedAbsent = resolveObserved;
    });
    const authorityB = withClaimAuthorityOverrides(claims, {
      assertCurrentClaim: async (...args) => {
        bObservedAbsent();
        await waitForA;
        return claims.assertCurrentClaim(...args);
      },
    });
    const controlB = new RunGraphControlPlane(root, deterministicDependencies(), authorityB);
    const retryB = controlB.applyClaimedEvent(completion, proof, claimed.entityVersion);
    await bObservedAbsentBarrier;

    await expect(
      controlA.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: true });
    crashBeforeFinalize = false;
    const reclaimed = await claims.reclaim({
      schemaVersion: "1",
      eventId: "concurrent-absent-reclaim",
      expectedEntityVersion: claimed.entityVersion,
      claimId: proof.claimId,
      reason: "owner_stopped",
      ownerStoppedEvidenceId: "process-exit:concurrent-absent",
    });
    expect(reclaimed).toMatchObject({ accepted: true, entityVersion: 2 });
    resumeB();

    const reconciled = await retryB;
    expect(reconciled).toMatchObject({ accepted: true });
    expect(reconciled).not.toHaveProperty("claimAuthorization");
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 3,
      claims: [],
      history: [{}, {}, { eventId: completion.eventId, operation: "authorize_event" }],
    });
    const journal = await new RunGraphEventStore(root).readJournal(runId);
    expect(
      journal.acceptedEvents.filter((event) => event.eventId === completion.eventId),
    ).toHaveLength(1);
    expect(
      journal.acceptedEvents.filter((event) => event.eventId === `audit:${completion.eventId}`),
    ).toHaveLength(1);
  });

  it("B validation 後に A append crash を挟んでも duplicate append をexact finalizeして単一CASにする", async () => {
    let crashBeforeFinalize = true;
    const {
      root,
      claims,
      control: controlA,
      runId,
      nodeId,
      claimed,
    } = await createClaimedControlPlane({
      beforeAuthorizationFinalizePublish: async () => {
        if (crashBeforeFinalize) throw new Error("authorization finalize interrupted");
      },
    });
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "concurrent-validated-before-append",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["concurrent-validated-evidence"],
      },
      evidence: [commandEvidence("concurrent-validated-evidence")],
    };
    let resumeB!: () => void;
    const waitForA = new Promise<void>((resolveBarrier) => {
      resumeB = resolveBarrier;
    });
    let bValidated!: () => void;
    const bValidatedBarrier = new Promise<void>((resolveValidated) => {
      bValidated = resolveValidated;
    });
    const authorityB = withClaimAuthorityOverrides(claims, {
      commitAuthorizedEvent: async (...args) => {
        bValidated();
        await waitForA;
        return claims.commitAuthorizedEvent(...args);
      },
    });
    const controlB = new RunGraphControlPlane(root, deterministicDependencies(), authorityB);
    const retryB = controlB.applyClaimedEvent(completion, proof, claimed.entityVersion);
    await bValidatedBarrier;

    await expect(
      controlA.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: true });
    crashBeforeFinalize = false;
    resumeB();
    const reconciled = await retryB;
    if (!reconciled.accepted || !reconciled.claimAuthorization)
      throw new Error("current claim authorization が必要です");
    expect(reconciled.claimAuthorization).toMatchObject({
      receipt: { entityVersion: 2, claimContinues: true },
      proof: { fencingToken: 2 },
    });

    const [heartbeat, reclaim] = await Promise.all([
      claims.heartbeat({
        schemaVersion: "1",
        eventId: "concurrent-finalized-heartbeat",
        expectedEntityVersion: 2,
        proof: reconciled.claimAuthorization.proof,
        leaseDurationSeconds: 300,
      }),
      claims.reclaim({
        schemaVersion: "1",
        eventId: "concurrent-finalized-reclaim",
        expectedEntityVersion: 2,
        claimId: proof.claimId,
        reason: "owner_stopped",
        ownerStoppedEvidenceId: "process-exit:concurrent-finalized",
      }),
    ]);
    expect([heartbeat, reclaim].filter((receipt) => receipt.accepted)).toHaveLength(1);
    expect([heartbeat, reclaim].filter((receipt) => !receipt.accepted)).toMatchObject([
      { code: "stale_entity_version", stateUnchanged: true },
    ]);
    await expect(claims.verifyReceipt(reconciled.claimAuthorization.receipt)).resolves.toBe(true);
    const journal = await new RunGraphEventStore(root).readJournal(runId);
    expect(
      journal.acceptedEvents.filter((event) => event.eventId === completion.eventId),
    ).toHaveLength(1);
    expect(
      journal.acceptedEvents.filter((event) => event.eventId === `audit:${completion.eventId}`),
    ).toHaveLength(1);
  });

  it("exact caller と journal sequence conflict の場合だけ pending をrollbackする", async () => {
    let crashBeforeAppend = true;
    const { claims, control, runId, nodeId, claimed } = await createClaimedControlPlane({
      afterAuthorizationPendingPublish: async () => {
        if (crashBeforeAppend) throw new Error("pending before sequence conflict");
      },
    });
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "pending-sequence-conflict",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["pending-sequence-conflict-evidence"],
      },
      evidence: [commandEvidence("pending-sequence-conflict-evidence")],
    };
    await expect(
      control.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: false, code: "stale_attempt" });
    crashBeforeAppend = false;
    await expect(
      control.applyEvent({
        schemaVersion: "1",
        eventId: completion.eventId,
        runId,
        actor: { id: "orchestrator-1", role: "orchestrator" },
        command: {
          type: "run_paused",
          checkpointArtifactId: "pending-sequence-checkpoint",
          evidenceIds: ["pending-sequence-checkpoint-evidence"],
          reason: "同じ event ID の別 raw command を先行させる",
        },
        artifacts: [
          {
            id: "pending-sequence-checkpoint",
            schemaId: "run.checkpoint",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("pending-sequence-checkpoint"),
          },
        ],
        evidence: [
          {
            id: "pending-sequence-checkpoint-evidence",
            kind: "checkpoint",
            artifactIds: ["pending-sequence-checkpoint"],
            provenance: "orchestrator-1",
            reference: reference("pending-sequence-checkpoint-evidence"),
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: true });

    await expect(
      control.applyClaimedEvent(
        {
          ...completion,
          command: { ...completion.command, outcome: "failed" as const },
        },
        proof,
        claimed.entityVersion,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "duplicate_event" });
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      pendingAuthorizations: [{ eventId: completion.eventId, claimId: proof.claimId }],
    });

    await expect(
      control.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({ accepted: false, code: "duplicate_event" });
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      claims: [{ claimId: proof.claimId, fencingToken: 1 }],
      pendingAuthorizations: [],
    });
    await expect(
      claims.heartbeat({
        schemaVersion: "1",
        eventId: "pending-sequence-heartbeat",
        expectedEntityVersion: claimed.entityVersion,
        proof,
        leaseDurationSeconds: 300,
      }),
    ).resolves.toMatchObject({ accepted: true, entityVersion: 2 });
  });

  it("Run Graph append 後の registry crash と reclaim 後は既存 event だけを冪等に読む", async () => {
    let now = "2026-08-02T00:00:00.000Z";
    let crashBeforePublish = false;
    const { root, claims, control, runId, nodeId, claimed } = await createClaimedControlPlane({
      now: () => now,
      beforeAuthorizationFinalizePublish: async () => {
        if (crashBeforePublish) throw new Error("authorization publish interrupted");
      },
    });
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId,
    };
    const completion = {
      schemaVersion: "1" as const,
      eventId: "crash-after-append",
      runId,
      actor: { id: "task-runner", role: "planner" as const },
      command: {
        type: "attempt_finished" as const,
        nodeId,
        attemptId: "planner-attempt",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["crash-after-append-evidence"],
      },
      evidence: [commandEvidence("crash-after-append-evidence")],
    };

    crashBeforePublish = true;
    await expect(
      control.applyClaimedEvent(completion, proof, claimed.entityVersion),
    ).resolves.toMatchObject({
      accepted: true,
      view: { activeAttempt: { state: "succeeded" } },
    });
    crashBeforePublish = false;
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      claims: [{}],
      pendingAuthorizations: [{ eventId: completion.eventId, claimId: proof.claimId }],
    });
    await expect(
      claims.heartbeat({
        schemaVersion: "1",
        eventId: "heartbeat-during-pending",
        expectedEntityVersion: 1,
        proof,
        leaseDurationSeconds: 300,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      code: "authorization_pending",
      stateUnchanged: true,
      entityVersion: 1,
    });
    await expect(
      claims.release({
        schemaVersion: "1",
        eventId: "release-during-pending",
        expectedEntityVersion: 1,
        proof,
      }),
    ).resolves.toMatchObject({ accepted: false, code: "authorization_pending" });
    const afterCrash = await new RunGraphEventStore(root).readJournal(runId);
    expect(
      afterCrash.acceptedEvents.filter((event) => event.eventId === completion.eventId),
    ).toHaveLength(1);
    expect(
      afterCrash.acceptedEvents.find((event) => event.eventId === completion.eventId),
    ).toMatchObject({ dispatchAuthorization: { claimId: proof.claimId, fencingToken: 1 } });

    now = "2026-08-02T00:10:00.000Z";
    const reclaimed = await claims.reclaim({
      schemaVersion: "1",
      eventId: "crash-after-append-reclaim",
      expectedEntityVersion: 1,
      claimId: proof.claimId,
      reason: "expired",
    });
    expect(reclaimed).toMatchObject({ accepted: true, entityVersion: 2 });
    await expect(control.applyClaimedEvent(completion, proof, 1)).resolves.toMatchObject({
      accepted: true,
      view: { activeAttempt: { state: "succeeded" } },
    });
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 3,
      claims: [],
      pendingAuthorizations: [],
    });
    await expect(
      control.applyClaimedEvent(
        { ...completion, eventId: "stale-after-reclaim-new-event" },
        proof,
        2,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim" });
    const finalJournal = await new RunGraphEventStore(root).readJournal(runId);
    expect(
      finalJournal.acceptedEvents.filter((event) => event.eventId === completion.eventId),
    ).toHaveLength(1);
    expect(
      finalJournal.acceptedEvents.filter(
        (event) =>
          event.eventId === `audit:${completion.eventId}` &&
          event.command.type === "claim_event_authorized",
      ),
    ).toHaveLength(1);
    expect(
      finalJournal.acceptedEvents.some(
        (event) => event.eventId === "stale-after-reclaim-new-event",
      ),
    ).toBe(false);
    await expect(claims.snapshot()).resolves.toMatchObject({ entityVersion: 3, claims: [] });
  });
});
