import { describe, expect, it, vi } from "vitest";
import {
  mutationCommandFingerprint,
  type Config,
  type MutationProposal,
  type SyncState,
  type Task,
  type TasksFile,
} from "@gh-gantt/shared";
import { WorkGraphCommandEngine } from "../work-graph/command-engine.js";
import { extractSyncFields } from "../sync/hash.js";
import {
  createMutationRemoteProjection,
  mutationRemoteBeforeProjection,
  serializeTaskBodyForGithub,
} from "../sync/mutation-remote-projection.js";
import {
  ProductionMutationEnvironment,
  scanMutationCorrelationIssues,
} from "../work-graph/production-mutation-environment.js";
import type { MutationFenceContext } from "../work-graph/mutation-control-plane.js";

const timestamp = "2026-08-02T00:00:00.000Z";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const config: Config = {
  version: "1",
  project: { name: "公開fixture", github: { owner: "example", repo: "public", project_number: 1 } },
  sync: {
    auto_create_issues: true,
    field_mapping: {
      start_date: "Start",
      end_date: "End",
      type: "Type",
      priority: "Priority",
      estimate_hours: "Estimate",
    },
  },
  task_types: {
    epic: { label: "Epic", display: "summary", color: "#000", github_label: "epic" },
    task: {
      label: "Task",
      display: "bar",
      color: "#111",
      github_label: "task",
      github_field_value: "Task",
      github_issue_type: "Issue Task",
    },
  },
  type_hierarchy: { epic: ["task"], task: [] },
  statuses: {
    field_name: "Status",
    values: { Todo: { color: "#000", done: false } },
  },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

function parentTask(): Task {
  return {
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
}

const reconcileFence: MutationFenceContext = {
  applicationLease: {
    proposalId: "proposal-fixture",
    commandId: "command-fixture",
    commandFingerprint: "a".repeat(64),
    ownerNonce: "11111111-1111-4111-8111-111111111111",
    fencingToken: 1,
    stepId: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  mutationReservation: {
    proposalId: "proposal-fixture",
    ownerNonce: "11111111-1111-4111-8111-111111111111",
    fencingToken: 1,
    affectedTaskIds: [],
    expiresAt: "2099-01-01T00:00:00.000Z",
    sideEffectState: "idle",
  },
};

function reconciliationFenceDependencies() {
  return {
    claimStore: {
      reserveMutation: vi.fn(),
      beginMutationSideEffect: vi.fn(),
      completeMutationSideEffect: vi.fn(),
      releaseMutationReservation: vi.fn(),
      assertMutationReservation: vi.fn(async () => undefined),
      withMutationReservation: vi.fn(async (_proof, operation) => operation()),
    } as never,
    applicationStore: {
      assertApplication: vi.fn(async () => reconcileFence.applicationLease),
      withApplicationLease: vi.fn(async (_lease, operation) => operation(() => undefined)),
    },
  };
}

function switchableFenceDependencies(initialFence: MutationFenceContext) {
  let currentFence = structuredClone(initialFence);
  const assertApplication = vi.fn(async (lease) => {
    if (JSON.stringify(lease) !== JSON.stringify(currentFence.applicationLease)) {
      throw new Error("stale_application_lease");
    }
    return lease;
  });
  const assertMutationReservation = vi.fn(async (proof) => {
    if (JSON.stringify(proof) !== JSON.stringify(currentFence.mutationReservation)) {
      throw new Error("stale_mutation_reservation");
    }
    return proof;
  });
  return {
    dependencies: {
      claimStore: {
        reserveMutation: vi.fn(),
        beginMutationSideEffect: vi.fn(),
        completeMutationSideEffect: vi.fn(),
        releaseMutationReservation: vi.fn(),
        assertMutationReservation,
        withMutationReservation: vi.fn(async (proof, operation) => {
          await assertMutationReservation(proof);
          return operation();
        }),
      } as never,
      applicationStore: {
        assertApplication,
        withApplicationLease: vi.fn(async (lease, operation) => {
          await assertApplication(lease);
          return operation(() => {
            if (JSON.stringify(lease) !== JSON.stringify(currentFence.applicationLease)) {
              throw new Error("stale_application_lease");
            }
          });
        }),
      },
    },
    takeover(nextFence: MutationFenceContext) {
      currentFence = structuredClone(nextFence);
    },
  };
}

function successorFence(fence: MutationFenceContext): MutationFenceContext {
  const ownerNonce = "22222222-2222-4222-8222-222222222222";
  return {
    applicationLease: {
      ...fence.applicationLease,
      ownerNonce,
      fencingToken: fence.applicationLease.fencingToken + 1,
    },
    mutationReservation: {
      ...fence.mutationReservation,
      ownerNonce,
      fencingToken: fence.mutationReservation.fencingToken + 1,
    },
  };
}

describe("[NFR-STABILITY-014-AC8] 本番mutation環境のsaga", () => {
  it("metadata付きtaskのbefore imageをGitHub bodyと同じ形式へ正準化する", () => {
    const task = {
      ...parentTask(),
      body: "本文",
      acceptance_criteria: [{ description: "確認項目", checked: false }],
      acceptance_criteria_slot: true,
      implementer: "builder",
      reviewer: "reviewer",
      require_review: true,
    };
    const before = mutationRemoteBeforeProjection(task);
    expect(before.body).toBe(serializeTaskBodyForGithub(task));
    expect(before.body).not.toBe(task.body);
  });

  it.each([
    "reserveMutation",
    "beginMutationSideEffect",
    "completeMutationSideEffect",
    "releaseMutationReservation",
    "assertMutationReservation",
    "withMutationReservation",
  ] as const)("coordination adapterの%s欠落をremote開始前に拒否する", (missingMethod) => {
    const claimStore: Record<string, ReturnType<typeof vi.fn>> = {
      reserveMutation: vi.fn(),
      beginMutationSideEffect: vi.fn(),
      completeMutationSideEffect: vi.fn(),
      releaseMutationReservation: vi.fn(),
      assertMutationReservation: vi.fn(),
      withMutationReservation: vi.fn(),
    };
    delete claimStore[missingMethod];
    expect(
      () =>
        new ProductionMutationEnvironment("/public/worktree", new WorkGraphCommandEngine(config), {
          claimStore: claimStore as never,
        }),
    ).toThrow(`mutation coordination adapterが不完全です: ${missingMethod}`);
  });

  it.each(["assertApplication", "withApplicationLease"] as const)(
    "application fence adapterの%s欠落をremote/local I/O前に拒否する",
    (missingMethod) => {
      const applicationStore: Record<string, ReturnType<typeof vi.fn>> = {
        assertApplication: vi.fn(),
        withApplicationLease: vi.fn(),
      };
      const createGraphQLClient = vi.fn();
      const storageRunner = vi.fn();
      const pushExecutor = vi.fn();
      delete applicationStore[missingMethod];

      expect(
        () =>
          new ProductionMutationEnvironment(
            "/public/worktree",
            new WorkGraphCommandEngine(config),
            {
              applicationStore: applicationStore as never,
              createGraphQLClient,
              storageRunner: storageRunner as never,
              pushExecutor: pushExecutor as never,
            },
          ),
      ).toThrow(`application fence adapterが不完全です: ${missingMethod}`);
      expect(createGraphQLClient).not.toHaveBeenCalled();
      expect(storageRunner).not.toHaveBeenCalled();
      expect(pushExecutor).not.toHaveBeenCalled();
      for (const method of Object.values(applicationStore)) expect(method).not.toHaveBeenCalled();
    },
  );

  it("production reservationはnested targetにcanonical originを必ずunionする", async () => {
    const reserveMutation = vi.fn(async (input) => ({
      accepted: true as const,
      entityVersion: input.expectedEntityVersion + 1,
      reservation: {
        proposalId: input.proposalId,
        ownerNonce: input.ownerNonce,
        fencingToken: input.expectedEntityVersion + 1,
        affectedTaskIds: input.affectedTaskIds,
        expiresAt: "2026-08-02T00:01:00.000Z",
        sideEffectState: "idle" as const,
      },
    }));
    const environment = new ProductionMutationEnvironment(
      "/public/worktree",
      new WorkGraphCommandEngine(config),
      {
        claimStore: {
          reserveMutation,
          beginMutationSideEffect: vi.fn(),
          completeMutationSideEffect: vi.fn(),
          releaseMutationReservation: vi.fn(),
          assertMutationReservation: vi.fn(),
          withMutationReservation: vi.fn(async (_proof, operation) => operation()),
        } as never,
      },
    );
    const proposal = {
      proposalId: "proposal-nested",
      origin: { taskId: "example/public#331" },
      targetTaskIds: ["example/public#333"],
      affectedDownstream: ["example/public#334"],
    } as MutationProposal;
    await expect(
      environment.mutationCoordination.reserveMutation(
        proposal,
        4,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toMatchObject({ accepted: true });
    expect(reserveMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        affectedTaskIds: ["example/public#331", "example/public#333", "example/public#334"],
      }),
    );
  });

  it("replan event append後のproposal finalize crashはstable eventをdrift判定より先に回収する", async () => {
    const proposal = {
      proposalId: "proposal-replan-crash",
      revision: 7,
    } as MutationProposal;
    const approval = {
      actor: { id: "U_REVIEWER", role: "human" },
      commentId: "IC_REPLAN",
      bodyHash: "b".repeat(64),
      authorityConfigFingerprint: "c".repeat(64),
      boundDecision: { proposalFingerprint: "d".repeat(64) },
    };
    const successorPlanRevision = {
      planId: "dev-role-fixed",
      fromVersion: "1",
      proposedVersion: "2",
      reasonProposalId: proposal.proposalId,
    };
    const target = {
      projectRoot: "/missing-after-process-restart",
      runId: "run-replan",
      planId: "dev-role-fixed",
      planVersion: "1",
      schemaVersion: "1",
      currentNodeId: "old-frozen-node",
    } as MutationProposal["invalidationTargets"][number];
    const receiptFingerprint = mutationCommandFingerprint(approval);
    const readAcceptedRunEvent = vi.fn(async () => ({
      recordType: "accepted" as const,
      eventId: `mutation:${proposal.proposalId}:replan:${proposal.revision}`,
      sequence: 3,
      runId: target.runId,
      acceptedAt: timestamp,
      actor: approval.actor,
      command: {
        type: "work_graph_replan_accepted" as const,
        proposalId: proposal.proposalId,
        proposalRevision: proposal.revision,
        verifiedHumanDecision: {
          decision: "approved" as const,
          evidenceId: `github-comment:${approval.commentId}:${approval.bodyHash}`,
          authorNodeId: approval.actor.id,
          proposalFingerprint: approval.boundDecision.proposalFingerprint,
          authorityConfigFingerprint: approval.authorityConfigFingerprint,
          receiptFingerprint,
        },
        graphContractBinding: {
          planId: target.planId,
          planVersion: target.planVersion,
          schemaVersion: target.schemaVersion,
        },
        successorPlanRevision,
        successorNodeId: "successor-node",
      },
      artifactIds: [],
      evidenceIds: [],
    }));
    const environment = new ProductionMutationEnvironment(
      "/missing-after-process-restart",
      new WorkGraphCommandEngine(config),
      { readAcceptedRunEvent: readAcceptedRunEvent as never },
    );

    await expect(
      environment.acceptReplan(
        proposal,
        approval as never,
        successorPlanRevision,
        "successor-node",
        target,
      ),
    ).resolves.toEqual({ ok: true });
    expect(readAcceptedRunEvent).toHaveBeenCalledTimes(1);
  });

  it("prepare lease内でproposal baseline driftを検出しlocal writeとremote実行を禁止する", async () => {
    const engine = new WorkGraphCommandEngine(config, { now: () => timestamp });
    const parent = parentTask();
    const plan = engine.planMutation(
      [parent],
      {
        kind: "add",
        parentTaskId: parent.id,
        task: {
          clientId: "child",
          title: "追加task",
          type: "task",
          requireReview: true,
          startDate: "2026-08-03",
          endDate: "2026-08-05",
        },
      },
      { scopeRootTaskId: parent.id },
    );
    if (!plan.ok) throw new Error(plan.error);
    const step = plan.steps[0]!;
    const baselineState: SyncState = {
      last_synced_at: "revision-1",
      project_node_id: "PVT_PUBLIC",
      id_map: {},
      field_ids: {},
      snapshots: {},
    };
    const proposal = {
      proposalId: "proposal-source-drift",
      snapshotFingerprint: mutationCommandFingerprint({
        tasks: [parent],
        syncState: baselineState,
      }),
      logicalTaskIds: {},
    } as MutationProposal;
    const parallelTask: Task = {
      ...parentTask(),
      id: "example/public#999",
      github_issue: 999,
      type: "task",
      title: "parallel pull result",
    };
    let tasksFile: TasksFile = {
      tasks: [structuredClone(parent), parallelTask],
      cache: { comments: {}, reactions: {} },
    };
    const syncState = { ...baselineState, last_synced_at: "parallel-pull" };
    const write = vi.fn();
    const pushExecutor = vi.fn();
    const environment = new ProductionMutationEnvironment("/public/worktree", engine, {
      ...reconciliationFenceDependencies(),
      storageRunner: (async (_root: string, _options: unknown, operation: (value: any) => any) =>
        operation({
          configStore: { read: async () => config },
          tasksStore: {
            read: async () => structuredClone(tasksFile),
            write: async (next: TasksFile) => {
              write();
              tasksFile = structuredClone(next);
            },
          },
          stateStore: { read: async () => structuredClone(syncState) },
          flush: async () => undefined,
        })) as never,
      createGraphQLClient: async () => (async () => ({})) as never,
      pushExecutor: pushExecutor as never,
      now: () => timestamp,
    });

    await expect(environment.executeStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "unknown",
      diagnostic: expect.stringContaining("source_drift"),
    });
    expect(write).not.toHaveBeenCalled();
    expect(pushExecutor).not.toHaveBeenCalled();
    expect(tasksFile.tasks.map((task) => task.id)).toEqual([
      "example/public#331",
      "example/public#999",
    ]);
  });

  it("create correlationを100件圏外までcursor走査する", async () => {
    const marker = "<!-- gh-gantt:mutation-correlation:v1 unique -->";
    const gql = vi.fn(async (_query: string, variables: { cursor: string | null }) => {
      const second = variables.cursor === "page-2";
      return {
        repository: {
          issues: {
            pageInfo: { hasNextPage: !second, endCursor: second ? null : "page-2" },
            nodes: second
              ? [
                  {
                    id: "I_MATCH",
                    number: 331,
                    body: marker,
                    createdAt: "2026-08-02T00:01:00.000Z",
                    repository: { nameWithOwner: "example/public" },
                  },
                ]
              : Array.from({ length: 100 }, (_, index) => ({
                  id: `I_${index}`,
                  number: index + 1,
                  body: null,
                  createdAt: "2026-08-02T00:02:00.000Z",
                  repository: { nameWithOwner: "example/public" },
                })),
          },
        },
      };
    });
    const result = await scanMutationCorrelationIssues(
      gql as never,
      "example",
      "public",
      marker,
      "2026-08-02T00:00:00.000Z",
    );
    expect(result).toMatchObject({ complete: true });
    expect(result.matches.map((issue) => issue.id)).toEqual(["I_MATCH"]);
    expect(gql).toHaveBeenCalledTimes(2);
  });

  it("cursor走査上限に達した場合はnot_startedを断定できない", async () => {
    let page = 0;
    const gql = vi.fn(async () => ({
      repository: {
        issues: {
          pageInfo: { hasNextPage: true, endCursor: `cursor-${++page}` },
          nodes: [],
        },
      },
    }));
    const result = await scanMutationCorrelationIssues(
      gql as never,
      "example",
      "public",
      "marker",
      "2026-08-02T00:00:00.000Z",
      2,
    );
    expect(result).toEqual({ complete: false, matches: [] });
  });

  it("blocked_byは集合として正規化し欠落・type・lag driftを拒否する", async () => {
    const target: Task = {
      ...parentTask(),
      id: "example/public#10",
      github_issue: 10,
      type: "task",
    };
    let liveBody: string | null | undefined = target.body;
    let storedTasks: Task[] = [structuredClone(target)];
    let blockedByNodes = [
      { number: 3, repository: { nameWithOwner: "example/public" } },
      { number: 2, repository: { nameWithOwner: "example/public" } },
      { number: 2, repository: { nameWithOwner: "example/public" } },
    ];
    let rejectPublishFence = false;
    let applicationAssertions = 0;
    const applicationStore = {
      assertApplication: vi.fn(async () => {
        applicationAssertions += 1;
        if (rejectPublishFence && applicationAssertions >= 2) {
          throw new Error("application_fence_lost");
        }
        return reconcileFence.applicationLease;
      }),
      withApplicationLease: vi.fn(async (_lease, operation) => {
        await applicationStore.assertApplication();
        return operation(() => undefined);
      }),
    };
    const gql = vi.fn(async (query: string) => {
      if (query.includes("subIssues(first")) {
        return {
          repository: {
            issue: {
              subIssues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
              blockedBy: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: blockedByNodes,
              },
            },
          },
        };
      }
      return {
        repository: {
          issue: {
            id: "I_PUBLIC_10",
            number: 10,
            title: target.title,
            body: liveBody,
            state: "OPEN",
            stateReason: null,
            issueType: { name: "Issue Task" },
            assignees: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
            labels: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ name: "task" }],
            },
            milestone: null,
            parent: null,
          },
        },
      };
    });
    const environment = new ProductionMutationEnvironment(
      "/public/worktree",
      new WorkGraphCommandEngine(config),
      {
        ...reconciliationFenceDependencies(),
        applicationStore,
        createGraphQLClient: async () => gql as never,
        storageRunner: (async (
          _root: string,
          _options: unknown,
          operation: (storage: any) => any,
        ) =>
          operation({
            configStore: { read: async () => config },
            tasksStore: {
              read: async () => ({ tasks: storedTasks, cache: { comments: {}, reactions: {} } }),
              write: async (next: TasksFile) => {
                storedTasks = structuredClone(next.tasks);
              },
            },
            stateStore: {
              read: async () => ({
                last_synced_at: "revision-1",
                project_node_id: "PVT_PUBLIC",
                id_map: {},
                field_ids: {},
                snapshots: {},
              }),
              write: async () => undefined,
            },
            flush: async () => undefined,
          })) as never,
      },
    );
    const step = {
      operation: "link",
      targetTaskId: target.id,
      expectedPostcondition: {
        blocked_by: [
          { task: "example/public#2", type: "finish-to-start", lag: 0 },
          { task: "example/public#3", type: "finish-to-start", lag: 0 },
        ],
      },
      beforeImage: null,
    } as never;
    const proposal = { logicalTaskIds: {} } as MutationProposal;
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "reconciled",
    });

    (step as any).expectedPostcondition.blocked_by[0].type = "start-to-start";
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "unknown",
    });
    (step as any).expectedPostcondition.blocked_by[0].type = "finish-to-start";
    (step as any).expectedPostcondition.blocked_by[0].lag = 1;
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "unknown",
    });
    (step as any).expectedPostcondition.blocked_by = [
      { task: "example/public#2", type: "finish-to-start", lag: 0 },
    ];
    blockedByNodes = blockedByNodes.slice(0, 2);
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "unknown",
    });

    Object.assign(target, {
      body: "本文",
      acceptance_criteria: [{ description: "確認項目", checked: false }],
      acceptance_criteria_slot: true,
      implementer: "builder",
      reviewer: "reviewer",
      require_review: true,
      blocked_by: [
        { task: "example/public#2", type: "finish-to-start", lag: 0 },
        { task: "example/public#3", type: "finish-to-start", lag: 0 },
      ],
    });
    storedTasks = [structuredClone(target)];
    liveBody = serializeTaskBodyForGithub(target) ?? null;
    blockedByNodes = [
      { number: 3, repository: { nameWithOwner: "example/public" } },
      { number: 2, repository: { nameWithOwner: "example/public" } },
    ];
    (step as any).payload = { remoteBeforeImage: mutationRemoteBeforeProjection(target) };
    (step as any).beforeImage = {
      id: target.id,
      type: target.type,
      github_repo: target.github_repo,
      body: target.body,
      blocked_by: target.blocked_by,
    };
    (step as any).expectedPostcondition = { state: "closed" };
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "not_started",
    });
    (step as any).expectedPostcondition = { state: "open" };
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "reconciled",
    });
    (step as any).expectedPostcondition = { state: "closed" };
    liveBody = "利用者によるbody drift";
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).resolves.toMatchObject({
      state: "unknown",
    });
    liveBody = serializeTaskBodyForGithub(target) ?? null;
    rejectPublishFence = true;
    applicationAssertions = 0;
    const beforeStaleOwnerAttempt = structuredClone(storedTasks);
    await expect(environment.reconcileStep(step, proposal, reconcileFence)).rejects.toThrow(
      "application_fence_lost",
    );
    expect(storedTasks).toEqual(beforeStaleOwnerAttempt);
  });

  it("live query中のtakeover後は旧ownerのreconcile outcomeを拒否し新ownerだけが返せる", async () => {
    const target = { ...parentTask(), id: "example/public#10", github_issue: 10, type: "task" };
    const oldFence = structuredClone(reconcileFence);
    const newFence = successorFence(oldFence);
    const switchable = switchableFenceDependencies(oldFence);
    let takeoverDuringQuery = true;
    const gql = vi.fn(async (query: string) => {
      if (query.includes("subIssues(first")) {
        if (takeoverDuringQuery) {
          takeoverDuringQuery = false;
          switchable.takeover(newFence);
        }
        return {
          repository: {
            issue: {
              subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              blockedBy: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        };
      }
      return {
        repository: {
          issue: {
            id: "I_PUBLIC_10",
            number: 10,
            title: target.title,
            body: target.body,
            state: "OPEN",
            stateReason: null,
            issueType: { name: "Issue Task" },
            assignees: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            labels: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ name: "task" }],
            },
            milestone: null,
            parent: null,
          },
        },
      };
    });
    const storageRunner = async (
      _root: string,
      _options: unknown,
      operation: (storage: any) => Promise<unknown>,
    ) =>
      operation({
        configStore: { read: async () => config },
        tasksStore: {
          read: async () => ({ tasks: [target], cache: { comments: {}, reactions: {} } }),
        },
        stateStore: {
          read: async () => ({
            last_synced_at: "revision-1",
            project_node_id: "PVT_PUBLIC",
            id_map: {},
            field_ids: {},
            snapshots: {},
          }),
        },
      });
    const environment = new ProductionMutationEnvironment(
      "/public/worktree",
      new WorkGraphCommandEngine(config),
      {
        ...switchable.dependencies,
        createGraphQLClient: async () => gql as never,
        storageRunner: storageRunner as never,
      },
    );
    const step = {
      operation: "link",
      targetTaskId: target.id,
      expectedPostcondition: { state: "open" },
      beforeImage: null,
    } as never;
    const proposal = { logicalTaskIds: {} } as MutationProposal;

    await expect(environment.reconcileStep(step, proposal, oldFence)).rejects.toThrow(
      "stale_application_lease",
    );
    await expect(environment.reconcileStep(step, proposal, newFence)).resolves.toMatchObject({
      state: "reconciled",
      remoteIdentifiers: { issueId: "I_PUBLIC_10", issueNumber: 10 },
    });
  });

  it("exact-one create reconciliationはdraft IDと全参照/id_map/snapshotをreal IDへreifyする", async () => {
    const engine = new WorkGraphCommandEngine(config, { now: () => timestamp });
    const parent = parentTask();
    const plan = engine.planMutation(
      [parent],
      {
        kind: "add",
        parentTaskId: parent.id,
        task: {
          clientId: "child",
          title: "追加task",
          type: "task",
          requireReview: true,
          startDate: "2026-08-03",
          endDate: "2026-08-05",
        },
      },
      { scopeRootTaskId: parent.id },
    );
    if (!plan.ok) throw new Error(plan.error);
    const step = plan.steps[0]!;
    step.correlationToken = "mutation:proposal-reify:step-0001";
    const marker = `<!-- gh-gantt:mutation-correlation:v1 ${step.correlationToken} -->`;
    const draft = {
      ...parentTask(),
      ...(step.payload.task as Partial<Task>),
      id: step.targetTaskId,
      github_issue: null,
      type: "task",
      parent: parent.id,
      sub_tasks: [],
      custom_fields: { Priority: "High", Estimate: 5, Status: "Todo" },
    } as Task;
    step.payload.task = structuredClone(draft);
    step.expectedPostcondition = createMutationRemoteProjection(draft, config);
    let tasksFile: TasksFile = {
      tasks: [{ ...parent, sub_tasks: [draft.id] }, draft],
      cache: { comments: {}, reactions: {} },
    };
    let syncState: SyncState = {
      last_synced_at: "revision-1",
      project_node_id: "PVT_PUBLIC",
      id_map: {},
      field_ids: {},
      snapshots: {
        [draft.id]: {
          hash: "a".repeat(64),
          synced_at: timestamp,
          syncFields: extractSyncFields(draft),
          remoteHash: "a".repeat(64),
        },
      },
    };
    const storageRunner = async (
      _root: string,
      _options: unknown,
      operation: (value: any) => any,
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
    let wrongParent = true;
    const expectedBody = String(step.expectedPostcondition.body);
    let liveBody: string | null = `${expectedBody}\n\n${marker}`;
    let liveStatus = "In Progress";
    const gql = vi.fn(async (query: string) => {
      if (query.includes("issues(first")) {
        return {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "I_PUBLIC_400",
                  number: 400,
                  body: marker,
                  createdAt: timestamp,
                  repository: { nameWithOwner: "example/public" },
                  projectItems: { nodes: [{ id: "ITEM_400", project: { id: "PVT_PUBLIC" } }] },
                },
              ],
            },
          },
        };
      }
      if (query.includes("projectItems(first: 100, after:")) {
        return {
          repository: {
            issue: {
              projectItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "ITEM_400", project: { id: "PVT_PUBLIC" } }],
              },
            },
          },
        };
      }
      if (query.includes("fieldValues(first: 100, after:")) {
        return {
          node: {
            fieldValues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { field: { name: "Start" }, date: "2026-08-03" },
                { field: { name: "End" }, date: "2026-08-05" },
                { field: { name: "Type" }, name: "Task" },
                { field: { name: "Priority" }, name: "HIGH" },
                { field: { name: "Estimate" }, number: 5 },
                { field: { name: "Status" }, name: liveStatus },
              ],
            },
          },
        };
      }
      if (query.includes("subIssues(first")) {
        return {
          repository: {
            issue: {
              subIssues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
              blockedBy: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        };
      }
      return {
        repository: {
          issue: {
            id: "I_PUBLIC_400",
            number: 400,
            title: "追加task",
            body: liveBody,
            state: "OPEN",
            stateReason: null,
            issueType: { name: "Issue Task" },
            assignees: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
            labels: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ name: "task" }],
            },
            milestone: null,
            parent: wrongParent
              ? null
              : { number: 331, repository: { nameWithOwner: "example/public" } },
          },
        },
      };
    });
    const environment = new ProductionMutationEnvironment("/public/worktree", engine, {
      ...reconciliationFenceDependencies(),
      storageRunner: storageRunner as never,
      createGraphQLClient: async () => gql as never,
      now: () => timestamp,
    });

    await expect(
      environment.reconcileStep(
        step,
        {
          createdAt: timestamp,
          logicalTaskIds: {},
        } as MutationProposal,
        reconcileFence,
      ),
    ).resolves.toMatchObject({
      state: "unknown",
      diagnostic: expect.stringContaining("parent/dependency/order"),
    });
    expect(tasksFile.tasks.some((task) => task.id === draft.id)).toBe(true);
    wrongParent = false;
    liveBody = `利用者body drift\n\n${marker}`;

    await expect(
      environment.reconcileStep(
        step,
        {
          createdAt: timestamp,
          logicalTaskIds: {},
        } as MutationProposal,
        reconcileFence,
      ),
    ).resolves.toMatchObject({
      state: "unknown",
      diagnostic: expect.stringContaining("postcondition"),
    });
    expect(tasksFile.tasks.some((task) => task.id === draft.id)).toBe(true);
    liveBody = `${expectedBody}\n\n${marker}`;

    await expect(
      environment.reconcileStep(
        step,
        {
          createdAt: timestamp,
          logicalTaskIds: {},
        } as MutationProposal,
        reconcileFence,
      ),
    ).resolves.toMatchObject({
      state: "unknown",
      diagnostic: expect.stringContaining("postcondition"),
    });
    expect(tasksFile.tasks.some((task) => task.id === draft.id)).toBe(true);
    liveStatus = "Todo";

    await expect(
      environment.reconcileStep(
        step,
        {
          createdAt: timestamp,
          logicalTaskIds: {},
        } as MutationProposal,
        reconcileFence,
      ),
    ).resolves.toMatchObject({
      state: "reconciled",
      resolvedTaskId: "example/public#400",
      remoteIdentifiers: {
        issueId: "I_PUBLIC_400",
        issueNumber: 400,
        projectItemId: "ITEM_400",
      },
    });
    expect(tasksFile.tasks.map((task) => task.id)).toEqual([
      "example/public#331",
      "example/public#400",
    ]);
    expect(tasksFile.tasks[0]?.sub_tasks).toEqual(["example/public#400"]);
    expect(syncState.id_map["example/public#400"]).toEqual({
      issue_number: 400,
      issue_node_id: "I_PUBLIC_400",
      project_item_id: "ITEM_400",
    });
    expect(syncState.snapshots[draft.id]).toBeUndefined();
    expect(syncState.snapshots["example/public#400"]).toBeDefined();
  });

  it("prepare lease外でremote I/Oしcreateの親子mirrorを同一transactionで確定する", async () => {
    const engine = new WorkGraphCommandEngine(config, { now: () => timestamp });
    const parent = parentTask();
    const plan = engine.planMutation(
      [parent],
      {
        kind: "add",
        parentTaskId: parent.id,
        task: { clientId: "child", title: "追加task", type: "task" },
      },
      { scopeRootTaskId: parent.id },
    );
    if (!plan.ok) throw new Error(plan.error);
    const step = plan.steps[0]!;
    let tasksFile: TasksFile = { tasks: [parent], cache: { comments: {}, reactions: {} } };
    let syncState: SyncState = {
      last_synced_at: "revision-1",
      project_node_id: "PVT_PUBLIC",
      id_map: {},
      field_ids: {},
      snapshots: {},
    };
    let leaseHeld = false;
    let remoteActive = false;
    const storageRunner = vi.fn(async (_root, _options, operation) => {
      expect(leaseHeld).toBe(false);
      leaseHeld = true;
      try {
        return await operation({
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
      } finally {
        leaseHeld = false;
      }
    });
    const createGraphQLClient = vi.fn(async () => {
      expect(leaseHeld).toBe(false);
      return (async () => ({})) as never;
    });
    const pushExecutor = vi.fn(async (_gql, _config, preparedTasks, preparedState, options) => {
      expect(leaseHeld).toBe(false);
      remoteActive = true;
      const child = preparedTasks.tasks.find((task: Task) => task.id === step.targetTaskId)!;
      const preparedParent = preparedTasks.tasks.find((task: Task) => task.id === parent.id)!;
      expect(child.parent).toBe(parent.id);
      expect(preparedParent.sub_tasks).toEqual([step.targetTaskId]);
      expect(engine.validateGraph(preparedTasks.tasks)).toMatchObject({ ok: true });
      await options.saveProgress(preparedTasks, preparedState);
      expect(leaseHeld).toBe(false);
      await options.onStepOutcome({
        stepId: step.stepId,
        operation: "create",
        state: "committed",
        diagnostic: null,
        remoteIdentifiers: { issueId: "I_PUBLIC_400", issueNumber: 400, projectItemId: "ITEM_400" },
      });
      remoteActive = false;
      return {
        tasksFile: preparedTasks,
        syncState: preparedState,
        stepOutcomes: [
          {
            stepId: step.stepId,
            operation: "create",
            state: "committed",
            diagnostic: null,
            remoteIdentifiers: {
              issueId: "I_PUBLIC_400",
              issueNumber: 400,
              projectItemId: "ITEM_400",
            },
          },
        ],
      };
    });
    const environment = new ProductionMutationEnvironment("/public/worktree", engine, {
      ...reconciliationFenceDependencies(),
      storageRunner: storageRunner as never,
      createGraphQLClient,
      pushExecutor: pushExecutor as never,
      now: () => timestamp,
    });
    const proposal = {
      proposalId: "proposal-production",
      logicalTaskIds: {},
    } as MutationProposal;
    const outcome = await environment.executeStep(step, proposal, reconcileFence);
    expect(outcome).toMatchObject({
      state: "committed",
      diagnostic: null,
      remoteIdentifiers: { issueId: "I_PUBLIC_400", issueNumber: 400, projectItemId: "ITEM_400" },
    });
    expect(remoteActive).toBe(false);
    expect(leaseHeld).toBe(false);
    expect(storageRunner).toHaveBeenCalledTimes(3);
  });

  it("remote中に別processが更新したWork Graphをstale prepared snapshotで上書きしない", async () => {
    const engine = new WorkGraphCommandEngine(config, { now: () => timestamp });
    const parent = parentTask();
    const plan = engine.planMutation(
      [parent],
      {
        kind: "add",
        parentTaskId: parent.id,
        task: { clientId: "child", title: "追加task", type: "task" },
      },
      { scopeRootTaskId: parent.id },
    );
    if (!plan.ok) throw new Error(plan.error);
    const step = plan.steps[0]!;
    let tasksFile: TasksFile = { tasks: [parent], cache: { comments: {}, reactions: {} } };
    let syncState: SyncState = {
      last_synced_at: "revision-1",
      project_node_id: "PVT_PUBLIC",
      id_map: {},
      field_ids: {},
      snapshots: {},
    };
    const concurrent = {
      ...parentTask(),
      id: "example/public#999",
      github_issue: 999,
      type: "task",
      title: "parallel pull result",
    };
    const storageRunner = async (
      _root: string,
      _options: unknown,
      operation: (value: any) => any,
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
      tasksFile.tasks.push(concurrent);
      syncState.last_synced_at = "parallel-pull";
      await options.saveProgress(preparedTasks, preparedState);
      return {
        tasksFile: preparedTasks,
        syncState: preparedState,
        stepOutcomes: [
          {
            stepId: step.stepId,
            operation: "create",
            state: "committed",
            diagnostic: null,
          },
        ],
      };
    });
    const environment = new ProductionMutationEnvironment("/public/worktree", engine, {
      ...reconciliationFenceDependencies(),
      storageRunner: storageRunner as never,
      createGraphQLClient: async () => (async () => ({})) as never,
      pushExecutor: pushExecutor as never,
      now: () => timestamp,
    });

    await expect(
      environment.executeStep(
        step,
        {
          proposalId: "proposal-publish-cas",
          logicalTaskIds: {},
        } as MutationProposal,
        reconcileFence,
      ),
    ).resolves.toMatchObject({ state: "unknown", diagnostic: expect.stringContaining("drift") });
    expect(tasksFile.tasks.some((task) => task.id === concurrent.id)).toBe(true);
    expect(syncState.last_synced_at).toBe("parallel-pull");
  });

  it("Work Graph write lease待機中のtakeover後は旧ownerのpublishを拒否し新ownerだけがflushできる", async () => {
    const engine = new WorkGraphCommandEngine(config, { now: () => timestamp });
    const parent = parentTask();
    const plan = engine.planMutation(
      [parent],
      {
        kind: "add",
        parentTaskId: parent.id,
        task: { clientId: "lease-child", title: "追加task", type: "task" },
      },
      { scopeRootTaskId: parent.id },
    );
    if (!plan.ok) throw new Error(plan.error);
    const step = plan.steps[0]!;
    const oldFence = structuredClone(reconcileFence);
    const newFence = successorFence(oldFence);
    const switchable = switchableFenceDependencies(oldFence);
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
    let storageCalls = 0;
    let waitForPublishLease = true;
    let taskWrites = 0;
    let flushes = 0;
    const leaseWaitStarted = deferred();
    const releaseLeaseWait = deferred();
    const storageRunner = async (
      _root: string,
      _options: unknown,
      operation: (storage: any) => Promise<unknown>,
    ) => {
      storageCalls += 1;
      if (waitForPublishLease && storageCalls === 2) {
        leaseWaitStarted.resolve();
        await releaseLeaseWait.promise;
      }
      return operation({
        configStore: { read: async () => config },
        tasksStore: {
          read: async () => structuredClone(tasksFile),
          write: async (next: TasksFile) => {
            taskWrites += 1;
            tasksFile = structuredClone(next);
          },
        },
        stateStore: {
          read: async () => structuredClone(syncState),
          write: async (next: SyncState) => {
            syncState = structuredClone(next);
          },
        },
        flush: async () => {
          flushes += 1;
        },
      });
    };
    const pushExecutor = vi.fn(async (_gql, _config, preparedTasks, preparedState, options) => {
      await options.saveProgress(preparedTasks, preparedState);
      await options.onStepOutcome({
        stepId: step.stepId,
        operation: step.operation,
        state: "committed",
        diagnostic: null,
      });
      return {
        tasksFile: preparedTasks,
        syncState: preparedState,
        stepOutcomes: [
          {
            stepId: step.stepId,
            operation: step.operation,
            state: "committed",
            diagnostic: null,
          },
        ],
      };
    });
    const createEnvironment = () =>
      new ProductionMutationEnvironment("/public/worktree", engine, {
        ...switchable.dependencies,
        storageRunner: storageRunner as never,
        createGraphQLClient: async () => (async () => ({})) as never,
        pushExecutor: pushExecutor as never,
      });
    const proposal = {
      proposalId: "proposal-lease-takeover",
      logicalTaskIds: {},
    } as MutationProposal;

    const oldExecution = createEnvironment().executeStep(step, proposal, oldFence);
    await leaseWaitStarted.promise;
    const writesBeforeTakeover = taskWrites;
    const flushesBeforeTakeover = flushes;
    switchable.takeover(newFence);
    releaseLeaseWait.resolve();
    await expect(oldExecution).resolves.toMatchObject({
      state: "unknown",
      diagnostic: expect.stringContaining("stale_application_lease"),
    });
    expect(taskWrites).toBe(writesBeforeTakeover);
    expect(flushes).toBe(flushesBeforeTakeover);

    tasksFile = { tasks: [structuredClone(parent)], cache: { comments: {}, reactions: {} } };
    syncState = {
      last_synced_at: "revision-1",
      project_node_id: "PVT_PUBLIC",
      id_map: {},
      field_ids: {},
      snapshots: {},
    };
    storageCalls = 0;
    waitForPublishLease = false;
    const newWritesBefore = taskWrites;
    const newFlushesBefore = flushes;
    await expect(createEnvironment().executeStep(step, proposal, newFence)).resolves.toMatchObject({
      state: "committed",
    });
    expect(taskWrites).toBeGreaterThan(newWritesBefore);
    expect(flushes).toBeGreaterThan(newFlushesBefore);
  });

  it("committed stepのpostconditionだけ進んだdurable baselineを許容する", async () => {
    const engine = new WorkGraphCommandEngine(config, { now: () => timestamp });
    const parent = parentTask();
    const plan = engine.planMutation(
      [parent],
      {
        kind: "split",
        targetTaskId: parent.id,
        children: [
          { clientId: "first", title: "first", type: "task" },
          { clientId: "second", title: "second", type: "task" },
        ],
        sourceDisposition: "keep",
      },
      { scopeRootTaskId: parent.id },
    );
    if (!plan.ok) throw new Error(plan.error);
    const [first, second] = plan.steps;
    first!.state = "committed";
    const firstTask: Task = {
      ...parentTask(),
      id: "example/public#400",
      github_issue: 400,
      type: "task",
      parent: parent.id,
      sub_tasks: [],
      title: "first",
      labels: ["task"],
    };
    const advancedParent = { ...parentTask(), sub_tasks: [firstTask.id] };
    const proposal = {
      steps: [first, second],
      logicalTaskIds: { [first!.targetTaskId]: firstTask.id },
    } as MutationProposal;
    const environment = new ProductionMutationEnvironment("/public/worktree", engine);
    const advanced = {
      config,
      tasks: [advancedParent, firstTask],
      sourceRevision: "revision-after-first",
      snapshotFingerprint: "a".repeat(64),
      syncConflicts: false,
    };
    await expect(environment.validateAdvancedBaseline(proposal, advanced)).resolves.toBe(true);

    const unexpectedSecond: Task = {
      ...firstTask,
      id: second!.targetTaskId,
      github_issue: null,
      title: "second",
    };
    const drifted = {
      ...advanced,
      tasks: [
        { ...advancedParent, sub_tasks: [firstTask.id, unexpectedSecond.id] },
        firstTask,
        unexpectedSecond,
      ],
    };
    await expect(environment.validateAdvancedBaseline(proposal, drifted)).resolves.toBe(false);
  });

  it("downstream Runへのstable invalidationを全件成功まで再送できる", async () => {
    const originInputs: unknown[] = [];
    const downstreamInputs: unknown[] = [];
    let failDownstreamOnce = true;
    const originControl = {
      async applyMutationAudit(input: unknown) {
        originInputs.push(structuredClone(input));
        return { accepted: true };
      },
    };
    const downstreamControl = {
      async applyMutationAudit(input: unknown) {
        downstreamInputs.push(structuredClone(input));
        if (failDownstreamOnce) {
          failDownstreamOnce = false;
          return { accepted: false, code: "run_state_unknown", message: "journal unavailable" };
        }
        return { accepted: true };
      },
    };
    const environment = new ProductionMutationEnvironment(
      "/public/origin",
      new WorkGraphCommandEngine(config),
      {
        runControlPlane: originControl as never,
        createRunControlPlane: () => downstreamControl as never,
      },
    );
    const event = {
      eventId: "mutation:proposal-fanout:work_graph_invalidated:7",
      type: "work_graph_invalidated" as const,
      proposalId: "proposal-fanout",
      proposalRevision: 7,
      originRunId: "run-origin",
      actorId: "orchestrator",
      actorRole: "orchestrator" as const,
      occurredAt: timestamp,
      detail: {
        coverageFingerprint: "a".repeat(64),
        affectedTaskIds: ["example/public#331", "example/public#332"],
        planId: "dev-role-fixed",
        fromVersion: "1",
        proposedVersion: "1+proposal.proposal-fanout",
        affectedRuns: [
          {
            projectRoot: "/public/origin",
            runId: "run-origin",
            workspaceId: "workspace:origin",
            taskId: "example/public#331",
            planId: "origin-plan",
            planVersion: "3",
            schemaVersion: "1",
            currentNodeId: "origin-node",
            successorPlanRevision: {
              planId: "origin-plan",
              fromVersion: "3",
              proposedVersion: "3+proposal.proposal-fanout",
              reasonProposalId: "proposal-fanout",
            },
          },
          {
            projectRoot: "/public/downstream",
            runId: "run-downstream",
            workspaceId: "workspace:downstream",
            taskId: "example/public#332",
            planId: "downstream-plan",
            planVersion: "7",
            schemaVersion: "2",
            currentNodeId: "downstream-node",
            successorPlanRevision: {
              planId: "downstream-plan",
              fromVersion: "7",
              proposedVersion: "7+proposal.proposal-fanout",
              reasonProposalId: "proposal-fanout",
            },
          },
        ],
      },
    };
    await expect(environment.appendAudit(event)).rejects.toThrow("journal unavailable");
    await expect(environment.appendAudit(event)).resolves.toBeUndefined();
    expect(originInputs).toHaveLength(2);
    expect(downstreamInputs).toHaveLength(2);
    expect(originInputs[1]).toEqual(originInputs[0]);
    expect(downstreamInputs[1]).toEqual(downstreamInputs[0]);
    expect((originInputs[0] as any).command.successorPlanRevision).toMatchObject({
      planId: "origin-plan",
      fromVersion: "3",
    });
    expect((downstreamInputs[0] as any).command.successorPlanRevision).toMatchObject({
      planId: "downstream-plan",
      fromVersion: "7",
    });
  });
});
