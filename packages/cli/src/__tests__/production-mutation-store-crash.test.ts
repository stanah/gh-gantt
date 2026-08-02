import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { Config, SyncState, Task, TasksFile } from "@gh-gantt/shared";
import { MutationProposalStore } from "../store/mutation-proposals.js";
import {
  DispatchClaimStore,
  createDispatchClaimStoreDependencies,
} from "../store/dispatch-claims.js";
import type { RepositoryCoordinationLayout } from "../store/repository-coordination-layout.js";
import { WorkGraphCommandEngine } from "../work-graph/command-engine.js";
import { MutationProposalControlPlane } from "../work-graph/mutation-control-plane.js";
import { ProductionMutationEnvironment } from "../work-graph/production-mutation-environment.js";
import type { MutationProposalEnvironment } from "../work-graph/mutation-control-plane.js";
import { gitFixtureEnvironment } from "./git-fixture.js";

const execFileAsync = promisify(execFile);

const timestamp = "2026-08-02T00:00:00.000Z";

const config: Config = {
  version: "1",
  project: { name: "公開fixture", github: { owner: "example", repo: "public", project_number: 1 } },
  sync: { auto_create_issues: true, field_mapping: { start_date: "Start", end_date: "End" } },
  task_types: {
    epic: { label: "Epic", display: "summary", color: "#000", github_label: "epic" },
    task: { label: "Task", display: "bar", color: "#111", github_label: "task" },
  },
  type_hierarchy: { epic: ["task"], task: [] },
  statuses: { field_name: "Status", values: {} },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
  mutation_policy: {
    schema_version: "1",
    policy_id: "public-policy",
    version: "1",
    rules: [
      {
        id: "bounded-add",
        mutation_kinds: ["add"],
        repositories: ["example/public"],
        root_task_ids: ["example/public#331"],
        task_types: ["task", "epic"],
        max_operations: 1,
        max_affected_tasks: 2,
        max_risk: "low",
      },
    ],
  },
};

const parent: Task = {
  id: "example/public#331",
  type: "epic",
  github_issue: 331,
  github_repo: "example/public",
  parent: null,
  sub_tasks: [],
  title: "Graph engineering",
  body: null,
  acceptance_criteria: [],
  state: "open",
  state_reason: null,
  assignees: [],
  labels: ["epic"],
  milestone: null,
  linked_prs: [],
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
};

describe("[NFR-STABILITY-014-AC8] 本番storeのcrash復旧", () => {
  it("proposal preparation永続化直後のcrashをreal storeから再構築してexact retryする", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-production-crash-"));
    const layout: RepositoryCoordinationLayout = {
      projectRoot: root,
      commonDir: root,
      projectIdentity: "example/public#1",
      projectKey: "public",
      claimRoot: join(root, "claims"),
      mutationProposalRoot: join(root, "proposals"),
      canonicalWorkspaceId: "workspace:fixture",
      linkedWorktrees: [root],
      linkedProjectRoots: [root],
      config,
    };
    const store = new MutationProposalStore(root, {
      resolveLayout: async () => layout,
      now: () => timestamp,
    });
    let tasksFile: TasksFile = {
      tasks: [structuredClone(parent)],
      cache: { comments: {}, reactions: {} },
    };
    let syncState: SyncState = {
      last_synced_at: "revision-1",
      project_node_id: "PVT_PUBLIC",
      id_map: {},
      field_ids: {},
      snapshots: {},
    };
    const storageRunner = async (
      _root: string,
      _options: unknown,
      operation: (storage: any) => any,
    ) =>
      operation({
        configStore: { read: async () => config },
        tasksStore: {
          read: async () => structuredClone(tasksFile),
          write: async (next: TasksFile) => {
            tasksFile = structuredClone(next);
          },
        },
        stateStore: {
          read: async () => structuredClone(syncState),
          write: async (next: SyncState) => {
            syncState = structuredClone(next);
          },
        },
        flush: async () => undefined,
      });
    const pushExecutor = vi.fn(async (_gql, _config, preparedTasks, preparedState, options) => {
      await options.saveProgress(preparedTasks, preparedState);
      await options.onStepOutcome({
        stepId: options.reservations[0].stepId,
        operation: "create",
        state: "committed",
        diagnostic: null,
        remoteIdentifiers: {
          issueId: "I_PUBLIC_400",
          issueNumber: 400,
          projectItemId: "ITEM_PUBLIC_400",
        },
      });
      return {
        tasksFile: preparedTasks,
        syncState: preparedState,
        stepOutcomes: [
          {
            stepId: options.reservations[0].stepId,
            operation: "create",
            state: "committed",
            diagnostic: null,
            remoteIdentifiers: {
              issueId: "I_PUBLIC_400",
              issueNumber: 400,
              projectItemId: "ITEM_PUBLIC_400",
            },
          },
        ],
      };
    });
    const inspector = {
      async resolveOrigin(runId: string) {
        return {
          ok: true as const,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: parent.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "checkpoint",
            mutationCheckpointId: "checkpoint",
          },
          coverageFingerprint: "a".repeat(64),
        };
      },
      async validateApply() {
        return { ok: true as const, coverageFingerprint: "a".repeat(64), affectedRuns: [] };
      },
    };
    const environment = new ProductionMutationEnvironment(
      root,
      new WorkGraphCommandEngine(config, { now: () => timestamp }),
      {
        inspector: inspector as never,
        storageRunner: storageRunner as never,
        createGraphQLClient: async () => (async () => ({})) as never,
        pushExecutor: pushExecutor as never,
        runControlPlane: { applyMutationAudit: async () => ({ accepted: true }) } as never,
        now: () => timestamp,
        applicationStore: {
          async assertApplication(lease: unknown) {
            return lease;
          },
          async withApplicationLease(
            _lease: unknown,
            operation: (assertCurrent: () => void) => Promise<unknown>,
          ) {
            return operation(() => undefined);
          },
        } as never,
        claimStore: {
          async reserveMutation(input: any) {
            return {
              accepted: true,
              entityVersion: 1,
              reservation: {
                proposalId: input.proposalId,
                ownerNonce: input.ownerNonce,
                fencingToken: 1,
                affectedTaskIds: input.affectedTaskIds,
                expiresAt: "2026-08-02T01:00:00.000Z",
                sideEffectState: "idle",
              },
            };
          },
          async beginMutationSideEffect(proof: any) {
            return {
              ...proof,
              fencingToken: proof.fencingToken + 1,
              sideEffectState: "in_flight",
            };
          },
          async completeMutationSideEffect(proof: any) {
            return {
              ...proof,
              fencingToken: proof.fencingToken + 1,
              sideEffectState: "idle",
            };
          },
          async assertMutationReservation(proof: unknown) {
            return proof;
          },
          async withMutationReservation(_proof: unknown, operation: () => Promise<unknown>) {
            return operation();
          },
          async releaseMutationReservation() {
            return true;
          },
        } as never,
      },
    );
    const control = new MutationProposalControlPlane(
      store,
      new WorkGraphCommandEngine(config, { now: () => timestamp }),
      environment,
      {
        now: () => timestamp,
        nextId: () => "proposal-production-crash",
        afterPreparationPersisted: async () => {
          throw new Error("simulated process crash after proposal preparation persistence");
        },
      },
    );
    const proposed = await control.execute({
      schemaVersion: "1",
      commandId: "propose-production-crash",
      type: "propose",
      actor: { id: "planner", role: "planner" },
      originRunId: "run-production-crash",
      intent: {
        kind: "add",
        parentTaskId: parent.id,
        task: { clientId: "child", title: "追加task", type: "task" },
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    expect(proposed).toMatchObject({ accepted: true, status: "approved" });
    const applyCommand = {
      schemaVersion: "1" as const,
      commandId: "apply-production-crash",
      type: "apply" as const,
      actor: { id: "orchestrator", role: "orchestrator" as const },
      proposalId: "proposal-production-crash",
      expectedRevision: proposed.revision,
    };
    await expect(control.execute(applyCommand)).rejects.toThrow("simulated process crash");
    const durable = await store.get("proposal-production-crash");
    expect(durable?.steps[0]).toMatchObject({
      state: "not_started",
      diagnostic: null,
      localPreparation: {
        sourceRevision: "revision-1",
        sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        preparedFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        preparedAt: timestamp,
      },
    });
    expect(durable?.status).toBe("applying");
    expect(tasksFile.tasks).toEqual([parent]);
    expect(pushExecutor).not.toHaveBeenCalled();
    const reconstructed = new MutationProposalControlPlane(
      store,
      new WorkGraphCommandEngine(config, { now: () => timestamp }),
      environment,
      { now: () => timestamp, nextId: () => "unused" },
    );
    await expect(reconstructed.execute(applyCommand)).resolves.toMatchObject({
      accepted: true,
      status: "applied",
    });
    expect(pushExecutor).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["phase CAS直後", "afterReconcilePhasePersisted", "unknown", 1],
    ["reservation takeover直後", "afterReconcileReservationPersisted", "unknown", 1],
    ["live観測後step CAS前", "afterReconciliationObserved", "unknown", 2],
    ["step CAS直後", "afterReconciliationPersisted", "reconciled", 1],
  ] as const)(
    "reconcileの%s crashをreal storesから再開しreservationを解放する",
    async (_label, crashPoint, durableStepState, expectedReconcileCalls) => {
      const root = await mkdtemp(join(tmpdir(), "gh-gantt-reconcile-crash-"));
      await execFileAsync("git", ["init", root], { env: gitFixtureEnvironment() });
      await mkdir(join(root, ".gantt-sync"), { recursive: true });
      const liveConfig: Config = {
        ...config,
        statuses: { field_name: "Status", values: { Todo: { color: "#000", done: false } } },
        dispatch: { max_concurrency: 1 },
      };
      await writeFile(
        join(root, ".gantt-sync", "gantt.config.json"),
        `${JSON.stringify(liveConfig, null, 2)}\n`,
      );
      let now = timestamp;
      const proposalStore = new MutationProposalStore(root, { now: () => now });
      const claimStore = new DispatchClaimStore(
        root,
        createDispatchClaimStoreDependencies({ now: () => now }),
      );
      let reconcileCalls = 0;
      const environment: MutationProposalEnvironment = {
        mutationCoordination: {
          async reserveMutation(proposal, expectedEntityVersion, ownerNonce) {
            return claimStore.reserveMutation({
              proposalId: proposal.proposalId,
              ownerNonce,
              expectedEntityVersion,
              affectedTaskIds: [proposal.origin.taskId, ...proposal.targetTaskIds],
              leaseDurationSeconds: 60,
            });
          },
          async beginMutationSideEffect(proof) {
            return claimStore.beginMutationSideEffect(proof);
          },
          async completeMutationSideEffect(proof) {
            return claimStore.completeMutationSideEffect(proof);
          },
          async releaseMutationReservation(proof) {
            return claimStore.releaseMutationReservation(proof);
          },
          async withMutationReservation(proof, operation) {
            return claimStore.withMutationReservation(proof, operation);
          },
        },
        async loadSnapshot() {
          return {
            config: liveConfig,
            tasks: [parent],
            sourceRevision: "revision-reconcile-crash",
            snapshotFingerprint: "a".repeat(64),
            syncConflicts: false,
          };
        },
        async resolveOrigin(runId) {
          return {
            ok: true,
            origin: {
              runId,
              workspaceId: "workspace:fixture",
              taskId: parent.id,
              repository: "example/public",
              planId: "dev-role-fixed",
              planVersion: "1",
              authorityId: "checkpoint",
              mutationCheckpointId: "checkpoint",
            },
          };
        },
        async validateApply() {
          return {
            ok: true,
            coverageFingerprint: "b".repeat(64),
            claimEntityVersion: (await claimStore.snapshot()).entityVersion,
          };
        },
        async verifyHumanApproval() {
          return { ok: false, code: "human_gate_required", diagnostic: "未使用" };
        },
        async executeStep() {
          return { state: "unknown", diagnostic: "応答境界で停止" };
        },
        async reconcileStep() {
          reconcileCalls += 1;
          return {
            state: "reconciled",
            diagnostic: null,
            resolvedTaskId: "example/public#400",
            remoteIdentifiers: { issueId: "I_PUBLIC_400", issueNumber: 400 },
          };
        },
        async appendAudit() {},
      };
      const engine = new WorkGraphCommandEngine(liveConfig, { now: () => now });
      const crashing = new MutationProposalControlPlane(proposalStore, engine, environment, {
        now: () => now,
        nextId: () => "proposal-reconcile-crash",
        [crashPoint]: async () => {
          throw new Error(`reconcile crash: ${crashPoint}`);
        },
      });
      const proposed = await crashing.execute({
        schemaVersion: "1",
        commandId: "propose-reconcile-crash",
        type: "propose",
        actor: { id: "planner", role: "planner" },
        originRunId: "run-reconcile-crash",
        intent: {
          kind: "add",
          parentTaskId: parent.id,
          task: { clientId: "child", title: "追加task", type: "task" },
        },
        evidence: [],
        expiresAt: "2026-08-02T00:00:30.000Z",
      });
      const partial = await crashing.execute({
        schemaVersion: "1",
        commandId: "apply-reconcile-crash",
        type: "apply",
        actor: { id: "orchestrator", role: "orchestrator" },
        proposalId: "proposal-reconcile-crash",
        expectedRevision: proposed.revision,
      });
      expect(partial).toMatchObject({ accepted: false, status: "partially_applied" });
      now = "2026-08-02T00:01:01.000Z";
      const reconcileCommand = {
        schemaVersion: "1" as const,
        commandId: "reconcile-crash",
        type: "reconcile" as const,
        actor: { id: "orchestrator", role: "orchestrator" as const },
        proposalId: "proposal-reconcile-crash",
        expectedRevision: partial.revision,
        stepId: "step-0001",
        resolution: "confirm_committed" as const,
        evidence: {
          id: "evidence-reconcile-crash",
          kind: "side_effect_reconciliation" as const,
          source: "github-live-query",
          summary: "exact postcondition",
          observedAt: now,
          sideEffectState: "reconciled" as const,
        },
      };
      await expect(crashing.execute(reconcileCommand)).rejects.toThrow(
        `reconcile crash: ${crashPoint}`,
      );
      expect(await proposalStore.get("proposal-reconcile-crash")).toMatchObject({
        status: "reconciling",
        steps: [{ state: durableStepState, remoteExecution: { state: "side_effect_in_flight" } }],
      });
      expect((await claimStore.snapshot()).mutationReservations).toEqual([
        expect.objectContaining({ sideEffectState: "in_flight" }),
      ]);

      now = "2026-08-02T00:02:02.000Z";
      const resumed = new MutationProposalControlPlane(proposalStore, engine, environment, {
        now: () => now,
        nextId: () => "unused",
      });
      const reconciled = await resumed.execute(reconcileCommand);
      expect(reconciled).toMatchObject({ accepted: true, status: "approved" });
      expect(reconcileCalls).toBe(expectedReconcileCalls);
      expect((await claimStore.snapshot()).mutationReservations).toEqual([]);

      const successor = await resumed.execute({
        schemaVersion: "1",
        commandId: "propose-successor",
        type: "propose",
        actor: { id: "planner", role: "planner" },
        originRunId: "run-reconcile-crash",
        intent: {
          kind: "add",
          parentTaskId: parent.id,
          task: { clientId: "successor", title: "後続task", type: "task" },
        },
        evidence: [],
        expiresAt: "2026-08-03T00:00:00.000Z",
      });
      const supersededSource = await resumed.execute({
        schemaVersion: "1",
        commandId: "propose-superseded-source",
        type: "propose",
        actor: { id: "planner", role: "planner" },
        originRunId: "run-reconcile-crash",
        intent: {
          kind: "add",
          parentTaskId: parent.id,
          task: { clientId: "superseded", title: "置換対象task", type: "task" },
        },
        evidence: [],
        expiresAt: "2026-08-03T00:00:00.000Z",
      });
      await expect(
        resumed.execute({
          schemaVersion: "1",
          commandId: "supersede-after-reconcile",
          type: "supersede",
          actor: { id: "orchestrator", role: "orchestrator" },
          proposalId: supersededSource.proposalId!,
          expectedRevision: supersededSource.revision,
          successorProposalId: successor.proposalId!,
        }),
      ).resolves.toMatchObject({ accepted: true, status: "superseded" });
      await expect(
        resumed.execute({
          schemaVersion: "1",
          commandId: "expire-successor",
          type: "expire",
          actor: { id: "orchestrator", role: "orchestrator" },
          proposalId: "proposal-reconcile-crash",
          expectedRevision: reconciled.revision,
        }),
      ).resolves.toMatchObject({ accepted: true, status: "expired" });

      const claimVersion = (await claimStore.snapshot()).entityVersion;
      await expect(
        claimStore.claim(
          {
            schemaVersion: "1",
            eventId: "dispatch-after-reconcile",
            expectedEntityVersion: claimVersion,
            taskId: parent.id,
            repository: "example/public",
            state: "Todo",
            ownerId: "executor",
            workspaceId: "workspace:fixture",
            runId: "run-after-reconcile",
            leaseDurationSeconds: 60,
            dispatchPlanId: "dispatch-plan:after-reconcile",
            dispatchPlanVersion: "1",
            snapshotFingerprint: "c".repeat(64),
          },
          async () => "c".repeat(64),
        ),
      ).resolves.toMatchObject({ accepted: true });
    },
  );
});
