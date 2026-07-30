import { describe, it, expect } from "vitest";
import type { Config, Task } from "../types.js";
import { FIXED_DEV_ROLE_GRAPH_CONTRACT, type RunGraphView } from "../run-graph.js";
import {
  buildProjectMapRunGraphViewModel,
  buildProjectMapViewModel,
  buildBoardColumns,
  buildTaskHierarchy,
  buildDependencySubgraph,
  buildReadiness,
  buildNextActions,
  isTaskDone,
  getNormalizedPriority,
  BOARD_COLUMN_ORDER,
} from "../project-map.js";

const baseTask = (overrides: Partial<Task>): Task => ({
  id: "T",
  type: "task",
  github_issue: null,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "task",
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
  ...overrides,
});

const dep = (taskId: string): Task["blocked_by"][number] => ({
  task: taskId,
  type: "finish-to-start",
  lag: 0,
});

const config: Config = {
  version: "1",
  project: { name: "P", github: { owner: "stanah", repo: "gh-gantt", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: {
      start_date: "Start",
      end_date: "End",
      status: "Status",
      priority: "Priority",
      estimate_hours: "Estimate",
    },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
    epic: { label: "Epic", display: "summary", color: "#111", github_label: null },
  },
  type_hierarchy: { epic: ["task"], task: [] },
  statuses: {
    field_name: "Status",
    values: {
      Backlog: { color: "#999", done: false, category: "backlog" },
      Todo: { color: "#3498DB", done: false, category: "todo" },
      Doing: { color: "#F39C12", done: false, category: "in_progress" },
      Review: { color: "#9B59B6", done: false, category: "in_review" },
      Done: { color: "#2ECC71", done: true, category: "done" },
    },
  },
  gantt: {
    default_view: "month",
    working_days: [1, 2, 3, 4, 5],
    colors: {
      critical_path: "#E74C3C",
      on_track: "#2ECC71",
      at_risk: "#F39C12",
      overdue: "#E74C3C",
    },
  },
};

describe("[FR-VIS-024][FR-VIS-024-AC1] Board 列分類", () => {
  it("done / in_progress / review / blocked / ready_now / backlog に分類される", () => {
    const tasks = [
      baseTask({ id: "done", custom_fields: { Status: "Done" } }),
      baseTask({ id: "closed", state: "closed" }),
      baseTask({ id: "doing", custom_fields: { Status: "Doing" } }),
      baseTask({ id: "review", custom_fields: { Status: "Review" } }),
      baseTask({ id: "ready", custom_fields: { Status: "Todo" } }),
      baseTask({ id: "parked", custom_fields: { Status: "Backlog" } }),
    ];
    const cols = buildBoardColumns(tasks, config);
    expect(cols.done.map((t) => t.id).sort()).toEqual(["closed", "done"]);
    expect(cols.in_progress.map((t) => t.id)).toEqual(["doing"]);
    expect(cols.review.map((t) => t.id)).toEqual(["review"]);
    expect(cols.ready_now.map((t) => t.id)).toEqual(["ready"]);
    expect(cols.backlog.map((t) => t.id)).toEqual(["parked"]);
  });

  it("BOARD_COLUMN_ORDER は 6 列すべてを含む", () => {
    expect([...BOARD_COLUMN_ORDER].sort()).toEqual(
      ["backlog", "blocked", "done", "in_progress", "ready_now", "review"].sort(),
    );
  });

  it("require_review かつ未承認は review に分類される", () => {
    const tasks = [baseTask({ id: "r", require_review: true, review_approved_by: null })];
    expect(buildBoardColumns(tasks, config).review.map((t) => t.id)).toEqual(["r"]);
  });
});

describe("[FR-VIS-024][FR-VIS-024-AC2] blocked_by による Ready / Blocked 判定", () => {
  it("未完了の上流があると blocked、完了すると ready_now になる", () => {
    const open = [
      baseTask({ id: "up", custom_fields: { Status: "Todo" } }),
      baseTask({ id: "down", custom_fields: { Status: "Todo" }, blocked_by: [dep("up")] }),
    ];
    expect(buildBoardColumns(open, config).blocked.map((t) => t.id)).toEqual(["down"]);

    const cleared = [
      baseTask({ id: "up", state: "closed" }),
      baseTask({ id: "down", custom_fields: { Status: "Todo" }, blocked_by: [dep("up")] }),
    ];
    const cols = buildBoardColumns(cleared, config);
    expect(cols.ready_now.map((t) => t.id)).toEqual(["down"]);
    expect(cols.blocked).toHaveLength(0);
  });

  it("存在しない上流を参照する依存は未解決として blocked 扱い", () => {
    const tasks = [
      baseTask({ id: "x", custom_fields: { Status: "Todo" }, blocked_by: [dep("ghost")] }),
    ];
    expect(buildBoardColumns(tasks, config).blocked.map((t) => t.id)).toEqual(["x"]);
  });

  it("downstreamUnlockCount は完了で解除される下流の未完了数を数える", () => {
    const tasks = [
      baseTask({ id: "a" }),
      baseTask({ id: "b", blocked_by: [dep("a")] }),
      baseTask({ id: "c", blocked_by: [dep("b")] }),
      baseTask({ id: "d", state: "closed", blocked_by: [dep("a")] }),
    ];
    const readiness = buildReadiness(tasks, config, new Set());
    // a を完了すると b, c が解除対象（d は既に done なので数えない）
    expect(readiness.a.downstreamUnlockCount).toBe(2);
    expect(readiness.c.downstreamUnlockCount).toBe(0);
  });
});

describe("[FR-VIS-024][FR-VIS-024-AC3] Next Actions のスコアリングと安定ソート", () => {
  it("下流解除効果の高いタスクが上位に推薦され理由が付く", () => {
    const tasks = [
      baseTask({ id: "lonely", custom_fields: { Status: "Todo" } }),
      baseTask({ id: "unlocker", custom_fields: { Status: "Todo" } }),
      baseTask({ id: "b", custom_fields: { Status: "Todo" }, blocked_by: [dep("unlocker")] }),
      baseTask({ id: "c", custom_fields: { Status: "Todo" }, blocked_by: [dep("unlocker")] }),
    ];
    const readiness = buildReadiness(tasks, config, new Set());
    const actions = buildNextActions(tasks, config, readiness);
    expect(actions[0].task.id).toBe("unlocker");
    expect(actions[0].category).toBe("unlocker");
    expect(actions[0].reason).toContain("下流");
    // done タスクは候補に含まれない
    expect(actions.find((a) => a.task.state === "closed")).toBeUndefined();
  });

  it("スコア同点時は priority → updated_at → title で安定ソートされる", () => {
    const tasks = [
      baseTask({
        id: "low",
        title: "z",
        custom_fields: { Status: "Todo", Priority: "low" },
        updated_at: "2026-01-01T00:00:00Z",
      }),
      baseTask({
        id: "high",
        title: "a",
        custom_fields: { Status: "Todo", Priority: "high" },
        updated_at: "2026-01-01T00:00:00Z",
      }),
    ];
    const readiness = buildReadiness(tasks, config, new Set());
    const actions = buildNextActions(tasks, config, readiness);
    expect(actions[0].task.id).toBe("high");
  });

  it("limit で件数が制限される", () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      baseTask({ id: `t${i}`, custom_fields: { Status: "Todo" } }),
    );
    const readiness = buildReadiness(tasks, config, new Set());
    expect(buildNextActions(tasks, config, readiness, 3)).toHaveLength(3);
  });
});

describe("[FR-VIS-024][FR-VIS-024-AC4] 依存サブグラフの絞り込み", () => {
  it("選択タスクとその子孫を中心に上流/下流が含まれ、無関係なタスクは除外される", () => {
    const tasks = [
      baseTask({ id: "up" }),
      baseTask({ id: "sel", blocked_by: [dep("up")] }),
      baseTask({ id: "down", blocked_by: [dep("sel")] }),
      baseTask({ id: "unrelated" }),
    ];
    const graph = buildDependencySubgraph("sel", tasks, config, new Set());
    const ids = graph.nodes.map((n) => n.task.id).sort();
    expect(ids).toEqual(["down", "sel", "up"]);
    expect(graph.nodes.find((n) => n.task.id === "sel")?.direction).toBe("selected");
    expect(graph.nodes.find((n) => n.task.id === "up")?.direction).toBe("upstream");
    expect(graph.nodes.find((n) => n.task.id === "down")?.direction).toBe("downstream");
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: "up", to: "sel", isUnresolved: true }),
    );
  });

  it("選択中の親を選ぶと子孫タスクも selected に含まれる", () => {
    const tasks = [
      baseTask({ id: "epic", type: "epic", sub_tasks: ["child"] }),
      baseTask({ id: "child", parent: "epic" }),
      baseTask({ id: "blk", blocked_by: [dep("child")] }),
    ];
    const graph = buildDependencySubgraph("epic", tasks, config, new Set());
    const selected = graph.nodes.filter((n) => n.direction === "selected").map((n) => n.task.id);
    expect(selected.sort()).toEqual(["child", "epic"]);
    expect(graph.nodes.find((n) => n.task.id === "blk")?.direction).toBe("downstream");
  });
});

describe("[FR-VIS-024][FR-VIS-024-AC5] 循環依存への耐性", () => {
  it("循環があってもクラッシュせず warnings に記録される", () => {
    const tasks = [
      baseTask({ id: "a", blocked_by: [dep("b")] }),
      baseTask({ id: "b", blocked_by: [dep("a")] }),
    ];
    const vm = buildProjectMapViewModel(tasks, config);
    expect(vm.warnings.length).toBeGreaterThan(0);
    expect(vm.warnings[0]).toContain("循環");
    // 両タスクとも分類される（クラッシュしない）
    expect(Object.keys(vm.readinessById).sort()).toEqual(["a", "b"]);
  });
});

describe("[FR-VIS-024][FR-VIS-024-AC6] status category 無しのフォールバック", () => {
  it("category を持たない status でも done/blocked/ready を判定できる", () => {
    const noCatConfig: Config = {
      ...config,
      statuses: {
        field_name: "Status",
        values: {
          Open: { color: "#3498DB", done: false },
          Closed: { color: "#2ECC71", done: true },
        },
      },
    };
    const tasks = [
      baseTask({ id: "done", custom_fields: { Status: "Closed" } }),
      baseTask({ id: "up", custom_fields: { Status: "Open" } }),
      baseTask({ id: "blocked", custom_fields: { Status: "Open" }, blocked_by: [dep("up")] }),
      baseTask({ id: "ready", custom_fields: { Status: "Open" } }),
    ];
    expect(isTaskDone(tasks[0], noCatConfig)).toBe(true);
    const cols = buildBoardColumns(tasks, noCatConfig);
    expect(cols.done.map((t) => t.id)).toEqual(["done"]);
    expect(cols.blocked.map((t) => t.id)).toEqual(["blocked"]);
    expect(cols.ready_now.map((t) => t.id).sort()).toEqual(["ready", "up"]);
  });
});

describe("タスク階層の構築", () => {
  it("parent / sub_tasks から階層を構築する", () => {
    const tasks = [
      baseTask({ id: "epic", type: "epic", sub_tasks: ["f1", "f2"] }),
      baseTask({ id: "f1", parent: "epic", sub_tasks: ["t1"] }),
      baseTask({ id: "f2", parent: "epic" }),
      baseTask({ id: "t1", parent: "f1" }),
    ];
    const roots = buildTaskHierarchy(tasks);
    expect(roots).toHaveLength(1);
    expect(roots[0].task.id).toBe("epic");
    expect(roots[0].depth).toBe(0);
    expect(roots[0].children.map((c) => c.task.id)).toEqual(["f1", "f2"]);
    expect(roots[0].children[0].children[0].task.id).toBe("t1");
    expect(roots[0].children[0].children[0].depth).toBe(2);
  });

  it("循環した parent/sub_tasks でも全タスクを取りこぼさず無限ループしない", () => {
    const tasks = [
      baseTask({ id: "a", sub_tasks: ["b"] }),
      baseTask({ id: "b", parent: "a", sub_tasks: ["a"] }),
    ];
    const roots = buildTaskHierarchy(tasks);
    const collected = new Set<string>();
    const walk = (nodes: ReturnType<typeof buildTaskHierarchy>) => {
      for (const n of nodes) {
        collected.add(n.task.id);
        walk(n.children);
      }
    };
    walk(roots);
    expect(collected.has("a")).toBe(true);
    expect(collected.has("b")).toBe(true);
  });
});

describe("優先度の正規化", () => {
  it("custom_fields の優先度を小文字正規化し、未知値は null", () => {
    expect(getNormalizedPriority(baseTask({ custom_fields: { Priority: "High" } }), config)).toBe(
      "high",
    );
    expect(
      getNormalizedPriority(baseTask({ custom_fields: { Priority: "??" } }), config),
    ).toBeNull();
    expect(getNormalizedPriority(baseTask({ custom_fields: {} }), config)).toBeNull();
  });
});

function runView(overrides: Partial<RunGraphView> = {}): RunGraphView {
  const actor = { id: "runner-1", role: "executor" } as const;
  const nodes: RunGraphView["nodes"]["items"] = [
    {
      id: "node-planner",
      runId: "run-330",
      contractNodeId: "planner",
      state: "completed",
      actor: { id: "planner-1", role: "planner" },
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:01:00.000Z",
      activeAttemptId: null,
      previousNodeId: null,
      inputArtifactIds: [],
      outputArtifactIds: ["artifact-plan"],
    },
    {
      id: "node-implementer-1",
      runId: "run-330",
      contractNodeId: "implementer",
      state: "completed",
      actor: { id: "implementer-1", role: "implementer" },
      createdAt: "2026-07-30T00:01:00.000Z",
      updatedAt: "2026-07-30T00:03:00.000Z",
      activeAttemptId: null,
      previousNodeId: "node-planner",
      inputArtifactIds: ["artifact-plan"],
      outputArtifactIds: ["artifact-impl"],
    },
    {
      id: "node-executor",
      runId: "run-330",
      contractNodeId: "executor",
      state: "completed",
      actor,
      createdAt: "2026-07-30T00:03:00.000Z",
      updatedAt: "2026-07-30T00:04:00.000Z",
      activeAttemptId: null,
      previousNodeId: "node-implementer-1",
      inputArtifactIds: ["artifact-impl"],
      outputArtifactIds: [],
    },
    {
      id: "node-implementer-2",
      runId: "run-330",
      contractNodeId: "implementer",
      state: "ready",
      actor: { id: "implementer", role: "implementer" },
      createdAt: "2026-07-30T00:04:00.000Z",
      updatedAt: "2026-07-30T00:04:00.000Z",
      activeAttemptId: null,
      previousNodeId: "node-executor",
      inputArtifactIds: ["artifact-plan", "artifact-impl"],
      outputArtifactIds: [],
    },
  ];
  const attempts: RunGraphView["attempts"]["items"] = [
    {
      id: "attempt-executor",
      runId: "run-330",
      nodeId: "node-executor",
      ordinal: 1,
      state: "succeeded",
      actor,
      createdAt: "2026-07-30T00:03:00.000Z",
      updatedAt: "2026-07-30T00:04:00.000Z",
      previousAttemptId: null,
      inputArtifactIds: ["artifact-impl"],
      outputArtifactIds: [],
    },
  ];
  return {
    schemaVersion: "1",
    runId: "run-330",
    task: { owner: "stanah", repo: "gh-gantt", issueNumber: 330 },
    contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    revision: 10,
    state: "running",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:04:00.000Z",
    currentNode: nodes.at(-1)!,
    activeAttempt: null,
    waitReason: null,
    budgets: { executorRetries: 1, improvementIterations: 0 },
    allowedNextTransitions: ["attempt_started"],
    nodes: { total: nodes.length, limit: 20, truncated: false, items: nodes },
    attempts: { total: attempts.length, limit: 20, truncated: false, items: attempts },
    artifacts: { total: 0, limit: 20, truncated: false, items: [] },
    evidence: { total: 0, limit: 20, truncated: false, items: [] },
    ...overrides,
  };
}

describe("[FR-VIS-026-AC1] planned と actual の Run Graph を同じ ViewModel に導出する", () => {
  it("planned node/edge と actual transition を stable ID で対応付ける", () => {
    const vm = buildProjectMapRunGraphViewModel({
      taskId: "stanah/gh-gantt#330",
      contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
      runViews: [runView()],
      selectedRunId: "run-330",
      selectedNodeId: "node-executor",
      limit: 20,
    });

    expect(vm.selectedRun?.planned.nodes.map((node) => node.id)).toContain("executor");
    expect(vm.selectedRun?.actual.nodes.find((node) => node.id === "node-executor")).toMatchObject({
      contractNodeId: "executor",
      displayState: "completed",
      isPlanned: true,
    });
    expect(vm.selectedRun?.actual.transitions).toContainEqual(
      expect.objectContaining({
        fromNodeId: "node-implementer-1",
        toNodeId: "node-executor",
        isPlanned: true,
      }),
    );
    expect(vm.selectedRun?.selectedNodeId).toBe("node-executor");
  });
});

describe("[FR-VIS-026-AC2] Run Graph の状態と attempt 要約を導出する", () => {
  it("active run、retrying node、actor、duration、待機理由を区別する", () => {
    const waiting = runView({ state: "waiting_human", waitReason: "review_budget_exhausted" });
    const vm = buildProjectMapRunGraphViewModel({
      taskId: "stanah/gh-gantt#330",
      contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
      runViews: [waiting],
      selectedRunId: "run-330",
    });

    expect(vm.selectedRun?.displayState).toBe("waiting_human");
    expect(vm.selectedRun?.waitReason).toBe("review_budget_exhausted");
    expect(
      vm.selectedRun?.actual.nodes.find((node) => node.id === "node-implementer-2")?.displayState,
    ).toBe("retrying");
    expect(vm.selectedRun?.actual.attempts[0]).toMatchObject({
      actor: { id: "runner-1", role: "executor" },
      durationMs: 60000,
    });
  });

  it("active / queued / running / waiting_human / failed / completed / cancelled を正規化する", () => {
    const runCases = [
      ["pending", "queued"],
      ["running", "active"],
      ["paused", "active"],
      ["waiting_human", "waiting_human"],
      ["failed", "failed"],
      ["completed", "completed"],
      ["cancelled", "cancelled"],
    ] as const;
    for (const [state, expected] of runCases) {
      const vm = buildProjectMapRunGraphViewModel({
        taskId: "stanah/gh-gantt#330",
        contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
        runViews: [runView({ state })],
      });
      expect(vm.selectedRun?.displayState).toBe(expected);
    }

    const base = runView();
    const first = base.nodes.items[0]!;
    for (const [state, expected] of [
      ["ready", "queued"],
      ["running", "running"],
      ["waiting_human", "waiting_human"],
      ["failed", "failed"],
      ["completed", "completed"],
      ["cancelled", "cancelled"],
    ] as const) {
      const node = { ...first, state };
      const vm = buildProjectMapRunGraphViewModel({
        taskId: "stanah/gh-gantt#330",
        contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
        runViews: [
          runView({
            currentNode: node,
            nodes: { total: 1, limit: 20, truncated: false, items: [node] },
            attempts: { total: 0, limit: 20, truncated: false, items: [] },
          }),
        ],
      });
      expect(vm.selectedRun?.actual.nodes[0]?.displayState).toBe(expected);
    }
  });
});

describe("[FR-VIS-026-AC3] planned との差分と unknown metric を保持する", () => {
  it("同じ node の2回目以降の attempt を retry deviation として扱う", () => {
    const base = runView();
    const planner = { ...base.nodes.items[0]!, state: "ready" as const };
    const firstAttempt = {
      ...base.attempts.items[0]!,
      id: "attempt-planner-1",
      nodeId: planner.id,
      ordinal: 1,
      state: "failed" as const,
    };
    const retryAttempt = {
      ...firstAttempt,
      id: "attempt-planner-2",
      ordinal: 2,
      state: "created" as const,
      previousAttemptId: firstAttempt.id,
    };
    const vm = buildProjectMapRunGraphViewModel({
      taskId: "stanah/gh-gantt#330",
      contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
      runViews: [
        runView({
          currentNode: planner,
          nodes: { total: 1, limit: 20, truncated: false, items: [planner] },
          attempts: {
            total: 2,
            limit: 20,
            truncated: false,
            items: [firstAttempt, retryAttempt],
          },
        }),
      ],
    });

    expect(vm.selectedRun?.actual.nodes[0]?.displayState).toBe("retrying");
    expect(vm.selectedRun?.deviations).toContainEqual(
      expect.objectContaining({ kind: "retry", nodeId: planner.id }),
    );
  });

  it("fallback/retry を deviation とし、未取得の token/cost/latency を 0 にしない", () => {
    const vm = buildProjectMapRunGraphViewModel({
      taskId: "stanah/gh-gantt#330",
      contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
      runViews: [runView()],
      selectedRunId: "run-330",
    });

    expect(vm.selectedRun?.deviations.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["retry", "fallback"]),
    );
    expect(vm.selectedRun?.metrics.duration).toMatchObject({ known: true, value: 240000 });
    expect(vm.selectedRun?.metrics.tokens).toEqual({ known: false, value: null, unit: "token" });
    expect(vm.selectedRun?.metrics.cost).toEqual({ known: false, value: null, unit: "currency" });
    expect(vm.selectedRun?.metrics.latency).toEqual({
      known: false,
      value: null,
      unit: "ms",
    });
  });

  it("planned にない node/edge、skip、cancel を deviation として列挙する", () => {
    const base = runView();
    const planner = base.nodes.items[0]!;
    const executor = {
      ...base.nodes.items[2]!,
      previousNodeId: planner.id,
      state: "cancelled" as const,
    };
    const rogue = {
      ...base.nodes.items[1]!,
      id: "node-rogue",
      contractNodeId: "rogue",
      previousNodeId: executor.id,
    };
    const vm = buildProjectMapRunGraphViewModel({
      taskId: "stanah/gh-gantt#330",
      contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
      runViews: [
        runView({
          state: "cancelled",
          currentNode: rogue,
          nodes: { total: 3, limit: 20, truncated: false, items: [planner, executor, rogue] },
          attempts: { total: 0, limit: 20, truncated: false, items: [] },
        }),
      ],
    });

    expect(vm.selectedRun?.deviations.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["unexpected_node", "unexpected_edge", "skip", "cancel"]),
    );
  });
});

describe("[FR-VIS-026-AC4] Run Graph の一覧と deep link を bounded にする", () => {
  it("run 一覧を limit で切り詰め、run/node の URL を返す", () => {
    const vm = buildProjectMapRunGraphViewModel({
      taskId: "stanah/gh-gantt#330",
      contract: FIXED_DEV_ROLE_GRAPH_CONTRACT,
      runViews: [runView({ runId: "run-old", updatedAt: "2026-07-30T00:03:00.000Z" }), runView()],
      selectedRunId: "run-old",
      selectedNodeId: "node-executor",
      limit: 1,
    });

    expect(vm.runs).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(vm.runs.items.map((run) => run.runId)).toEqual(["run-old"]);
    expect(vm.selectedRun?.deepLink).toContain("run=run-old");
    expect(
      vm.selectedRun?.actual.nodes.find((node) => node.id === "node-executor")?.deepLink,
    ).toContain("node=node-executor");
  });
});

describe("[FR-VIS-026-AC5] Run Graph がない project の互換性を保つ", () => {
  it("空の bounded collection と null detail を返す", () => {
    const vm = buildProjectMapRunGraphViewModel({
      taskId: "stanah/gh-gantt#330",
      contract: null,
      runViews: [],
      limit: 20,
    });

    expect(vm.runs).toEqual({ total: 0, limit: 20, truncated: false, items: [] });
    expect(vm.selectedRun).toBeNull();
  });
});
