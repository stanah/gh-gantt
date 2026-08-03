import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config, MutationProposal } from "@gh-gantt/shared";
import {
  RunActivityInspector,
  type RunActivitySummary,
} from "../run-graph/run-activity-inspector.js";
import type { RepositoryCoordinationLayout } from "../store/repository-coordination-layout.js";

function hashString(value: string): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function config(): Config {
  return {
    version: "1",
    project: { name: "fixture", github: { owner: "o", repo: "r", project_number: 1 } },
    sync: { auto_create_issues: false, field_mapping: { start_date: "Start", end_date: "End" } },
    task_types: { task: { label: "Task", display: "bar", color: "#000", github_label: null } },
    type_hierarchy: { task: [] },
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "month",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" },
    },
  } as Config;
}

function layout(root: string, roots: string[]): RepositoryCoordinationLayout {
  return {
    projectRoot: root,
    commonDir: join(root, ".git"),
    projectIdentity: "o/r#1",
    projectKey: "project-key",
    claimRoot: join(root, ".git", "claims"),
    mutationProposalRoot: join(root, ".git", "proposals"),
    canonicalWorkspaceId: `workspace:${hashString(root)}`,
    linkedWorktrees: roots,
    linkedProjectRoots: roots,
    config: config(),
  };
}

function summary(root: string, overrides: Partial<RunActivitySummary> = {}): RunActivitySummary {
  return {
    workspaceId: `workspace:${hashString(root)}`,
    projectRoot: root,
    runId: "run-origin",
    taskId: "o/r#1",
    revision: 3,
    state: "waiting_human",
    currentNodeId: "node-1",
    currentNodeState: "waiting_human",
    activeAttemptId: null,
    activeAttemptState: null,
    planId: "plan-1",
    planVersion: "1",
    schemaVersion: "1",
    checkpointEventId: "checkpoint-1",
    ...overrides,
  };
}

function proposal(originRoot: string): MutationProposal {
  return {
    origin: {
      runId: "run-origin",
      workspaceId: `workspace:${hashString(originRoot)}`,
      taskId: "o/r#1",
      repository: "o/r",
      planId: "plan-1",
      planVersion: "1",
      authorityId: "run-checkpoint:checkpoint-1",
      mutationCheckpointId: "checkpoint-1",
    },
    targetTaskIds: ["o/r#1"],
  } as MutationProposal;
}

describe("[Issue #331] RunActivityInspectorの完全な網羅性", () => {
  it("全linked project rootとclaim revisionを二重確認してorigin bindingを導出する", async () => {
    const first = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-run-coverage-a-")));
    const second = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-run-coverage-b-")));
    const projectLayout = layout(first, [first, second]);
    const claimSnapshot = {
      schemaVersion: "1" as const,
      projectIdentity: "o/r#1",
      entityVersion: 7,
      claims: [],
      pendingAuthorizations: [],
      history: [],
    };
    const inspector = new RunActivityInspector(first, {
      now: () => "2026-08-02T00:00:00.000Z",
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () => claimSnapshot,
      listRunIds: async (root) => (root === first ? ["run-origin"] : []),
      inspectRun: async () => summary(first),
    });

    const inspected = await inspector.inspectComplete();
    expect(inspected).toMatchObject({
      ok: true,
      proof: {
        claimEntityVersion: 7,
        projectRoots: [first, second],
        nonterminalRuns: [{ runId: "run-origin", workspaceId: `workspace:${hashString(first)}` }],
      },
    });
    expect(await inspector.resolveOrigin("run-origin")).toMatchObject({
      ok: true,
      origin: {
        runId: "run-origin",
        workspaceId: `workspace:${hashString(first)}`,
        mutationCheckpointId: "checkpoint-1",
      },
    });
    expect(await inspector.validateApply(proposal(first))).toMatchObject({ ok: true });
  });

  it("別workspaceのunfinished Run、claim revision drift、active Attemptをfail-closedにする", async () => {
    const first = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-run-coverage-c-")));
    const second = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-run-coverage-d-")));
    const projectLayout = layout(first, [first, second]);
    let revision = 0;
    const driftInspector = new RunActivityInspector(first, {
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () => ({
        schemaVersion: "1",
        projectIdentity: "o/r#1",
        entityVersion: revision++,
        claims: [],
        pendingAuthorizations: [],
        history: [],
      }),
      listRunIds: async () => [],
      inspectRun: async () => summary(first),
    });
    expect(await driftInspector.inspectComplete()).toMatchObject({
      ok: false,
      code: "run_state_unknown",
    });

    const stableSnapshot = {
      schemaVersion: "1" as const,
      projectIdentity: "o/r#1",
      entityVersion: 2,
      claims: [],
      pendingAuthorizations: [],
      history: [],
    };
    const conflictInspector = new RunActivityInspector(first, {
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () => stableSnapshot,
      listRunIds: async (root) => (root === first ? ["run-origin"] : ["run-competing"]),
      inspectRun: async (root, runId) =>
        runId === "run-origin"
          ? summary(first, { activeAttemptId: "attempt-active", activeAttemptState: "running" })
          : summary(root, { runId: "run-competing" }),
    });
    expect(await conflictInspector.validateApply(proposal(first))).toMatchObject({
      ok: false,
      code: "active_attempt_conflict",
    });
  });

  it("scan中のjournal revision driftとaffected downstreamのclaim/attemptを拒否する", async () => {
    const first = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-run-coverage-e-")));
    const second = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-run-coverage-f-")));
    const projectLayout = layout(first, [first, second]);
    const stableSnapshot = {
      schemaVersion: "1" as const,
      projectIdentity: "o/r#1",
      entityVersion: 2,
      claims: [],
      pendingAuthorizations: [],
      history: [],
    };
    let inspections = 0;
    const revisionDrift = new RunActivityInspector(first, {
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () => stableSnapshot,
      listRunIds: async (root) => (root === first ? ["run-origin"] : []),
      inspectRun: async () => summary(first, { revision: ++inspections }),
    });
    expect(await revisionDrift.inspectComplete()).toMatchObject({
      ok: false,
      code: "run_state_unknown",
    });

    const downstreamProposal = {
      ...proposal(first),
      affectedDownstream: ["o/r#2"],
    } as MutationProposal;
    const activeDownstream = new RunActivityInspector(first, {
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () => stableSnapshot,
      listRunIds: async (root) => (root === first ? ["run-origin"] : ["run-downstream"]),
      inspectRun: async (root, runId) =>
        runId === "run-origin"
          ? summary(first)
          : summary(root, {
              runId,
              taskId: "o/r#2",
              activeAttemptId: "attempt-downstream",
              activeAttemptState: "running",
            }),
    });
    expect(await activeDownstream.validateApply(downstreamProposal)).toMatchObject({
      ok: false,
      code: "active_attempt_conflict",
    });

    const claimedDownstream = new RunActivityInspector(first, {
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () =>
        ({
          ...stableSnapshot,
          claims: [
            {
              claimId: "claim-downstream",
              runId: "run-downstream",
              taskId: "o/r#2",
            },
          ],
        }) as never,
      listRunIds: async (root) => (root === first ? ["run-origin"] : ["run-downstream"]),
      inspectRun: async (root, runId) =>
        runId === "run-origin" ? summary(first) : summary(root, { runId, taskId: "o/r#2" }),
    });
    expect(await claimedDownstream.validateApply(downstreamProposal)).toMatchObject({
      ok: false,
      code: "active_claim",
    });
  });

  it("nested descendant mutationでもcanonical originをcoverageとclaim対象へ常時含める", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-run-origin-closure-")));
    const projectLayout = layout(root, [root]);
    const nestedProposal = {
      ...proposal(root),
      targetTaskIds: ["o/r#3"],
      affectedDownstream: [],
    } as MutationProposal;
    const stableSnapshot = {
      schemaVersion: "1" as const,
      projectIdentity: "o/r#1",
      entityVersion: 4,
      claims: [],
      pendingAuthorizations: [],
      history: [],
    };
    const inspector = new RunActivityInspector(root, {
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () => stableSnapshot,
      listRunIds: async () => ["run-origin"],
      inspectRun: async () => summary(root),
    });
    await expect(inspector.validateApply(nestedProposal)).resolves.toMatchObject({
      ok: true,
      affectedRuns: [{ runId: "run-origin", taskId: "o/r#1" }],
    });

    const claimed = new RunActivityInspector(root, {
      resolveLayout: async () => projectLayout,
      readClaimSnapshot: async () =>
        ({
          ...stableSnapshot,
          claims: [{ claimId: "claim-origin", runId: "run-other", taskId: "o/r#1" }],
        }) as never,
      listRunIds: async () => ["run-origin"],
      inspectRun: async () => summary(root),
    });
    await expect(claimed.validateApply(nestedProposal)).resolves.toMatchObject({
      ok: false,
      code: "active_claim",
    });
  });
});
