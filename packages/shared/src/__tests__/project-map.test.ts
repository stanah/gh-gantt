import { describe, it, expect } from "vitest";
import type { Config, Task } from "../types.js";
import {
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
