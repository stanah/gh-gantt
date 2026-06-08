import { describe, it, expect } from "vitest";
import type { Config, Task } from "../types.js";
import { groupTasks, getGroupDimensions } from "../project-map.js";

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

const config: Config = {
  version: "1",
  project: { name: "P", github: { owner: "stanah", repo: "gh-gantt", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status", priority: "Priority" },
  },
  task_types: {
    task: { label: "タスク", display: "bar", color: "#000", github_label: null },
    feature: { label: "フィーチャー", display: "bar", color: "#111", github_label: null },
  },
  type_hierarchy: { feature: ["task"], task: [] },
  statuses: {
    field_name: "Status",
    values: {
      Todo: { color: "#3498DB", done: false, category: "todo" },
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
  grouping: {
    facets: [
      { key: "system", label: "システム", label_prefix: "system:" },
      { key: "feature", label: "機能", label_prefix: "feature:" },
    ],
  },
};

describe("[FR-VIS-025][FR-VIS-025-AC1] 単一値軸でのグルーピング", () => {
  it("type 軸でタスクタイプ別にグルーピングされる", () => {
    const tasks = [
      baseTask({ id: "a", type: "task" }),
      baseTask({ id: "b", type: "feature" }),
      baseTask({ id: "c", type: "task" }),
    ];
    const result = groupTasks(tasks, "type", config);
    expect(result.multiMembership).toBe(false);
    const taskGroup = result.groups.find((g) => g.label === "タスク");
    expect(taskGroup?.taskIds.sort()).toEqual(["a", "c"]);
    expect(result.groups.find((g) => g.label === "フィーチャー")?.taskIds).toEqual(["b"]);
  });

  it("status / priority / milestone 軸でグルーピングできる", () => {
    const tasks = [
      baseTask({ id: "a", custom_fields: { Status: "Todo", Priority: "high" }, milestone: "v1" }),
      baseTask({ id: "b", custom_fields: { Status: "Done" } }),
    ];
    expect(
      groupTasks(tasks, "status", config).groups.find((g) => g.key === "status:Todo")?.taskIds,
    ).toEqual(["a"]);
    expect(
      groupTasks(tasks, "priority", config).groups.find((g) => g.key === "priority:high")?.label,
    ).toBe("High");
    expect(
      groupTasks(tasks, "milestone", config).groups.find((g) => g.label === "v1")?.taskIds,
    ).toEqual(["a"]);
  });

  it("assignee 軸で担当者ごとにグルーピングできる", () => {
    const tasks = [
      baseTask({ id: "a", assignees: ["alice"] }),
      baseTask({ id: "b", assignees: ["bob"] }),
      baseTask({ id: "c", assignees: ["alice"] }),
    ];
    const result = groupTasks(tasks, "assignee", config);
    expect(result.multiMembership).toBe(true);
    expect(result.groups.find((g) => g.key === "assignee:alice")?.taskIds.sort()).toEqual([
      "a",
      "c",
    ]);
    expect(result.groups.find((g) => g.key === "assignee:bob")?.taskIds).toEqual(["b"]);
  });

  it("hierarchy 軸は単一グループを返す（UI 側でツリー描画）", () => {
    const tasks = [baseTask({ id: "a" }), baseTask({ id: "b" })];
    const result = groupTasks(tasks, "hierarchy", config);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].taskIds.sort()).toEqual(["a", "b"]);
  });
});

describe("[FR-VIS-025][FR-VIS-025-AC2] ラベル facet による多対多グルーピングと軸切替", () => {
  it("同一タスクを機能軸とシステム軸で切り替えて分類できる", () => {
    const tasks = [
      baseTask({ id: "a", labels: ["feature:project-map", "system:ui"] }),
      baseTask({ id: "b", labels: ["feature:project-map", "system:cli"] }),
      baseTask({ id: "c", labels: ["system:ui"] }),
    ];
    // 機能軸: project-map グループに a, b
    const byFeature = groupTasks(tasks, "label:feature", config);
    expect(byFeature.multiMembership).toBe(true);
    expect(byFeature.groups.find((g) => g.label === "project-map")?.taskIds.sort()).toEqual([
      "a",
      "b",
    ]);
    // システム軸: ui に a, c / cli に b
    const bySystem = groupTasks(tasks, "label:system", config);
    expect(bySystem.groups.find((g) => g.label === "ui")?.taskIds.sort()).toEqual(["a", "c"]);
    expect(bySystem.groups.find((g) => g.label === "cli")?.taskIds).toEqual(["b"]);
  });

  it("複数の同 facet ラベルを持つタスクは複数グループに重複所属する", () => {
    const tasks = [baseTask({ id: "a", labels: ["system:ui", "system:shared"] })];
    const result = groupTasks(tasks, "label:system", config);
    expect(result.groups.find((g) => g.label === "ui")?.taskIds).toEqual(["a"]);
    expect(result.groups.find((g) => g.label === "shared")?.taskIds).toEqual(["a"]);
  });
});

describe("[FR-VIS-025][FR-VIS-025-AC3] (なし) グループ", () => {
  it("軸の値を持たないタスクは末尾の (なし) グループに入る", () => {
    const tasks = [baseTask({ id: "a", labels: ["system:ui"] }), baseTask({ id: "b", labels: [] })];
    const result = groupTasks(tasks, "label:system", config);
    const last = result.groups[result.groups.length - 1];
    expect(last.key).toBe("__none__");
    expect(last.label).toBe("(なし)");
    expect(last.taskIds).toEqual(["b"]);
  });
});

describe("[FR-VIS-025][FR-VIS-025-AC4] getGroupDimensions", () => {
  it("組み込み軸と config.grouping.facets を反映した選択肢を返す", () => {
    const options = getGroupDimensions(config);
    const values = options.map((o) => o.value);
    expect(values).toContain("hierarchy");
    expect(values).toContain("type");
    expect(values).toContain("label:system");
    expect(values).toContain("label:feature");
    expect(options.find((o) => o.value === "label:system")?.label).toBe("システム");
  });

  it("facets 未設定なら label 軸は含まれない", () => {
    const noFacet: Config = { ...config, grouping: undefined };
    const values = getGroupDimensions(noFacet).map((o) => o.value);
    expect(values.some((v) => v.startsWith("label:"))).toBe(false);
    expect(values).toContain("hierarchy");
  });
});
