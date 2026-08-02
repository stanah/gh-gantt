import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FIXED_DEV_ROLE_GRAPH_CONTRACT } from "@gh-gantt/shared";
import { gitFixtureEnvironment } from "../git-fixture.js";
import { RunGraphControlPlane } from "../../run-graph/control-plane.js";
import {
  DispatchClaimStore,
  createDispatchClaimStoreDependencies,
} from "../../store/dispatch-claims.js";
import { GraphContractStore } from "../../store/graph-contract.js";

const execFileAsync = promisify(execFile);
const CONFIG = `${JSON.stringify(
  {
    version: "1",
    project: {
      name: "fixture",
      github: { owner: "fixture", repo: "repository", project_number: 1 },
    },
    sync: { auto_create_issues: false, field_mapping: { start_date: "Start", end_date: "End" } },
    task_types: { task: { label: "Task", display: "bar", color: "#000", github_label: null } },
    type_hierarchy: { task: [] },
    statuses: {
      field_name: "Status",
      values: {
        Todo: { color: "#000", done: false },
        Doing: { color: "#111", done: false },
      },
    },
    gantt: {
      default_view: "month",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" },
    },
    dispatch: {
      max_concurrency: 3,
      state_concurrency: { Todo: 1, Doing: 2 },
      repository_concurrency: { "fixture/repository": 1 },
    },
  },
  null,
  2,
)}\n`;

describe("[NFR-STABILITY-014-AC9][Issue #329] linked-worktree 間の claim coordination", () => {
  it("raw Git fixture は repository-selection 変数だけを除去する", () => {
    const environment = gitFixtureEnvironment({
      GIT_DIR: "foreign-git-dir",
      GIT_WORK_TREE: "foreign-work-tree",
      GIT_INDEX_FILE: "foreign-index",
      GIT_COMMON_DIR: "foreign-common-dir",
      LEFTHOOK: "1",
      FIXTURE_SENTINEL: "preserved",
    });

    expect(environment).toEqual({ LEFTHOOK: "1", FIXTURE_SENTINEL: "preserved" });
  });

  it("別 OS process から同じ registry を観測しつつ Run Graph journal は workspace-local に保つ", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "gh-gantt-issue-329-"));
    const repository = join(scratch, "repository");
    const linked = join(scratch, "linked");
    try {
      await execFileAsync("git", ["init", repository], { env: gitFixtureEnvironment() });
      await execFileAsync(
        "git",
        ["-C", repository, "config", "user.email", "fixture@example.invalid"],
        { env: gitFixtureEnvironment() },
      );
      await execFileAsync("git", ["-C", repository, "config", "user.name", "Fixture"], {
        env: gitFixtureEnvironment(),
      });
      await mkdir(join(repository, ".gantt-sync"), { recursive: true });
      await writeFile(join(repository, ".gantt-sync", "gantt.config.json"), CONFIG);
      await execFileAsync("git", ["-C", repository, "add", ".gantt-sync/gantt.config.json"], {
        env: gitFixtureEnvironment(),
      });
      await execFileAsync("git", ["-C", repository, "commit", "-m", "fixture"], {
        env: gitFixtureEnvironment(),
      });
      await execFileAsync("git", ["-C", repository, "worktree", "add", linked, "-b", "linked"], {
        env: gitFixtureEnvironment(),
      });

      await new GraphContractStore(repository).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
      const started = await new RunGraphControlPlane(repository).start({
        schemaVersion: "1",
        eventId: "run-start",
        actor: { id: "orchestrator-1", role: "orchestrator" },
        task: { owner: "fixture", repo: "repository", issueNumber: 1 },
        contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      });
      if (!started.accepted) throw new Error(started.message);
      const currentNode = started.view.currentNode;
      if (!currentNode) throw new Error("current node が必要です");
      const attemptStarted = await new RunGraphControlPlane(repository).applyEvent({
        schemaVersion: "1",
        eventId: "attempt-start",
        runId: started.view.runId,
        actor: { id: "planner-1", role: "planner" },
        command: {
          type: "attempt_started",
          nodeId: currentNode.id,
          attemptId: "attempt-planner-1",
        },
      });
      if (!attemptStarted.accepted) throw new Error(attemptStarted.message);

      const claims = new DispatchClaimStore(
        repository,
        createDispatchClaimStoreDependencies({
          now: () => "2026-08-02T00:00:00.000Z",
          nextId: () => "claim-linked",
          readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        }),
      );
      const claimed = await claims.claim({
        schemaVersion: "1",
        eventId: "claim-main",
        expectedEntityVersion: 0,
        taskId: "fixture/repository#1",
        repository: "fixture/repository",
        state: "Todo",
        ownerId: "owner-main",
        workspaceId: "workspace-shared",
        runId: started.view.runId,
        leaseDurationSeconds: 300,
        dispatchPlanId: "dispatch-plan:test-main",
        dispatchPlanVersion: "1",
        snapshotFingerprint: "d".repeat(64),
      });
      if (!claimed.accepted) throw new Error(claimed.message);

      const childScript = join(scratch, "linked-observer.ts");
      await writeFile(
        childScript,
        `void (async () => {
const [moduleUrl, root] = process.argv.slice(2);
const { DispatchClaimStore, createDispatchClaimStoreDependencies } = await import(moduleUrl);
let current = "2026-08-02T00:01:00.000Z";
const store = new DispatchClaimStore(root, createDispatchClaimStoreDependencies({
  now: () => current,
  nextId: () => "claim-linked-process-new",
  readCurrentSnapshotFingerprint: async () => "d".repeat(64),
}));
const snapshot = await store.snapshot();
const workspaceDuplicate = await store.claim({
  schemaVersion: "1",
  eventId: "claim-linked-workspace-duplicate",
  expectedEntityVersion: snapshot.entityVersion,
  taskId: "fixture/repository#2",
  repository: "fixture/repository",
  state: "Todo",
  ownerId: "owner-linked",
  workspaceId: "workspace-shared",
  runId: "run-linked",
  leaseDurationSeconds: 300,
  dispatchPlanId: "dispatch-plan:test-duplicate",
  dispatchPlanVersion: "1",
  snapshotFingerprint: "d".repeat(64),
});
const capacity = await store.claim({
  schemaVersion: "1",
  eventId: "claim-linked-capacity",
  expectedEntityVersion: snapshot.entityVersion,
  taskId: "fixture/repository#2",
  repository: "fixture/repository",
  state: "Todo",
  ownerId: "owner-linked",
  workspaceId: "workspace-linked",
  runId: "run-linked",
  leaseDurationSeconds: 300,
  dispatchPlanId: "dispatch-plan:test-capacity",
  dispatchPlanVersion: "1",
  snapshotFingerprint: "d".repeat(64),
});
const first = snapshot.claims[0];
const heartbeat = await store.heartbeat({
  schemaVersion: "1",
  eventId: "heartbeat-linked",
  expectedEntityVersion: snapshot.entityVersion,
  proof: {
    claimId: first.claimId,
    fencingToken: first.fencingToken,
    ownerId: first.ownerId,
    runId: first.runId,
  },
  leaseDurationSeconds: 300,
});
const release = await store.release({
  schemaVersion: "1",
  eventId: "release-linked",
  expectedEntityVersion: heartbeat.entityVersion,
  proof: {
    claimId: heartbeat.claim.claimId,
    fencingToken: heartbeat.claim.fencingToken,
    ownerId: heartbeat.claim.ownerId,
    runId: heartbeat.claim.runId,
  },
});
current = "2026-08-02T00:02:00.000Z";
const reclaimedClaim = await store.claim({
  schemaVersion: "1",
  eventId: "claim-before-reclaim",
  expectedEntityVersion: release.entityVersion,
  taskId: "fixture/repository#2",
  repository: "fixture/repository",
  state: "Todo",
  ownerId: "owner-linked",
  workspaceId: "workspace-linked",
  runId: first.runId,
  leaseDurationSeconds: 60,
  dispatchPlanId: "dispatch-plan:test-reclaim",
  dispatchPlanVersion: "1",
  snapshotFingerprint: "d".repeat(64),
});
current = "2026-08-02T00:04:00.000Z";
const reclaim = await store.reclaim({
  schemaVersion: "1",
  eventId: "reclaim-linked-expired",
  expectedEntityVersion: reclaimedClaim.entityVersion,
  claimId: reclaimedClaim.claim.claimId,
  reason: "expired",
});
process.stdout.write(JSON.stringify({
  snapshot,
  workspaceDuplicate,
  capacity,
  heartbeat,
  release,
  reclaimedClaim,
  reclaim,
}));
})();
`,
      );
      const moduleUrl = pathToFileURL(
        resolve(import.meta.dirname, "../../store/dispatch-claims.ts"),
      ).href;
      const observed = await execFileAsync(
        process.execPath,
        ["--import", "tsx", childScript, moduleUrl, linked],
        { encoding: "utf8" },
      );
      const result = JSON.parse(observed.stdout) as {
        snapshot: {
          entityVersion: number;
          claims: Array<{
            claimId: string;
            fencingToken: number;
            ownerId: string;
            runId: string;
          }>;
        };
        workspaceDuplicate: { accepted: boolean; code: string };
        capacity: { accepted: boolean; code: string };
        heartbeat: {
          accepted: boolean;
          entityVersion: number;
          claim: { fencingToken: number };
        };
        release: { accepted: boolean; entityVersion: number };
        reclaimedClaim: {
          accepted: boolean;
          entityVersion: number;
          claim: { claimId: string; fencingToken: number; ownerId: string; runId: string };
        };
        reclaim: { accepted: boolean; entityVersion: number; reclaimReason: string };
      };
      expect(result).toMatchObject({
        snapshot: { entityVersion: 1, claims: [{ claimId: "claim-linked" }] },
        workspaceDuplicate: { accepted: false, code: "workspace_already_claimed" },
        capacity: { accepted: false, code: "state_capacity" },
        heartbeat: { accepted: true, entityVersion: 2, claim: { fencingToken: 2 } },
        release: { accepted: true, entityVersion: 3 },
        reclaimedClaim: { accepted: true, entityVersion: 4 },
        reclaim: { accepted: true, entityVersion: 5, reclaimReason: "expired" },
      });
      const staleCompletion = await new RunGraphControlPlane(
        repository,
        undefined,
        new DispatchClaimStore(
          repository,
          createDispatchClaimStoreDependencies({ now: () => "2026-08-02T00:04:00.000Z" }),
        ),
      ).applyClaimedEvent(
        {
          schemaVersion: "1" as const,
          eventId: "stale-completion-after-reclaim",
          runId: started.view.runId,
          actor: { id: "planner-1", role: "planner" },
          command: {
            type: "attempt_finished",
            nodeId: currentNode.id,
            attemptId: "attempt-planner-1",
            outcome: "succeeded",
            artifactIds: [],
            evidenceIds: ["stale-reclaimed-evidence"],
          },
          evidence: [
            {
              id: "stale-reclaimed-evidence",
              kind: "command_execution",
              artifactIds: [],
              provenance: "stale-reclaimed-runner",
              reference: {
                kind: "command",
                uri: "command://stale-reclaimed",
                sha256: `sha256:${"b".repeat(64)}`,
                byteLength: 1,
              },
            },
          ],
        },
        {
          claimId: result.reclaimedClaim.claim.claimId,
          fencingToken: result.reclaimedClaim.claim.fencingToken,
          ownerId: result.reclaimedClaim.claim.ownerId,
          runId: result.reclaimedClaim.claim.runId,
        },
        result.reclaimedClaim.entityVersion,
      );
      expect(staleCompletion).toMatchObject({
        accepted: false,
        code: "stale_claim",
        stateUnchanged: true,
        view: { revision: 2, activeAttempt: { state: "running" } },
      });

      const raceWorker = join(scratch, "race-worker.ts");
      await writeFile(
        raceWorker,
        `void (async () => {
const [moduleUrl, root, operation, rawInput] = process.argv.slice(2);
const { DispatchClaimStore, createDispatchClaimStoreDependencies } = await import(moduleUrl);
const store = new DispatchClaimStore(root, createDispatchClaimStoreDependencies({
  now: () => "2026-08-02T00:06:00.000Z",
  readCurrentSnapshotFingerprint: async () => "d".repeat(64),
}));
const input = JSON.parse(rawInput);
const result = operation === "commitAuthorizedEvent"
  ? await store.commitAuthorizedEvent(input, async () => undefined)
  : await store[operation](input);
process.stdout.write(JSON.stringify(result));
})();
`,
      );
      const raceStore = (id: string) =>
        new DispatchClaimStore(
          repository,
          createDispatchClaimStoreDependencies({
            now: () => "2026-08-02T00:05:00.000Z",
            nextId: () => id,
            readCurrentSnapshotFingerprint: async () => "d".repeat(64),
          }),
        );
      const runCapacityRace = async (
        label: "state" | "repository",
        candidates: Array<{
          taskId: string;
          repository: string;
          state: string;
          workspaceId: string;
        }>,
        expectedCode: "state_capacity" | "repository_capacity",
      ) => {
        const before = await raceStore("unused").snapshot();
        const inputs = candidates.map((candidate, index) => ({
          schemaVersion: "1" as const,
          eventId: `process-${label}-claim-${index}`,
          expectedEntityVersion: before.entityVersion,
          ...candidate,
          ownerId: `owner-${label}-${index}`,
          runId: `run-${label}-${index}`,
          leaseDurationSeconds: 300,
          dispatchPlanId: `dispatch-plan:${label}-${index}`,
          dispatchPlanVersion: "1" as const,
          snapshotFingerprint: "d".repeat(64),
        }));
        const results = await Promise.all(
          inputs.map((input) =>
            execFileAsync(
              process.execPath,
              ["--import", "tsx", raceWorker, moduleUrl, linked, "claim", JSON.stringify(input)],
              { encoding: "utf8" },
            ).then((output) => JSON.parse(output.stdout) as { accepted: boolean; code?: string }),
          ),
        );
        expect(results.filter((item) => item.accepted)).toHaveLength(1);
        const current = await raceStore("unused").snapshot();
        const losingIndex = results.findIndex((item) => !item.accepted);
        await expect(
          raceStore("unused").claim({
            ...inputs[losingIndex]!,
            eventId: `process-${label}-claim-retry`,
            expectedEntityVersion: current.entityVersion,
          }),
        ).resolves.toMatchObject({ accepted: false, code: expectedCode });
        await raceStore("unused").reclaim({
          schemaVersion: "1",
          eventId: `cleanup-${label}-capacity-race`,
          expectedEntityVersion: current.entityVersion,
          claimId: current.claims[0]!.claimId,
          reason: "owner_stopped",
          ownerStoppedEvidenceId: "process-exit:capacity-race",
        });
      };

      await runCapacityRace(
        "state",
        [
          {
            taskId: "fixture/repository#state-a",
            repository: "fixture/repository",
            state: "Todo",
            workspaceId: "workspace-state-a",
          },
          {
            taskId: "other/repository#state-b",
            repository: "other/repository",
            state: "Todo",
            workspaceId: "workspace-state-b",
          },
        ],
        "state_capacity",
      );
      await runCapacityRace(
        "repository",
        [
          {
            taskId: "fixture/repository#repo-a",
            repository: "fixture/repository",
            state: "Doing",
            workspaceId: "workspace-repo-a",
          },
          {
            taskId: "fixture/repository#repo-b",
            repository: "fixture/repository",
            state: "Doing",
            workspaceId: "workspace-repo-b",
          },
        ],
        "repository_capacity",
      );
      const runRace = async (
        operation: "heartbeat" | "reclaim",
        claim: {
          claimId: string;
          fencingToken: number;
          ownerId: string;
          runId: string;
          taskId: string;
          entityVersion: number;
        },
      ) => {
        const proof = {
          claimId: claim.claimId,
          fencingToken: claim.fencingToken,
          ownerId: claim.ownerId,
          runId: claim.runId,
        };
        const command = {
          type: "attempt_finished" as const,
          nodeId: currentNode.id,
          attemptId: "attempt-planner-1",
          outcome: "succeeded" as const,
          artifactIds: [],
          evidenceIds: [],
        };
        const completeInput = {
          schemaVersion: "1",
          eventId: `process-complete-vs-${operation}`,
          expectedEntityVersion: claim.entityVersion,
          proof,
          runId: claim.runId,
          taskId: claim.taskId,
          actorId: claim.ownerId,
          commandFingerprint: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
        };
        const competingInput =
          operation === "heartbeat"
            ? {
                schemaVersion: "1",
                eventId: "process-heartbeat-race",
                expectedEntityVersion: claim.entityVersion,
                proof,
                leaseDurationSeconds: 300,
              }
            : {
                schemaVersion: "1",
                eventId: "process-reclaim-race",
                expectedEntityVersion: claim.entityVersion,
                claimId: claim.claimId,
                reason: "owner_stopped",
                ownerStoppedEvidenceId: "process-exit:race-owner",
              };
        const [completion, competing] = await Promise.all([
          execFileAsync(
            process.execPath,
            [
              "--import",
              "tsx",
              raceWorker,
              moduleUrl,
              linked,
              "commitAuthorizedEvent",
              JSON.stringify(completeInput),
            ],
            { encoding: "utf8" },
          ),
          execFileAsync(
            process.execPath,
            [
              "--import",
              "tsx",
              raceWorker,
              moduleUrl,
              linked,
              operation,
              JSON.stringify(competingInput),
            ],
            { encoding: "utf8" },
          ),
        ]);
        return [JSON.parse(completion.stdout), JSON.parse(competing.stdout)] as Array<{
          accepted: boolean;
          code?: string;
        }>;
      };

      for (const operation of ["heartbeat", "reclaim"] as const) {
        const before = await raceStore(`claim-process-${operation}`).snapshot();
        if (before.claims[0]) {
          await raceStore("unused").reclaim({
            schemaVersion: "1",
            eventId: `cleanup-before-${operation}`,
            expectedEntityVersion: before.entityVersion,
            claimId: before.claims[0].claimId,
            reason: "owner_stopped",
            ownerStoppedEvidenceId: "process-exit:cleanup",
          });
        }
        const clean = await raceStore(`claim-process-${operation}`).snapshot();
        const acquired = await raceStore(`claim-process-${operation}`).claim({
          schemaVersion: "1",
          eventId: `claim-process-${operation}`,
          expectedEntityVersion: clean.entityVersion,
          taskId: "fixture/repository#1",
          repository: "fixture/repository",
          state: "Todo",
          ownerId: "planner-1",
          workspaceId: `workspace-process-${operation}`,
          runId: started.view.runId,
          leaseDurationSeconds: 300,
          dispatchPlanId: `dispatch-plan:process-${operation}`,
          dispatchPlanVersion: "1",
          snapshotFingerprint: "d".repeat(64),
        });
        if (!acquired.accepted || !acquired.claim) throw new Error("race claim が必要です");
        const raceResults = await runRace(operation, acquired.claim);
        expect(raceResults.filter((item) => item.accepted)).toHaveLength(1);
        expect(raceResults.filter((item) => !item.accepted)).toMatchObject([
          { code: "stale_entity_version" },
        ]);
      }

      const beforeCrashClaim = await raceStore("claim-crash-reconcile").snapshot();
      if (beforeCrashClaim.claims[0]) {
        await raceStore("unused").reclaim({
          schemaVersion: "1",
          eventId: "cleanup-before-crash-reconcile",
          expectedEntityVersion: beforeCrashClaim.entityVersion,
          claimId: beforeCrashClaim.claims[0].claimId,
          reason: "owner_stopped",
          ownerStoppedEvidenceId: "process-exit:cleanup",
        });
      }
      const cleanBeforeCrash = await raceStore("claim-crash-reconcile").snapshot();
      const crashClaim = await raceStore("claim-crash-reconcile").claim({
        schemaVersion: "1",
        eventId: "claim-crash-reconcile",
        expectedEntityVersion: cleanBeforeCrash.entityVersion,
        taskId: "fixture/repository#1",
        repository: "fixture/repository",
        state: "Todo",
        ownerId: "planner-1",
        workspaceId: "workspace-crash-reconcile",
        runId: started.view.runId,
        leaseDurationSeconds: 300,
        dispatchPlanId: "dispatch-plan:crash-reconcile",
        dispatchPlanVersion: "1",
        snapshotFingerprint: "d".repeat(64),
      });
      if (!crashClaim.accepted || !crashClaim.claim) throw new Error("crash claim が必要です");
      const completionCommand = {
        type: "attempt_finished" as const,
        nodeId: currentNode.id,
        attemptId: "attempt-planner-1",
        outcome: "succeeded" as const,
        artifactIds: [],
        evidenceIds: ["completion-command-evidence"],
      };
      const proof = {
        claimId: crashClaim.claim.claimId,
        fencingToken: crashClaim.claim.fencingToken,
        ownerId: crashClaim.claim.ownerId,
        runId: crashClaim.claim.runId,
      };
      const completionInput = {
        schemaVersion: "1" as const,
        eventId: "receipt-before-local-append-crash",
        runId: started.view.runId,
        actor: { id: "planner-1", role: "planner" as const },
        command: completionCommand,
        evidence: [
          {
            id: "completion-command-evidence",
            kind: "command_execution",
            artifactIds: [],
            provenance: "linked-process-race",
            reference: {
              kind: "command" as const,
              uri: "command://linked-process-race",
              sha256: `sha256:${"a".repeat(64)}`,
              byteLength: 1,
            },
          },
        ],
      };
      const replayCompletion = () =>
        new RunGraphControlPlane(repository, undefined, raceStore("unused")).applyClaimedEvent(
          completionInput,
          proof,
          crashClaim.entityVersion,
        );
      await expect(replayCompletion()).resolves.toMatchObject({
        accepted: true,
        claimAuthorization: {
          receipt: { entityVersion: crashClaim.entityVersion + 1 },
          proof: { fencingToken: crashClaim.entityVersion + 1 },
        },
      });
      await expect(replayCompletion()).resolves.toMatchObject({
        accepted: true,
        claimAuthorization: {
          receipt: { entityVersion: crashClaim.entityVersion + 1 },
          proof: { fencingToken: crashClaim.entityVersion + 1 },
        },
        view: {
          claimAudits: { total: 1, items: [{ command: { type: "claim_event_authorized" } }] },
        },
      });
      await expect(raceStore("unused").snapshot()).resolves.toMatchObject({
        entityVersion: crashClaim.entityVersion + 1,
        claims: [
          {
            claimId: crashClaim.claim.claimId,
            entityVersion: crashClaim.entityVersion + 1,
            fencingToken: crashClaim.entityVersion + 1,
          },
        ],
      });
      await expect(new RunGraphControlPlane(linked).inspect(started.view.runId)).rejects.toThrow(
        /見つかりません/,
      );
      await expect(
        new RunGraphControlPlane(repository).inspect(started.view.runId),
      ).resolves.toMatchObject({
        runId: started.view.runId,
        revision: 4,
        activeAttempt: { state: "succeeded" },
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
