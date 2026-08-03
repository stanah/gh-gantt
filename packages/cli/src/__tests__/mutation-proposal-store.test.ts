import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  mutationCommandFingerprint,
  type MutationProposal,
  type MutationProposalReceipt,
} from "@gh-gantt/shared";
import { MutationProposalStore } from "../store/mutation-proposals.js";
import {
  DispatchClaimStore,
  createDispatchClaimStoreDependencies,
} from "../store/dispatch-claims.js";
import type { RepositoryCoordinationLayout } from "../store/repository-coordination-layout.js";
import { gitFixtureEnvironment } from "./git-fixture.js";

const execFileAsync = promisify(execFile);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function proposal(): MutationProposal {
  return {
    schemaVersion: "1",
    proposalId: "proposal-cas",
    revision: 1,
    status: "approved",
    commandId: "propose-cas",
    commandFingerprint: "a".repeat(64),
    sourceRevision: "source-1",
    snapshotFingerprint: "b".repeat(64),
    proposeCoverageFingerprint: "c".repeat(64),
    planFingerprint: "d".repeat(64),
    policyFingerprint: null,
    origin: {
      runId: "run-cas",
      workspaceId: "workspace:cas",
      taskId: "example/public#331",
      repository: "example/public",
      planId: "plan",
      planVersion: "1",
      authorityId: "authority",
      mutationCheckpointId: "checkpoint",
    },
    intent: { kind: "cancel", targetTaskId: "example/public#331", reason: "不要" },
    targetTaskIds: ["example/public#331"],
    evidence: [],
    diff: [],
    affectedUpstream: [],
    affectedDownstream: [],
    risk: "destructive",
    proposedBy: { id: "planner", role: "planner" },
    approval: {
      kind: "human",
      actor: { id: "U_PUBLIC", role: "human" },
      evidenceId: "evidence",
      decidedAt: "2026-08-02T00:00:00.000Z",
    },
    approvalCommentRef: {
      repository: "example/public",
      issueNumber: 331,
      commentId: "IC_PUBLIC",
    },
    trustedApproval: {
      decision: "approve",
      boundRevision: 1,
      boundProposalFingerprint: "d".repeat(64),
      boundExpiresAt: "2026-08-03T00:00:00.000Z",
      boundPurpose: "decision",
      boundStepId: null,
      boundTargetRunId: null,
      boundTargetProjectRoot: null,
      boundSuccessorDescriptorFingerprint: null,
      authorNodeId: "U_PUBLIC",
      commentId: "IC_PUBLIC",
      bodyHash: "e".repeat(64),
      commentUpdatedAt: "2026-08-02T00:00:00.000Z",
      authorityConfigFingerprint: "f".repeat(64),
    },
    steps: [
      {
        stepId: "step-0001",
        operation: "cancel",
        targetTaskId: "example/public#331",
        payload: {},
        beforeImage: {},
        expectedPostcondition: { state: "closed" },
        state: "not_started",
        diagnostic: null,
        remoteIdentifiers: null,
        correlationToken: null,
        recoveryIntent: { kind: "reopen_cancelled_task", beforeFingerprint: "1".repeat(64) },
      },
    ],
    logicalTaskIds: {},
    successorProposalId: null,
    applyCoverageFingerprint: null,
    applyBaseline: null,
    invalidationTargets: [],
    pendingAuditEventIds: [],
    pendingAudits: [],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    expiresAt: "2026-08-03T00:00:00.000Z",
  };
}

function receipt(commandId: string, current: MutationProposal): MutationProposalReceipt {
  return {
    schemaVersion: "1",
    accepted: true,
    commandId,
    commandFingerprint: mutationCommandFingerprint({ commandId }),
    proposalId: current.proposalId,
    revision: current.revision,
    status: current.status,
    stateUnchanged: false,
    errorCode: null,
    diagnostic: null,
    changedTaskIds: [],
    successorPlanRevision: null,
  };
}

describe("[NFR-STABILITY-014-AC8] mutation proposal storeのCAS", () => {
  it("空のownerless legacy LOCKはatomic candidate publishで安全に置換する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-ownerless-lock-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    await mkdir(join(layout.mutationProposalRoot, "LOCK"), { recursive: true });
    const store = new MutationProposalStore(root, { resolveLayout: async () => layout });

    await expect(store.readAll()).resolves.toMatchObject({
      projectIdentity: layout.projectIdentity,
      revision: 0,
    });
  });

  it("内容を持つownerless legacy LOCKは推測で削除せずtyped errorでfail-closedにする", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-ownerless-lock-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const lockPath = join(layout.mutationProposalRoot, "LOCK");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "partial-owner.tmp"), "incomplete\n");
    const store = new MutationProposalStore(root, {
      resolveLayout: async () => layout,
      waitTimeoutMs: 0,
    });

    await expect(store.readAll()).rejects.toMatchObject({
      name: "MutationProposalLockError",
      code: "ownerless_lock",
    });
  });

  it.each(["", '{"schemaVersion":'])(
    "破損したowner.json (%s) はgeneric busyへ潰さずtyped errorにする",
    async (rawOwner) => {
      const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-corrupt-lock-"));
      const layout: RepositoryCoordinationLayout = {
        projectRoot: root,
        projectIdentity: "example/public#1",
        projectKey: "public",
        commonDir: root,
        canonicalWorkspaceId: "workspace:cas",
        linkedWorktrees: [root],
        linkedProjectRoots: [root],
        claimRoot: join(root, "claims"),
        mutationProposalRoot: join(root, "proposals"),
        config: {} as RepositoryCoordinationLayout["config"],
      };
      const lockPath = join(layout.mutationProposalRoot, "LOCK");
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, "owner.json"), rawOwner);
      const store = new MutationProposalStore(root, {
        resolveLayout: async () => layout,
        waitTimeoutMs: 0,
      });

      await expect(store.readAll()).rejects.toMatchObject({
        name: "MutationProposalLockError",
        code: "corrupt_lock_owner",
      });
    },
  );

  it("dead ownerを同時観測しても世代bound recovery winnerだけがLOCKをretireする", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-lock-recovery-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const deadPid = 2_147_483_647;
    const deadNonce = randomUUID();
    const lockPath = join(layout.mutationProposalRoot, "LOCK");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        pid: deadPid,
        hostname: hostname(),
        nonce: deadNonce,
        acquiredAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
    );
    let observed = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolveBarrier) => {
      releaseBarrier = resolveBarrier;
    });
    const makeStore = () =>
      new MutationProposalStore(root, {
        resolveLayout: async () => layout,
        isProcessAlive: (pid) => pid !== deadPid,
        afterDeadOwnerObserved: async (ownerNonce) => {
          expect(ownerNonce).toBe(deadNonce);
          observed += 1;
          if (observed === 2) releaseBarrier();
          await barrier;
        },
      });

    const registries = await Promise.all([makeStore().readAll(), makeStore().readAll()]);

    expect(observed).toBe(2);
    expect(registries).toEqual([
      expect.objectContaining({ projectIdentity: layout.projectIdentity, revision: 0 }),
      expect.objectContaining({ projectIdentity: layout.projectIdentity, revision: 0 }),
    ]);
  });

  it("最終検証後に停止したlive recovery winnerを後続contenderが奪取しない", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-live-recovery-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const deadPid = 2_147_483_647;
    const deadNonce = randomUUID();
    const lockPath = join(layout.mutationProposalRoot, "LOCK");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        pid: deadPid,
        hostname: hostname(),
        nonce: deadNonce,
        acquiredAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
    );
    let validated!: () => void;
    const validatedBarrier = new Promise<void>((resolveValidated) => {
      validated = resolveValidated;
    });
    let resume!: () => void;
    const resumeBarrier = new Promise<void>((resolveResume) => {
      resume = resolveResume;
    });
    const first = new MutationProposalStore(root, {
      resolveLayout: async () => layout,
      isProcessAlive: (pid) => pid !== deadPid,
      afterRecoveryClaimValidated: async (expectedOwnerNonce) => {
        expect(expectedOwnerNonce).toBe(deadNonce);
        validated();
        await resumeBarrier;
      },
    });
    const firstRead = first.readAll();
    await validatedBarrier;

    try {
      const contender = new MutationProposalStore(root, {
        resolveLayout: async () => layout,
        isProcessAlive: (pid) => pid !== deadPid,
        waitTimeoutMs: 0,
      });
      await expect(contender.readAll()).rejects.toThrow("mutation proposal store は使用中です");
    } finally {
      resume();
    }
    await expect(firstRead).resolves.toMatchObject({
      projectIdentity: layout.projectIdentity,
      revision: 0,
    });
  });

  it("2 process相当のapply reservationは単一lock transactionで一方だけ勝つ", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-cas-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const makeStore = () =>
      new MutationProposalStore(root, {
        resolveLayout: async () => layout,
      });
    const initial = proposal();
    await makeStore().recordReceipt(initial, receipt("propose-cas", initial), {
      expectedProposalRevision: null,
    });
    const candidates = ["apply-a", "apply-b"].map((commandId) => {
      const candidate = structuredClone(initial);
      candidate.revision = 2;
      candidate.status = "applying";
      return makeStore().recordReceipt(candidate, receipt(commandId, candidate), {
        expectedProposalRevision: 1,
        allowedStatuses: ["approved"],
      });
    });

    const results = await Promise.all(candidates);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const registry = await makeStore().readAll();
    expect(registry.proposals[0]).toMatchObject({ revision: 2, status: "applying" });
    expect(
      registry.commandReceipts.filter((item) => item.commandId.startsWith("apply-")),
    ).toHaveLength(1);
  });

  it("同じapply commandの2 process相当実行はowner leaseとstep fencingで一方だけがremoteへ進める", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-owner-lease-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const makeStore = () =>
      new MutationProposalStore(root, {
        resolveLayout: async () => layout,
        now: () => "2026-08-02T00:00:00.000Z",
      });
    const applying = proposal();
    applying.status = "applying";
    await makeStore().recordReceipt(applying, receipt("apply-owner", applying), {
      expectedProposalRevision: null,
    });

    const claims = await Promise.all([
      makeStore().claimApplication({
        proposalId: applying.proposalId,
        commandId: "apply-owner",
        commandFingerprint: mutationCommandFingerprint({ commandId: "apply-owner" }),
        ownerNonce: "11111111-1111-4111-8111-111111111111",
        leaseDurationSeconds: 60,
      }),
      makeStore().claimApplication({
        proposalId: applying.proposalId,
        commandId: "apply-owner",
        commandFingerprint: mutationCommandFingerprint({ commandId: "apply-owner" }),
        ownerNonce: "22222222-2222-4222-8222-222222222222",
        leaseDurationSeconds: 60,
      }),
    ]);

    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.ok)).toMatchObject([
      { code: "application_in_progress" },
    ]);
    const winner = claims.find((claim) => claim.ok);
    if (!winner?.ok) throw new Error("application owner lease winner が必要です");
    await expect(
      makeStore().fenceApplication({
        lease: winner.lease,
        stepId: "step-0001",
        leaseDurationSeconds: 60,
      }),
    ).resolves.toMatchObject({
      ok: true,
      lease: { stepId: "step-0001", fencingToken: winner.lease.fencingToken + 1 },
    });
  });

  it("60秒超過後のnew application ownerがold ownerのpublishをproduction CASでfenceする", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-owner-takeover-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    let currentTime = "2026-08-02T00:00:00.000Z";
    const store = new MutationProposalStore(root, {
      resolveLayout: async () => layout,
      now: () => currentTime,
    });
    const applying = proposal();
    applying.status = "applying";
    await store.recordReceipt(applying, receipt("apply-takeover", applying), {
      expectedProposalRevision: null,
    });
    const oldOwner = await store.claimApplication({
      proposalId: applying.proposalId,
      commandId: "apply-takeover",
      commandFingerprint: mutationCommandFingerprint({ commandId: "apply-takeover" }),
      ownerNonce: "11111111-1111-4111-8111-111111111111",
      leaseDurationSeconds: 60,
    });
    if (!oldOwner.ok) throw new Error("old owner fixture failed");
    const oldFence = await store.fenceApplication({
      lease: oldOwner.lease,
      stepId: "step-0001",
      leaseDurationSeconds: 60,
    });
    if (!oldFence.ok) throw new Error("old fence fixture failed");

    currentTime = "2026-08-02T00:01:01.000Z";
    const newOwner = await store.claimApplication({
      proposalId: applying.proposalId,
      commandId: "apply-takeover",
      commandFingerprint: mutationCommandFingerprint({ commandId: "apply-takeover" }),
      ownerNonce: "22222222-2222-4222-8222-222222222222",
      leaseDurationSeconds: 60,
    });
    expect(newOwner).toMatchObject({ ok: true, lease: { fencingToken: 3 } });
    await expect(store.assertApplication(oldFence.lease)).rejects.toThrow("stale_application");
    if (!newOwner.ok) throw new Error("new owner fixture failed");
    await expect(store.assertApplication(newOwner.lease)).resolves.toEqual(newOwner.lease);
  });

  it("journal lock待機中に期限切れreservationをtakeoverすると旧ownerのstep CASを拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-journal-takeover-"));
    await execFileAsync("git", ["init", root], { env: gitFixtureEnvironment() });
    await mkdir(join(root, ".gantt-sync"), { recursive: true });
    await writeFile(
      join(root, ".gantt-sync", "gantt.config.json"),
      `${JSON.stringify(
        {
          version: "1",
          project: {
            name: "公開fixture",
            github: { owner: "example", repo: "public", project_number: 1 },
          },
          sync: {
            auto_create_issues: false,
            field_mapping: { start_date: "Start", end_date: "End" },
          },
          task_types: {
            task: { label: "Task", display: "bar", color: "#000", github_label: "task" },
          },
          type_hierarchy: { task: [] },
          statuses: { field_name: "Status", values: {} },
          gantt: {
            default_view: "month",
            working_days: [1, 2, 3, 4, 5],
            colors: {
              critical_path: "#000",
              on_track: "#000",
              at_risk: "#000",
              overdue: "#000",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    let now = "2026-08-02T00:00:00.000Z";
    const store = new MutationProposalStore(root, { now: () => now });
    const claimStore = new DispatchClaimStore(
      root,
      createDispatchClaimStoreDependencies({ now: () => now }),
    );
    const applying = proposal();
    applying.status = "applying";
    await store.recordReceipt(applying, receipt("apply-journal", applying), {
      expectedProposalRevision: null,
    });
    const oldApplication = await store.claimApplication({
      proposalId: applying.proposalId,
      commandId: "apply-journal",
      commandFingerprint: mutationCommandFingerprint({ commandId: "apply-journal" }),
      ownerNonce: "11111111-1111-4111-8111-111111111111",
      leaseDurationSeconds: 120,
    });
    if (!oldApplication.ok) throw new Error("旧application owner fixtureを取得できません");
    const oldReservation = await claimStore.reserveMutation({
      proposalId: applying.proposalId,
      ownerNonce: oldApplication.lease.ownerNonce,
      expectedEntityVersion: 0,
      affectedTaskIds: applying.targetTaskIds,
      leaseDurationSeconds: 60,
    });
    if (!oldReservation.accepted) throw new Error("旧reservation fixtureを取得できません");

    const holderReady = deferred();
    const releaseHolder = deferred();
    const holder = store.mutate(async () => {
      holderReady.resolve();
      await releaseHolder.promise;
    });
    await holderReady.promise;
    const recordAttempted = deferred();
    const waitingStore = new MutationProposalStore(root, {
      now: () => now,
      beforeRecordLockAcquire: async () => recordAttempted.resolve(),
    });
    const candidate = structuredClone(applying);
    candidate.revision += 1;
    candidate.steps[0]!.state = "committed";
    const oldPublish = waitingStore.recordReceipt(candidate, receipt("apply-journal", candidate), {
      expectedProposalRevision: applying.revision,
      allowedStatuses: ["applying"],
      applicationLease: oldApplication.lease,
      mutationReservation: oldReservation.reservation,
      withMutationReservation: claimStore.withMutationReservation.bind(claimStore),
    });
    await recordAttempted.promise;
    now = "2026-08-02T00:01:01.000Z";
    const newReservation = await claimStore.reserveMutation({
      proposalId: applying.proposalId,
      ownerNonce: "22222222-2222-4222-8222-222222222222",
      expectedEntityVersion: oldReservation.entityVersion,
      affectedTaskIds: applying.targetTaskIds,
      leaseDurationSeconds: 120,
    });
    if (!newReservation.accepted) throw new Error("新reservation fixtureを取得できません");
    releaseHolder.resolve();
    await holder;
    await expect(oldPublish).rejects.toThrow("stale_mutation_reservation");
    await expect(store.get(applying.proposalId)).resolves.toMatchObject({
      revision: applying.revision,
      steps: [{ state: "not_started" }],
    });

    now = "2026-08-02T00:02:01.000Z";
    const newApplication = await store.claimApplication({
      proposalId: applying.proposalId,
      commandId: "apply-journal",
      commandFingerprint: mutationCommandFingerprint({ commandId: "apply-journal" }),
      ownerNonce: newReservation.reservation.ownerNonce,
      leaseDurationSeconds: 60,
    });
    if (!newApplication.ok) throw new Error("新application owner fixtureを取得できません");
    await expect(
      store.recordReceipt(candidate, receipt("apply-journal", candidate), {
        expectedProposalRevision: applying.revision,
        allowedStatuses: ["applying"],
        applicationLease: newApplication.lease,
        mutationReservation: newReservation.reservation,
        withMutationReservation: claimStore.withMutationReservation.bind(claimStore),
      }),
    ).resolves.toEqual({ ok: true });
    await expect(store.get(applying.proposalId)).resolves.toMatchObject({
      revision: candidate.revision,
      steps: [{ state: "committed" }],
    });
  });

  it("同じcommandIdの異なるfingerprintを単一transaction内で拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-command-cas-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const store = new MutationProposalStore(root, { resolveLayout: async () => layout });
    const initial = proposal();
    await store.recordReceipt(initial, receipt("same-command", initial), {
      expectedProposalRevision: null,
    });
    const mismatched = receipt("same-command", initial);
    mismatched.commandFingerprint = "9".repeat(64);
    const result = await store.recordReceipt(initial, mismatched, {
      expectedProposalRevision: 1,
    });
    expect(result).toMatchObject({ ok: false, code: "command_payload_mismatch" });
  });

  it("compensatedからaccept_replan予約へproduction store CASで遷移できる", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-compensated-replan-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const store = new MutationProposalStore(root, { resolveLayout: async () => layout });
    const compensated = proposal();
    compensated.status = "compensated";
    await store.recordReceipt(compensated, receipt("compensated", compensated), {
      expectedProposalRevision: null,
    });
    const accepting = structuredClone(compensated);
    accepting.revision += 1;
    accepting.status = "accepting_replan";
    const result = await store.recordReceipt(accepting, receipt("accept-replan", accepting), {
      expectedProposalRevision: compensated.revision,
      allowedStatuses: ["applied", "compensated"],
    });
    expect(result).toEqual({ ok: true });
    await expect(store.get(compensated.proposalId)).resolves.toMatchObject({
      revision: accepting.revision,
      status: "accepting_replan",
    });
  });

  it("同じpropose commandの並行retryは異なるproposalIdを増殖させない", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-proposal-create-cas-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      commonDir: root,
      canonicalWorkspaceId: "workspace:cas",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      config: {} as RepositoryCoordinationLayout["config"],
    };
    const makeStore = () =>
      new MutationProposalStore(root, {
        resolveLayout: async () => layout,
      });
    const left = proposal();
    const right = { ...proposal(), proposalId: "proposal-cas-other" };
    const leftReceipt = receipt("same-propose", left);
    const rightReceipt = { ...receipt("same-propose", right), proposalId: right.proposalId };
    const results = await Promise.all([
      makeStore().recordReceipt(left, leftReceipt, { expectedProposalRevision: null }),
      makeStore().recordReceipt(right, rightReceipt, { expectedProposalRevision: null }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const registry = await makeStore().readAll();
    expect(registry.proposals).toHaveLength(1);
    expect(registry.commandReceipts).toHaveLength(1);
  });
});
