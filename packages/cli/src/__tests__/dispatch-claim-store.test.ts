import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { gitFixtureEnvironment } from "./git-fixture.js";
import {
  DispatchClaimStore,
  createDispatchClaimStoreDependencies,
} from "../store/dispatch-claims.js";

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
    statuses: { field_name: "Status", values: { Todo: { color: "#000", done: false } } },
    gantt: {
      default_view: "month",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" },
    },
    dispatch: { max_concurrency: 2 },
  },
  null,
  2,
)}\n`;

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gh-gantt-dispatch-"));
  await execFileAsync("git", ["init", root], { env: gitFixtureEnvironment() });
  await mkdir(join(root, ".gantt-sync"), { recursive: true });
  await writeFile(join(root, ".gantt-sync", "gantt.config.json"), CONFIG);
  return root;
}

async function coordinationLockPath(root: string, version = "v1"): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
    env: gitFixtureEnvironment(),
  });
  const common = await realpath(resolve(root, stdout.trim()));
  const projectKey = createHash("sha256")
    .update(JSON.stringify("fixture/repository#1"))
    .digest("hex")
    .slice(0, 32);
  return join(common, "gh-gantt", "coordination", version, projectKey, "LOCK");
}

function waitForChildMessage<T>(child: ChildProcess, type: string): Promise<T> {
  return new Promise((resolveMessage, rejectMessage) => {
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && "type" in message && message.type === type) {
        cleanup();
        resolveMessage(message as T);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectMessage(new Error(`child process が ${type} 前に終了しました: ${code}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function store(root: string, now: () => string, ids: string[] = ["claim-1", "claim-2"]) {
  let index = 0;
  return new DispatchClaimStore(
    root,
    createDispatchClaimStoreDependencies({
      now,
      nextId: () => ids[index++] ?? `claim-${index}`,
      readCurrentSnapshotFingerprint: async () => "d".repeat(64),
    }),
  );
}

function acquire(eventId = "event-claim-1") {
  return {
    schemaVersion: "1" as const,
    eventId,
    expectedEntityVersion: 0,
    taskId: "fixture/repository#1",
    repository: "fixture/repository",
    state: "Todo",
    ownerId: "owner:1",
    workspaceId: "workspace:1",
    runId: "run:1",
    leaseDurationSeconds: 60,
    dispatchPlanId: "dispatch-plan:test",
    dispatchPlanVersion: "1" as const,
    snapshotFingerprint: "d".repeat(64),
  };
}

describe("[NFR-STABILITY-014-AC9] repository coordination claim registry", () => {
  it("coordination namespace は v1 を使用し、旧 1 namespace へ fallback しない", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");

    await expect(claims.claim(acquire())).resolves.toMatchObject({ accepted: true });

    const currentRegistry = join(dirname(await coordinationLockPath(root, "v1")), "registry.json");
    const legacyRegistry = join(dirname(await coordinationLockPath(root, "1")), "registry.json");
    await expect(readFile(currentRegistry, "utf8")).resolves.toContain('"schemaVersion": "1"');
    await expect(readFile(legacyRegistry, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("claim を CAS し、同じ eventId は同じ receipt に収束する", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");

    const first = await claims.claim(acquire());
    const replay = await new DispatchClaimStore(root).claim(acquire());

    expect(first).toMatchObject({
      accepted: true,
      operation: "claim",
      eventId: "event-claim-1",
      entityVersion: 1,
      claim: { claimId: "claim-1", fencingToken: 1, expiresAt: "2026-08-02T00:01:00.000Z" },
    });
    if (!first.accepted) throw new Error("claim が必要です");
    expect(replay).toEqual(first);
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      claims: [first.claim],
    });
  });

  it("同じ eventId の異なる payload と stale version は state unchanged で拒否する", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");
    await claims.claim(acquire());

    await expect(claims.claim({ ...acquire(), ownerId: "owner:other" })).resolves.toMatchObject({
      accepted: false,
      code: "event_payload_mismatch",
      stateUnchanged: true,
      entityVersion: 1,
    });
    await expect(claims.claim(acquire("event-claim-2"))).resolves.toMatchObject({
      accepted: false,
      code: "stale_entity_version",
      stateUnchanged: true,
      entityVersion: 1,
    });
    await expect(claims.snapshot()).resolves.toMatchObject({ entityVersion: 1 });
  });

  it("registry CAS 直前の snapshot fingerprint 変化を拒否する", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");

    await expect(
      claims.claim(acquire("snapshot-race"), async () => "e".repeat(64)),
    ).resolves.toMatchObject({
      accepted: false,
      code: "snapshot_mismatch",
      stateUnchanged: true,
      entityVersion: 0,
    });
    await expect(claims.snapshot()).resolves.toMatchObject({ entityVersion: 0, claims: [] });
  });

  it("同一 task と workspace の二重 claim は同じ generation 内で拒否する", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");
    const first = await claims.claim(acquire());
    const taskDuplicate = await claims.claim({
      ...acquire("event-task-duplicate"),
      expectedEntityVersion: first.entityVersion,
      ownerId: "owner:2",
      workspaceId: "workspace:2",
      runId: "run:2",
    });
    const workspaceDuplicate = await claims.claim({
      ...acquire("event-workspace-duplicate"),
      expectedEntityVersion: first.entityVersion,
      taskId: "fixture/repository#2",
      ownerId: "owner:2",
      runId: "run:2",
    });

    expect(taskDuplicate).toMatchObject({ accepted: false, code: "task_already_claimed" });
    expect(workspaceDuplicate).toMatchObject({
      accepted: false,
      code: "workspace_already_claimed",
    });
  });

  it("claim transaction 自体が global/state/repository capacity を再検証する", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");
    const first = await claims.claim(acquire());
    if (!first.accepted) throw new Error(first.message);
    const second = await claims.claim({
      ...acquire("event-capacity-2"),
      expectedEntityVersion: 1,
      taskId: "fixture/repository#2",
      workspaceId: "workspace:2",
      runId: "run:2",
    });
    if (!second.accepted) throw new Error(second.message);

    await expect(
      claims.claim({
        ...acquire("event-capacity-3"),
        expectedEntityVersion: 2,
        taskId: "fixture/repository#3",
        workspaceId: "workspace:3",
        runId: "run:3",
      }),
    ).resolves.toMatchObject({ accepted: false, code: "global_capacity", stateUnchanged: true });
  });

  it("heartbeat・release は current proof を要求し、reclaim 後の旧 owner を fence する", async () => {
    let current = "2026-08-02T00:00:00.000Z";
    const root = await repository();
    const claims = store(root, () => current);
    const claimed = await claims.claim(acquire());
    if (!claimed.accepted) throw new Error("claim が必要です");

    const heartbeat = await claims.heartbeat({
      schemaVersion: "1",
      eventId: "event-heartbeat-1",
      expectedEntityVersion: 1,
      proof: {
        claimId: claimed.claim.claimId,
        fencingToken: claimed.claim.fencingToken,
        ownerId: claimed.claim.ownerId,
        runId: claimed.claim.runId,
      },
      leaseDurationSeconds: 120,
    });
    expect(heartbeat).toMatchObject({
      accepted: true,
      entityVersion: 2,
      claim: { fencingToken: 2 },
    });

    current = "2026-08-02T00:03:00.000Z";
    const reclaimed = await claims.reclaim({
      schemaVersion: "1",
      eventId: "event-reclaim-1",
      expectedEntityVersion: 2,
      claimId: claimed.claim.claimId,
      reason: "expired",
    });
    expect(reclaimed).toMatchObject({ accepted: true, entityVersion: 3 });
    await expect(
      claims.release({
        schemaVersion: "1",
        eventId: "event-release-stale",
        expectedEntityVersion: 3,
        proof: {
          claimId: claimed.claim.claimId,
          fencingToken: 1,
          ownerId: claimed.claim.ownerId,
          runId: claimed.claim.runId,
        },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });
  });

  it("期限切れ owner の release を拒否して reclaim 理由を保持する", async () => {
    let current = "2026-08-02T00:00:00.000Z";
    const root = await repository();
    const claims = store(root, () => current);
    const claimed = await claims.claim(acquire());
    if (!claimed.accepted) throw new Error(claimed.message);
    current = "2026-08-02T00:02:00.000Z";

    await expect(
      claims.release({
        schemaVersion: "1",
        eventId: "event-expired-release",
        expectedEntityVersion: 1,
        proof: {
          claimId: claimed.claim.claimId,
          fencingToken: claimed.claim.fencingToken,
          ownerId: claimed.claim.ownerId,
          runId: claimed.claim.runId,
        },
      }),
    ).resolves.toMatchObject({ accepted: false, code: "lease_expired", stateUnchanged: true });
  });

  it("completion と reclaim/heartbeat は同じ registry CAS の勝者だけを受理する", async () => {
    const race = async (competitor: "reclaim" | "heartbeat") => {
      const root = await repository();
      const claims = store(root, () => "2026-08-02T00:00:00.000Z");
      const claimed = await claims.claim(acquire(`event-race-claim-${competitor}`));
      if (!claimed.accepted) throw new Error(claimed.message);
      const proof = {
        claimId: claimed.claim.claimId,
        fencingToken: claimed.claim.fencingToken,
        ownerId: claimed.claim.ownerId,
        runId: claimed.claim.runId,
      };
      const completion = claims.commitAuthorizedEvent(
        {
          schemaVersion: "1",
          eventId: `event-race-complete-${competitor}`,
          expectedEntityVersion: 1,
          proof,
          runId: claimed.claim.runId,
          taskId: claimed.claim.taskId,
          actorId: claimed.claim.ownerId,
          commandFingerprint: "a".repeat(64),
        },
        async () => undefined,
      );
      const competing =
        competitor === "reclaim"
          ? claims.reclaim({
              schemaVersion: "1",
              eventId: "event-race-reclaim",
              expectedEntityVersion: 1,
              claimId: claimed.claim.claimId,
              reason: "owner_stopped" as const,
              ownerStoppedEvidenceId: "process-exit:owner-1",
            })
          : claims.heartbeat({
              schemaVersion: "1",
              eventId: "event-race-heartbeat",
              expectedEntityVersion: 1,
              proof,
              leaseDurationSeconds: 120,
            });
      return Promise.all([completion, competing]);
    };

    for (const competitor of ["reclaim", "heartbeat"] as const) {
      const results = await race(competitor);
      expect(results.filter((result) => result.accepted)).toHaveLength(1);
      expect(results.filter((result) => !result.accepted)).toMatchObject([
        { code: "stale_entity_version", stateUnchanged: true },
      ]);
    }
  });

  it("event authorization は claim を維持して fencing proof を更新する", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");
    const claimed = await claims.claim(acquire());
    if (!claimed.accepted) throw new Error(claimed.message);
    const authorized = await claims.commitAuthorizedEvent(
      {
        schemaVersion: "1",
        eventId: "event-authorized-1",
        expectedEntityVersion: claimed.entityVersion,
        proof: {
          claimId: claimed.claim.claimId,
          fencingToken: claimed.claim.fencingToken,
          ownerId: claimed.claim.ownerId,
          runId: claimed.claim.runId,
        },
        runId: claimed.claim.runId,
        taskId: claimed.claim.taskId,
        actorId: claimed.claim.ownerId,
        commandFingerprint: "c".repeat(64),
      },
      async () => undefined,
    );

    expect(authorized).toMatchObject({
      accepted: true,
      operation: "authorize_event",
      entityVersion: 2,
      claim: {
        claimId: claimed.claim.claimId,
        entityVersion: 2,
        fencingToken: 2,
      },
    });
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 2,
      claims: [{ claimId: claimed.claim.claimId, entityVersion: 2, fencingToken: 2 }],
    });
  });

  it("pending authorization を owner_stopped reclaim で terminalize し新規 append を拒否する", async () => {
    const root = await repository();
    let interrupt = true;
    const claims = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-pending-owner-stopped",
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        afterAuthorizationPendingPublish: async () => {
          if (interrupt) throw new Error("pending persisted");
        },
      }),
    );
    const claimed = await claims.claim(acquire("pending-owner-stopped-claim"));
    if (!claimed.accepted) throw new Error(claimed.message);
    const authorization = {
      schemaVersion: "1" as const,
      eventId: "pending-owner-stopped-event",
      expectedEntityVersion: 1,
      proof: {
        claimId: claimed.claim.claimId,
        fencingToken: claimed.claim.fencingToken,
        ownerId: claimed.claim.ownerId,
        runId: claimed.claim.runId,
      },
      runId: claimed.claim.runId,
      taskId: claimed.claim.taskId,
      actorId: claimed.claim.ownerId,
      commandFingerprint: "f".repeat(64),
    };
    await expect(
      claims.commitAuthorizedEvent(authorization, async () => undefined),
    ).rejects.toThrow("pending persisted");
    interrupt = false;
    await expect(claims.snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      pendingAuthorizations: [{ eventId: authorization.eventId, claimId: claimed.claim.claimId }],
    });
    const reclaimed = await claims.reclaim({
      schemaVersion: "1",
      eventId: "pending-owner-stopped-reclaim",
      expectedEntityVersion: 1,
      claimId: claimed.claim.claimId,
      reason: "owner_stopped",
      ownerStoppedEvidenceId: "process-exit:pending-owner",
    });
    expect(reclaimed).toMatchObject({ accepted: true, entityVersion: 2 });
    await expect(
      claims.commitAuthorizedEvent(authorization, async () => undefined),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });
  });

  it("abort は exact pending だけを解除し、receipt 確定済みと reclaim 済み marker を変更しない", async () => {
    const root = await repository();
    let interrupt = true;
    const claims = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-abort-pending",
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        afterAuthorizationPendingPublish: async () => {
          if (interrupt) throw new Error("pending abort fixture");
        },
      }),
    );
    const claimed = await claims.claim(acquire("abort-pending-claim"));
    if (!claimed.accepted) throw new Error(claimed.message);
    const authorization = {
      schemaVersion: "1" as const,
      eventId: "abort-pending-authorization",
      expectedEntityVersion: claimed.entityVersion,
      proof: {
        claimId: claimed.claim.claimId,
        fencingToken: claimed.claim.fencingToken,
        ownerId: claimed.claim.ownerId,
        runId: claimed.claim.runId,
      },
      runId: claimed.claim.runId,
      taskId: claimed.claim.taskId,
      actorId: claimed.claim.ownerId,
      commandFingerprint: "7".repeat(64),
    };
    await expect(
      claims.commitAuthorizedEvent(authorization, async () => undefined),
    ).rejects.toThrow("pending abort fixture");
    const pending = await claims.snapshot();

    await expect(
      claims.abortPendingAuthorization(
        { ...authorization, eventId: "abort-other-event" },
        async () => "absent",
      ),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      claims.abortPendingAuthorization(
        { ...authorization, commandFingerprint: "8".repeat(64) },
        async () => "absent",
      ),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      claims.abortPendingAuthorization(
        {
          ...authorization,
          proof: { ...authorization.proof, fencingToken: authorization.proof.fencingToken + 1 },
        },
        async () => "absent",
      ),
    ).resolves.toEqual({ status: "conflict" });
    await expect(claims.snapshot()).resolves.toEqual(pending);

    await expect(
      claims.abortPendingAuthorization(authorization, async () => "absent"),
    ).resolves.toEqual({ status: "aborted" });
    await expect(claims.snapshot()).resolves.toMatchObject({ pendingAuthorizations: [] });
    interrupt = false;
    const finalized = await claims.commitAuthorizedEvent(authorization, async () => undefined);
    if (!finalized.accepted) throw new Error(finalized.message);
    await expect(
      claims.abortPendingAuthorization(authorization, async () => "absent"),
    ).resolves.toEqual({ status: "conflict" });
    await expect(claims.verifyReceipt(finalized)).resolves.toBe(true);

    const reclaimedAuthorization = {
      ...authorization,
      eventId: "abort-reclaimed-authorization",
      expectedEntityVersion: finalized.entityVersion,
      proof: {
        claimId: finalized.claim.claimId,
        fencingToken: finalized.claim.fencingToken,
        ownerId: finalized.claim.ownerId,
        runId: finalized.claim.runId,
      },
      commandFingerprint: "9".repeat(64),
    };
    interrupt = true;
    await expect(
      claims.commitAuthorizedEvent(reclaimedAuthorization, async () => undefined),
    ).rejects.toThrow("pending abort fixture");
    interrupt = false;
    await expect(
      claims.reclaim({
        schemaVersion: "1",
        eventId: "abort-pending-reclaim",
        expectedEntityVersion: finalized.entityVersion,
        claimId: finalized.claim.claimId,
        reason: "owner_stopped",
        ownerStoppedEvidenceId: "process-exit:abort-pending",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      claims.abortPendingAuthorization(reclaimedAuthorization, async () => "absent"),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      claims.commitAuthorizedEvent(reclaimedAuthorization, async () => undefined),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim" });
  });

  it("pending 中も heartbeat/release の stored receipt exact replay を優先する", async () => {
    const root = await repository();
    let interrupt = true;
    const claims = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-pending-replay",
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        afterAuthorizationPendingPublish: async () => {
          if (interrupt) throw new Error("pending replay fixture");
        },
      }),
    );
    const claimed = await claims.claim(acquire("pending-replay-claim"));
    if (!claimed.accepted) throw new Error(claimed.message);
    const heartbeatInput = {
      schemaVersion: "1" as const,
      eventId: "pending-replay-heartbeat",
      expectedEntityVersion: 1,
      proof: {
        claimId: claimed.claim.claimId,
        fencingToken: claimed.claim.fencingToken,
        ownerId: claimed.claim.ownerId,
        runId: claimed.claim.runId,
      },
      leaseDurationSeconds: 120,
    };
    const heartbeat = await claims.heartbeat(heartbeatInput);
    if (!heartbeat.accepted) throw new Error(heartbeat.message);
    const rejectedReleaseInput = {
      schemaVersion: "1" as const,
      eventId: "pending-replay-rejected-release",
      expectedEntityVersion: 2,
      proof: heartbeatInput.proof,
    };
    const rejectedRelease = await claims.release(rejectedReleaseInput);
    expect(rejectedRelease).toMatchObject({ accepted: false, code: "stale_claim" });

    const authorization = {
      schemaVersion: "1" as const,
      eventId: "pending-replay-authorization",
      expectedEntityVersion: 2,
      proof: {
        claimId: heartbeat.claim.claimId,
        fencingToken: heartbeat.claim.fencingToken,
        ownerId: heartbeat.claim.ownerId,
        runId: heartbeat.claim.runId,
      },
      runId: heartbeat.claim.runId,
      taskId: heartbeat.claim.taskId,
      actorId: heartbeat.claim.ownerId,
      commandFingerprint: "9".repeat(64),
    };
    await expect(
      claims.commitAuthorizedEvent(authorization, async () => undefined),
    ).rejects.toThrow("pending replay fixture");
    interrupt = false;
    const beforeReplay = await claims.snapshot();
    expect(beforeReplay).toMatchObject({
      entityVersion: 2,
      pendingAuthorizations: [{ eventId: authorization.eventId, claimId: heartbeat.claim.claimId }],
    });

    await expect(claims.heartbeat(heartbeatInput)).resolves.toEqual(heartbeat);
    await expect(claims.release(rejectedReleaseInput)).resolves.toEqual(rejectedRelease);
    await expect(claims.snapshot()).resolves.toEqual(beforeReplay);
    const pendingHeartbeatInput = {
      ...heartbeatInput,
      eventId: "pending-replay-new-heartbeat",
      expectedEntityVersion: 2,
      proof: authorization.proof,
    };
    const pendingHeartbeat = await claims.heartbeat(pendingHeartbeatInput);
    expect(pendingHeartbeat).toMatchObject({ accepted: false, code: "authorization_pending" });
    await expect(claims.snapshot()).resolves.toEqual(beforeReplay);

    const finalized = await claims.commitAuthorizedEvent(authorization, async () => undefined);
    if (!finalized.accepted) throw new Error(finalized.message);
    await expect(claims.heartbeat(pendingHeartbeatInput)).resolves.toEqual(pendingHeartbeat);
    await expect(
      claims.heartbeat({
        ...pendingHeartbeatInput,
        eventId: "pending-replay-corrected-heartbeat",
        expectedEntityVersion: finalized.entityVersion,
        proof: {
          claimId: finalized.claim.claimId,
          fencingToken: finalized.claim.fencingToken,
          ownerId: finalized.claim.ownerId,
          runId: finalized.claim.runId,
        },
      }),
    ).resolves.toMatchObject({ accepted: true, entityVersion: finalized.entityVersion + 1 });
  });

  it("pending 中の新規 release 拒否は rollback 後も exact replay し claim を変更しない", async () => {
    const root = await repository();
    const claims = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-pending-rollback",
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        afterAuthorizationPendingPublish: async () => {
          throw new Error("pending rollback fixture");
        },
      }),
    );
    const claimed = await claims.claim(acquire("pending-rollback-claim"));
    if (!claimed.accepted) throw new Error(claimed.message);
    const proof = {
      claimId: claimed.claim.claimId,
      fencingToken: claimed.claim.fencingToken,
      ownerId: claimed.claim.ownerId,
      runId: claimed.claim.runId,
    };
    const authorization = {
      schemaVersion: "1" as const,
      eventId: "pending-rollback-authorization",
      expectedEntityVersion: claimed.entityVersion,
      proof,
      runId: claimed.claim.runId,
      taskId: claimed.claim.taskId,
      actorId: claimed.claim.ownerId,
      commandFingerprint: "6".repeat(64),
    };
    await expect(
      claims.commitAuthorizedEvent(authorization, async () => undefined),
    ).rejects.toThrow("pending rollback fixture");
    const beforeRejection = await claims.snapshot();
    const releaseInput = {
      schemaVersion: "1" as const,
      eventId: "pending-rollback-release",
      expectedEntityVersion: claimed.entityVersion,
      proof,
    };

    const rejection = await claims.release(releaseInput);
    expect(rejection).toMatchObject({ accepted: false, code: "authorization_pending" });
    await expect(claims.snapshot()).resolves.toEqual(beforeRejection);
    await expect(
      claims.abortPendingAuthorization(authorization, async () => "absent"),
    ).resolves.toEqual({ status: "aborted" });
    await expect(claims.release(releaseInput)).resolves.toEqual(rejection);
    await expect(
      claims.heartbeat({
        schemaVersion: "1",
        eventId: "pending-rollback-corrected-heartbeat",
        expectedEntityVersion: claimed.entityVersion,
        proof,
        leaseDurationSeconds: 120,
      }),
    ).resolves.toMatchObject({ accepted: true, entityVersion: claimed.entityVersion + 1 });
  });

  it("completion authorization を claim の run/task/actor lineage に binding する", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");
    const claimed = await claims.claim(acquire());
    if (!claimed.accepted) throw new Error(claimed.message);
    const base = {
      schemaVersion: "1" as const,
      expectedEntityVersion: 1,
      proof: {
        claimId: claimed.claim.claimId,
        fencingToken: claimed.claim.fencingToken,
        ownerId: claimed.claim.ownerId,
        runId: claimed.claim.runId,
      },
      runId: claimed.claim.runId,
      taskId: claimed.claim.taskId,
      actorId: claimed.claim.ownerId,
      commandFingerprint: "b".repeat(64),
    };

    await expect(
      claims.commitAuthorizedEvent(
        { ...base, eventId: "complete-wrong-run", runId: "run:other" },
        async () => undefined,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });
    await expect(
      claims.commitAuthorizedEvent(
        { ...base, eventId: "complete-wrong-task", taskId: "fixture/repository#2" },
        async () => undefined,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });
    await expect(
      claims.commitAuthorizedEvent(
        { ...base, eventId: "complete-wrong-actor", actorId: "owner:other" },
        async () => undefined,
      ),
    ).resolves.toMatchObject({ accepted: false, code: "stale_claim", stateUnchanged: true });
    await expect(claims.snapshot()).resolves.toMatchObject({ entityVersion: 1, claims: [{}] });
  });

  it("期限前 reclaim を拒否し、停止 owner は明示理由で回収できる", async () => {
    const root = await repository();
    const claims = store(root, () => "2026-08-02T00:00:00.000Z");
    const claimed = await claims.claim(acquire());
    if (!claimed.accepted) throw new Error("claim が必要です");
    await expect(
      claims.reclaim({
        schemaVersion: "1",
        eventId: "event-reclaim-early",
        expectedEntityVersion: 1,
        claimId: claimed.claim.claimId,
        reason: "expired",
      }),
    ).resolves.toMatchObject({ accepted: false, code: "lease_not_expired" });
    await expect(
      claims.reclaim({
        schemaVersion: "1",
        eventId: "event-reclaim-stopped-without-evidence",
        expectedEntityVersion: 1,
        claimId: claimed.claim.claimId,
        reason: "owner_stopped",
      }),
    ).rejects.toThrow(/evidence/i);
    await expect(
      claims.reclaim({
        schemaVersion: "1",
        eventId: "event-reclaim-stopped",
        expectedEntityVersion: 1,
        claimId: claimed.claim.claimId,
        reason: "owner_stopped",
        ownerStoppedEvidenceId: "process-exit:owner-1",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      entityVersion: 2,
      reclaimReason: "owner_stopped",
      evidenceId: "process-exit:owner-1",
    });
  });

  it("競合する別 instance の CAS は一方だけを受理する", async () => {
    const root = await repository();
    const first = store(root, () => "2026-08-02T00:00:00.000Z", ["claim-a"]);
    const second = store(root, () => "2026-08-02T00:00:00.000Z", ["claim-b"]);
    const results = await Promise.all([
      first.claim(acquire("event-a")),
      second.claim({
        ...acquire("event-b"),
        taskId: "fixture/repository#2",
        workspaceId: "workspace:2",
      }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toMatchObject([
      { code: "stale_entity_version" },
    ]);
  });

  it("dead owner を同時観測しても nonce-bound recovery claim の勝者だけが lock を retire する", async () => {
    const root = await repository();
    const lockPath = await coordinationLockPath(root);
    const deadPid = 2_147_483_647;
    const deadNonce = randomUUID();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        pid: deadPid,
        hostname: hostname(),
        nonce: deadNonce,
        startedAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
    );

    let observed = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolveBarrier) => {
      releaseBarrier = resolveBarrier;
    });
    const afterDeadOwnerObserved = async (ownerNonce: string) => {
      expect(ownerNonce).toBe(deadNonce);
      observed += 1;
      if (observed === 2) releaseBarrier();
      await barrier;
    };
    const contender = (claimId: string) =>
      new DispatchClaimStore(
        root,
        createDispatchClaimStoreDependencies({
          now: () => "2026-08-02T00:00:00.000Z",
          nextId: () => claimId,
          waitTimeoutMs: 2_000,
          isProcessAlive: (pid) => pid !== deadPid,
          afterDeadOwnerObserved,
          readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        }),
      );
    const results = await Promise.all([
      contender("claim-recovery-a").claim(acquire("recovery-a")),
      contender("claim-recovery-b").claim({
        ...acquire("recovery-b"),
        taskId: "fixture/repository#2",
        workspaceId: "workspace:2",
      }),
    ]);

    expect(observed).toBe(2);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toMatchObject([
      { code: "stale_entity_version", stateUnchanged: true },
    ]);
    await expect(new DispatchClaimStore(root).snapshot()).resolves.toMatchObject({
      entityVersion: 1,
      claims: [{}],
    });
  });

  it("O1 用 recovery marker が残って O2 が crash しても O3 が復旧して single CAS に収束する", async () => {
    const root = await repository();
    const lockPath = await coordinationLockPath(root);
    const deadPid = 2_147_483_647;
    const deadNonce = randomUUID();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        pid: deadPid,
        hostname: hostname(),
        nonce: deadNonce,
        startedAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
    );

    let resumeOld!: () => void;
    let oldWasResumed = false;
    const oldResumeBarrier = new Promise<void>((resolveBarrier) => {
      resumeOld = () => {
        oldWasResumed = true;
        resolveBarrier();
      };
    });
    let oldObserved!: () => void;
    const oldObservedBarrier = new Promise<void>((resolveObserved) => {
      oldObserved = resolveObserved;
    });
    let liveOwnerObserved!: (pid: number) => void;
    const liveOwnerObservedBarrier = new Promise<number>((resolveObserved) => {
      liveOwnerObserved = resolveObserved;
    });
    const oldContender = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-old-contender",
        waitTimeoutMs: 5_000,
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        isProcessAlive: (pid) => {
          if (pid === deadPid) return false;
          liveOwnerObserved(pid);
          return true;
        },
        afterDeadOwnerObserved: async (ownerNonce) => {
          expect(ownerNonce).toBe(deadNonce);
          oldObserved();
          await oldResumeBarrier;
        },
      }),
    );
    let oldSettled = false;
    const oldResultPromise = oldContender
      .claim({
        ...acquire("old-recovery-race"),
        expectedEntityVersion: 99,
        taskId: "fixture/repository#2",
        workspaceId: "workspace:old-contender",
      })
      .finally(() => {
        oldSettled = true;
      });
    await oldObservedBarrier;

    const workerPath = join(root, "lock-recovery-worker.ts");
    await writeFile(
      workerPath,
      `void (async () => {
const [moduleUrl, projectRoot, rawInput] = process.argv.slice(2);
const { DispatchClaimStore, createDispatchClaimStoreDependencies } = await import(moduleUrl);
const store = new DispatchClaimStore(projectRoot, createDispatchClaimStoreDependencies({
  now: () => "2026-08-02T00:00:00.000Z",
  nextId: () => "claim-child-process",
  readCurrentSnapshotFingerprint: async () => "d".repeat(64),
  beforeRegistryPublish: async () => {
    process.send?.({ type: "lock_acquired" });
    await new Promise((resolveRelease) => process.once("message", resolveRelease));
  },
}));
const result = await store.claim(JSON.parse(rawInput));
process.send?.({ type: "result", result });
process.disconnect?.();
})().catch((error) => {
  process.send?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
`,
    );
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dirname, "../store/dispatch-claims.ts"),
    ).href;
    const childInput = acquire("child-recovery-race");
    const child = fork(workerPath, [moduleUrl, root, JSON.stringify(childInput)], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const childExit = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    try {
      await waitForChildMessage(child, "lock_acquired");
      const liveOwner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
        pid: number;
        nonce: string;
      };
      expect(liveOwner).toMatchObject({ pid: child.pid });
      expect(liveOwner.nonce).not.toBe(deadNonce);

      resumeOld();
      await expect(liveOwnerObservedBarrier).resolves.toBe(child.pid);

      const ownerAfterOldRecovery = JSON.parse(
        await readFile(join(lockPath, "owner.json"), "utf8"),
      ) as { pid: number; nonce: string };
      expect(ownerAfterOldRecovery).toEqual(liveOwner);
      await expect(
        readFile(join(lockPath, `recovery-claim-${deadNonce}.json`), "utf8"),
      ).resolves.toContain(deadNonce);
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      expect(oldSettled).toBe(false);

      child.kill();
      await childExit;
      const recovered = new DispatchClaimStore(
        root,
        createDispatchClaimStoreDependencies({
          now: () => "2026-08-02T00:00:00.000Z",
          nextId: () => "claim-recovery-after-child-crash",
          waitTimeoutMs: 2_000,
          readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        }),
      );
      await expect(recovered.claim(childInput)).resolves.toMatchObject({
        accepted: true,
        entityVersion: 1,
      });

      await expect(oldResultPromise).resolves.toMatchObject({
        accepted: false,
        code: "stale_entity_version",
        stateUnchanged: true,
      });
      await expect(new DispatchClaimStore(root).snapshot()).resolves.toMatchObject({
        entityVersion: 1,
        claims: [{ claimId: "claim-recovery-after-child-crash" }],
      });
    } finally {
      if (!oldWasResumed) resumeOld();
      if (child.connected) child.send("release");
      if (child.exitCode === null) child.kill();
      await oldResultPromise.catch(() => undefined);
    }
  }, 10_000);

  it("recovery claimant が candidate 書込後・publish 前に crash しても後続 process が復旧する", async () => {
    const root = await repository();
    const lockPath = await coordinationLockPath(root);
    const deadPid = 2_147_483_647;
    const deadNonce = randomUUID();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        pid: deadPid,
        hostname: hostname(),
        nonce: deadNonce,
        startedAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
    );

    const workerPath = join(root, "recovery-claimant-crash-worker.ts");
    await writeFile(
      workerPath,
      `void (async () => {
const [moduleUrl, projectRoot, rawInput] = process.argv.slice(2);
const { DispatchClaimStore, createDispatchClaimStoreDependencies } = await import(moduleUrl);
const store = new DispatchClaimStore(projectRoot, createDispatchClaimStoreDependencies({
  now: () => "2026-08-02T00:00:00.000Z",
  nextId: () => "claim-crashed-recovery",
  readCurrentSnapshotFingerprint: async () => "d".repeat(64),
  afterRecoveryClaimCandidateWritten: async (expectedOwnerNonce, claimantNonce) => {
    process.send?.({ type: "recovery_candidate_written", expectedOwnerNonce, claimantNonce });
    await new Promise(() => undefined);
  },
}));
await store.claim(JSON.parse(rawInput));
})().catch((error) => {
  process.send?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
`,
    );
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dirname, "../store/dispatch-claims.ts"),
    ).href;
    const child = fork(workerPath, [moduleUrl, root, JSON.stringify(acquire("crashed-recovery"))], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const childExit = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    try {
      const created = await waitForChildMessage<{
        type: "recovery_candidate_written";
        expectedOwnerNonce: string;
        claimantNonce: string;
      }>(child, "recovery_candidate_written");
      expect(created.expectedOwnerNonce).toBe(deadNonce);
      const markerPath = join(lockPath, `recovery-claim-${deadNonce}.json`);
      const candidatePath = `${markerPath}.candidate-${created.claimantNonce}`;
      await expect(readFile(candidatePath, "utf8")).resolves.toContain(created.claimantNonce);
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      child.kill();
      await childExit;
      const recovered = new DispatchClaimStore(
        root,
        createDispatchClaimStoreDependencies({
          now: () => "2026-08-02T00:00:00.000Z",
          nextId: () => "claim-after-recovery-crash",
          waitTimeoutMs: 2_000,
          readCurrentSnapshotFingerprint: async () => "d".repeat(64),
        }),
      );
      await expect(recovered.claim(acquire("after-recovery-crash"))).resolves.toMatchObject({
        accepted: true,
        entityVersion: 1,
      });
      await expect(recovered.snapshot()).resolves.toMatchObject({
        entityVersion: 1,
        claims: [{ claimId: "claim-after-recovery-crash" }],
      });
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 10_000);

  it("dead owner 配下の malformed final marker は owner再検証後に安全に retire する", async () => {
    const root = await repository();
    const lockPath = await coordinationLockPath(root);
    const deadPid = 2_147_483_647;
    const deadNonce = randomUUID();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        pid: deadPid,
        hostname: hostname(),
        nonce: deadNonce,
        startedAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
    );
    await writeFile(join(lockPath, `recovery-claim-${deadNonce}.json`), '{"schemaVersion":');

    const recovered = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-after-malformed-marker",
        waitTimeoutMs: 2_000,
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
      }),
    );
    await expect(recovered.claim(acquire("after-malformed-marker"))).resolves.toMatchObject({
      accepted: true,
      entityVersion: 1,
      claim: { claimId: "claim-after-malformed-marker" },
    });
  });

  it("dead owner 配下の zero-byte final marker も malformed として安全に retire する", async () => {
    const root = await repository();
    const lockPath = await coordinationLockPath(root);
    const deadPid = 2_147_483_647;
    const deadNonce = randomUUID();
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        pid: deadPid,
        hostname: hostname(),
        nonce: deadNonce,
        startedAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
    );
    await writeFile(join(lockPath, `recovery-claim-${deadNonce}.json`), "");

    const recovered = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-after-zero-byte-marker",
        waitTimeoutMs: 500,
        readCurrentSnapshotFingerprint: async () => "d".repeat(64),
      }),
    );
    await expect(recovered.claim(acquire("after-zero-byte-marker"))).resolves.toMatchObject({
      accepted: true,
      entityVersion: 1,
      claim: { claimId: "claim-after-zero-byte-marker" },
    });
  });

  it("atomic publish 前の crash は registry state を変更せず lock を解放する", async () => {
    const root = await repository();
    const interrupted = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({
        now: () => "2026-08-02T00:00:00.000Z",
        nextId: () => "claim-crash",
        beforeRegistryPublish: async () => {
          throw new Error("simulated crash");
        },
      }),
    );

    await expect(interrupted.claim(acquire("event-crash"))).rejects.toThrow("simulated crash");
    await expect(new DispatchClaimStore(root).snapshot()).resolves.toMatchObject({
      entityVersion: 0,
      claims: [],
      history: [],
    });
    await expect(
      store(root, () => "2026-08-02T00:00:00.000Z").claim(acquire("event-after-crash")),
    ).resolves.toMatchObject({ accepted: true, entityVersion: 1 });
  });
});
