// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { scaleTime } from "d3-scale";
import { GanttChart } from "../components/GanttChart.js";
import { GanttMilestoneLane, MILESTONE_LANE_HEIGHT } from "../components/GanttMilestoneLane.js";
import {
  extractMilestones,
  getMilestoneDate,
  getMilestoneTypeNames,
  isMilestoneTask,
} from "../lib/milestone-utils.js";
import type { Config, Task } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";

const baseTask = (overrides: Partial<Task>): Task => ({
  id: "TASK-1",
  type: "task",
  github_issue: 1,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "Some task",
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
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
  project: {
    name: "Test Project",
    github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
    milestone: { label: "Milestone", display: "milestone", color: "#E74C3C", github_label: null },
  },
  type_hierarchy: { task: [], milestone: [] },
  statuses: {
    field_name: "Status",
    values: { Todo: { color: "#3498DB", done: false } },
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

const dateRange: [Date, Date] = [new Date(2026, 3, 1), new Date(2026, 3, 30)];
const xScale = scaleTime().domain(dateRange).range([0, 300]);

const originalConsoleError = console.error.bind(console);

describe("milestone-utils", () => {
  it("getMilestoneTypeNames は display='milestone' の type 名集合を返す", () => {
    const names = getMilestoneTypeNames(config);
    expect(names.has("milestone")).toBe(true);
    expect(names.has("task")).toBe(false);
  });

  it("isMilestoneTask は task_type の display を見て判定する", () => {
    const ms = baseTask({ id: "M-1", type: "milestone", date: "2026-04-15" });
    const tk = baseTask({ id: "T-1", type: "task" });
    expect(isMilestoneTask(ms, config)).toBe(true);
    expect(isMilestoneTask(tk, config)).toBe(false);
  });

  it("getMilestoneDate は date を優先し、なければ end_date にフォールバックする (start_date は無視)", () => {
    expect(getMilestoneDate(baseTask({ date: "2026-04-15" }))).toBe("2026-04-15");
    expect(getMilestoneDate(baseTask({ end_date: "2026-04-20" }))).toBe("2026-04-20");
    expect(getMilestoneDate(baseTask({ start_date: "2026-04-10" }))).toBeNull();
    expect(getMilestoneDate(baseTask({ date: "2026-04-15", end_date: "2026-04-20" }))).toBe(
      "2026-04-15",
    );
  });

  it("extractMilestones はマイルストーンのみ抽出し date 昇順でソートする", () => {
    const tasks = [
      baseTask({ id: "M-2", type: "milestone", date: "2026-04-20", title: "M2" }),
      baseTask({ id: "T-1", type: "task", title: "T1" }),
      baseTask({ id: "M-1", type: "milestone", date: "2026-04-10", title: "M1" }),
      baseTask({ id: "M-3", type: "milestone", title: "M3 no date" }),
    ];
    const result = extractMilestones(tasks, config);
    expect(result.map((m) => m.task.id)).toEqual(["M-1", "M-2"]);
    expect(result[0].date).toBe("2026-04-10");
  });
});

describe("[FR-VIS-023-AC1] task_type が milestone のタスクは左ペインのタスクリストに表示されない", () => {
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation((message: unknown, ...args: unknown[]) => {
      if (
        typeof message === "string" &&
        message.includes("useLayoutEffect does nothing on the server")
      ) {
        return;
      }
      originalConsoleError(message, ...args);
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("マイルストーンを含む tasks を useTaskTree に渡しても flatList に含まれない (App.tsx 経由のフィルタ責務)", async () => {
    // useTaskTree 単独テスト: マイルストーン除外オプションが有効な場合 flatList から外れる
    const { renderHook } = await import("@testing-library/react");
    const { useTaskTree } = await import("../hooks/useTaskTree.js");
    const tasks = [
      baseTask({
        id: "T-1",
        type: "task",
        title: "Task1",
        start_date: "2026-04-05",
        end_date: "2026-04-08",
      }),
      baseTask({ id: "M-1", type: "milestone", title: "Milestone1", date: "2026-04-15" }),
    ];
    const enabledTypes = new Set(["task", "milestone"]);
    const milestoneTypes = getMilestoneTypeNames(config);
    const { result } = renderHook(() =>
      useTaskTree(tasks, enabledTypes, { excludedTypes: milestoneTypes }),
    );
    const titles = result.current.flatList.map((n) => n.task.title);
    expect(titles).toContain("Task1");
    expect(titles).not.toContain("Milestone1");
  });
});

describe("[FR-VIS-023-AC2][FR-VIS-023-AC3][FR-VIS-023-AC6] タイムラインヘッダー直下のマイルストーンレーン", () => {
  it("マイルストーンが存在する場合、レーンが描画され data-testid='milestone-lane' を持つ", () => {
    const milestones = extractMilestones(
      [baseTask({ id: "M-1", type: "milestone", title: "MS1", date: "2026-04-15" })],
      config,
    );
    const html = renderToStaticMarkup(
      <GanttMilestoneLane
        milestones={milestones}
        xScale={xScale}
        totalWidth={300}
        config={config}
      />,
    );
    expect(html).toContain('data-testid="milestone-lane"');
    expect(html).toContain(`height:${MILESTONE_LANE_HEIGHT}`);
    expect(html).toContain("MS1");
  });

  it("[FR-VIS-023-AC6] マイルストーンが 0 件ならレーンは描画されない", () => {
    const html = renderToStaticMarkup(
      <GanttMilestoneLane milestones={[]} xScale={xScale} totalWidth={300} config={config} />,
    );
    expect(html).toBe("");
  });

  it("[FR-VIS-023-AC3] マーカー位置は date を xScale で変換した値に一致する", () => {
    const targetDate = "2026-04-15";
    const expectedX = xScale(new Date(2026, 3, 15));
    const milestones = extractMilestones(
      [baseTask({ id: "M-1", type: "milestone", title: "MS1", date: targetDate })],
      config,
    );
    const html = renderToStaticMarkup(
      <GanttMilestoneLane
        milestones={milestones}
        xScale={xScale}
        totalWidth={300}
        config={config}
      />,
    );
    expect(html).toContain(`${expectedX},`);
  });
});

describe("[FR-VIS-023-AC4] マーカーホバーでタイトル/日付がツールチップ用 aria-label として取得できる", () => {
  it("マーカー <g> に aria-label でタイトルと日付が付与される", () => {
    const milestones = extractMilestones(
      [
        baseTask({
          id: "M-1",
          type: "milestone",
          title: "リリース v1",
          date: "2026-04-15",
          state: "open",
        }),
      ],
      config,
    );
    const html = renderToStaticMarkup(
      <GanttMilestoneLane
        milestones={milestones}
        xScale={xScale}
        totalWidth={300}
        config={config}
      />,
    );
    expect(html).toContain('aria-label="Milestone: リリース v1, 2026-04-15, open"');
  });
});

describe("[FR-VIS-023-AC5] マイルストーン位置からガント本体の全タスク行を縦に貫通する縦線が描画される", () => {
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation((message: unknown, ...args: unknown[]) => {
      if (
        typeof message === "string" &&
        message.includes("useLayoutEffect does nothing on the server")
      ) {
        return;
      }
      originalConsoleError(message, ...args);
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("GanttChart 本体 SVG に各マイルストーンの x 位置で y=0 から y=totalHeight までの縦線が描画される", () => {
    const taskA = baseTask({
      id: "T-1",
      type: "task",
      title: "Task1",
      start_date: "2026-04-05",
      end_date: "2026-04-10",
    });
    const taskB = baseTask({
      id: "T-2",
      type: "task",
      title: "Task2",
      start_date: "2026-04-12",
      end_date: "2026-04-18",
    });
    const milestoneTask = baseTask({
      id: "M-1",
      type: "milestone",
      title: "MS1",
      date: "2026-04-15",
    });
    // flatList にはマイルストーンを含めない (App.tsx でフィルタ済みの想定)
    const flatList: TreeNode[] = [
      { task: taskA, children: [], depth: 0 },
      { task: taskB, children: [], depth: 0 },
    ];
    const html = renderToStaticMarkup(
      <GanttChart
        tasks={[taskA, taskB, milestoneTask]}
        flatList={flatList}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
      />,
    );
    // 縦線は data-milestone-vline 属性を持つ <line> として描画される想定
    expect(html).toContain("data-milestone-vline");
    // 縦線 y2 は flatList.length * ROW_HEIGHT (= 2*28 = 56)
    expect(html).toMatch(/data-milestone-vline[^>]*y2="56"/);
  });
});
