import { describe, it, expect } from "vitest";
import type { Config, Task } from "../types.js";
import { buildProjectMapViewModel } from "../project-map.js";
import { classifyReadyExhaustion, detectScheduleSlips } from "../loop-analysis.js";

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
    field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
    epic: { label: "Epic", display: "summary", color: "#111", github_label: null },
  },
  type_hierarchy: { epic: ["task"], task: [] },
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
    at_risk_threshold_days: 3,
    colors: {
      critical_path: "#E74C3C",
      on_track: "#2ECC71",
      at_risk: "#F39C12",
      overdue: "#E74C3C",
    },
  },
  require_review_for_types: [],
  require_close_evidence: false,
};

function classify(tasks: Task[]) {
  const vm = buildProjectMapViewModel(tasks, config);
  return classifyReadyExhaustion(tasks, config, vm.readinessById);
}

describe("classifyReadyExhaustion による ready 枯渇の 3 分類 (ADR-017)", () => {
  it("ready な leaf がある場合は枯渇ではない (null)", () => {
    const tasks = [baseTask({ id: "r", custom_fields: { Status: "Todo" } })];
    expect(classify(tasks)).toBeNull();
  });

  it("open タスクが 0 なら all_done", () => {
    const tasks = [
      baseTask({ id: "d1", state: "closed" }),
      baseTask({ id: "d2", custom_fields: { Status: "Done" } }),
    ];
    expect(classify(tasks)).toEqual({ reason: "all_done" });
  });

  it("タスクが 1 件もなくても all_done（空プロジェクト）", () => {
    expect(classify([])).toEqual({ reason: "all_done" });
  });

  it("作業粒度の open が全てブロック中なら all_blocked とブロッカーを返す", () => {
    const tasks = [
      baseTask({ id: "dep", state: "closed" }),
      baseTask({
        id: "b1",
        blocked_by: [
          { task: "dep2", type: "finish-to-start", lag: 0 },
          { task: "dep", type: "finish-to-start", lag: 0 },
        ],
        custom_fields: { Status: "Todo" },
      }),
      baseTask({ id: "dep2", blocked_by: [{ task: "外部", type: "finish-to-start", lag: 0 }] }),
    ];
    const result = classify(tasks);
    expect(result?.reason).toBe("all_blocked");
    if (result?.reason === "all_blocked") {
      const b1 = result.blocked.find((b) => b.taskId === "b1");
      // 完了済みの dep はブロッカーに含まれない
      expect(b1?.blockingTaskIds).toEqual(["dep2"]);
    }
  });

  it("分解可能な type の open のみ残存なら backlog_needs_decomposition と分解候補を返す", () => {
    const tasks = [
      baseTask({ id: "done-task", state: "closed" }),
      // 子を持たない epic: leaf だが type が分解可能 → 作業粒度ではない
      baseTask({ id: "empty-epic", type: "epic", custom_fields: { Status: "Todo" } }),
    ];
    const result = classify(tasks);
    expect(result?.reason).toBe("backlog_needs_decomposition");
    if (result?.reason === "backlog_needs_decomposition") {
      expect(result.decomposeCandidates).toEqual(["empty-epic"]);
    }
  });

  it("分解不可 type なのに子を持つ不整合タスクも分解候補に含まれる（出力から消えない）", () => {
    const tasks = [
      // type task (分解不可) だが sub_tasks を持つデータ不整合
      baseTask({ id: "odd-parent", sub_tasks: ["child"], custom_fields: { Status: "Todo" } }),
      baseTask({ id: "child", parent: "odd-parent", state: "closed" }),
    ];
    const result = classify(tasks);
    expect(result?.reason).toBe("backlog_needs_decomposition");
    if (result?.reason === "backlog_needs_decomposition") {
      expect(result.decomposeCandidates).toContain("odd-parent");
    }
  });

  it("子を持つ epic と完了済みの子だけなら backlog_needs_decomposition（追加の分解が必要）", () => {
    const tasks = [
      baseTask({
        id: "epic",
        type: "epic",
        sub_tasks: ["child"],
        custom_fields: { Status: "Todo" },
      }),
      baseTask({ id: "child", parent: "epic", state: "closed" }),
    ];
    const result = classify(tasks);
    expect(result?.reason).toBe("backlog_needs_decomposition");
  });
});

describe("detectScheduleSlips によるスリップ検出 (ADR-017)", () => {
  const today = "2026-07-04";

  it("期日超過の open タスクを overdue として検出する", () => {
    const tasks = [
      baseTask({ id: "late", end_date: "2026-07-01", custom_fields: { Status: "Todo" } }),
    ];
    expect(detectScheduleSlips(tasks, config, today)).toEqual([
      { taskId: "late", title: "task", kind: "overdue", days: 3 },
    ]);
  });

  it("期日が at_risk_threshold_days 以内の open タスクを at_risk として検出する", () => {
    const tasks = [
      baseTask({ id: "soon", end_date: "2026-07-06", custom_fields: { Status: "Todo" } }),
      baseTask({ id: "far", end_date: "2026-07-20", custom_fields: { Status: "Todo" } }),
    ];
    const slips = detectScheduleSlips(tasks, config, today);
    expect(slips).toEqual([{ taskId: "soon", title: "task", kind: "at_risk", days: 2 }]);
  });

  it("期日後に完了したタスクを done_late として検出する", () => {
    const tasks = [
      baseTask({
        id: "slipped",
        state: "closed",
        end_date: "2026-06-30",
        closed_at: "2026-07-02T10:00:00Z",
      }),
      baseTask({
        id: "on-time",
        state: "closed",
        end_date: "2026-06-30",
        closed_at: "2026-06-30T23:00:00Z",
      }),
    ];
    expect(detectScheduleSlips(tasks, config, today)).toEqual([
      { taskId: "slipped", title: "task", kind: "done_late", days: 2 },
    ]);
  });

  it("end_date がないタスクは対象外", () => {
    const tasks = [baseTask({ id: "no-date", custom_fields: { Status: "Todo" } })];
    expect(detectScheduleSlips(tasks, config, today)).toEqual([]);
  });

  it("深刻な順（overdue → done_late → at_risk）に並ぶ", () => {
    const tasks = [
      baseTask({ id: "risk", end_date: "2026-07-05", custom_fields: { Status: "Todo" } }),
      baseTask({ id: "over", end_date: "2026-07-01", custom_fields: { Status: "Todo" } }),
      baseTask({
        id: "late-done",
        state: "closed",
        end_date: "2026-06-01",
        closed_at: "2026-06-10T00:00:00Z",
      }),
    ];
    const kinds = detectScheduleSlips(tasks, config, today).map((s) => s.kind);
    expect(kinds).toEqual(["overdue", "done_late", "at_risk"]);
  });
});
