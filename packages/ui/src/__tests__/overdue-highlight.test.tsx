import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GanttChart } from "../components/GanttChart.js";
import { TaskRow } from "../components/TaskRow.js";
import type { Config, Task } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";

const originalConsoleError = console.error.bind(console);

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
  },
  type_hierarchy: { task: [] },
  statuses: {
    field_name: "Status",
    values: {
      Todo: { color: "#3498DB", done: false },
      Done: { color: "#2ECC71", done: true },
    },
  },
  gantt: {
    default_view: "month",
    working_days: [1, 2, 3, 4, 5],
    at_risk_threshold_days: 5,
    colors: {
      critical_path: "#E74C3C",
      on_track: "#2ECC71",
      at_risk: "#F39C12",
      overdue: "#E74C3C",
    },
  },
};

function makeTask(id: string, options: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: id,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    custom_fields: { Status: "Todo" },
    start_date: "2026-05-01",
    end_date: "2026-05-01",
    date: null,
    blocked_by: [],
    ...options,
  };
}

function flatList(tasks: Task[]): TreeNode[] {
  return tasks.map((task) => ({ task, children: [], depth: 0 }));
}

describe("[FR-VIS-018] 遅延タスクの自動ハイライト", () => {
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 4, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("[FR-VIS-018-AC1] GanttChart は end_date 超過の open task を overdue 表示し closed task は除外する", () => {
    const overdueTask = makeTask("stanah/gh-gantt#19", {
      title: "遅延タスク",
      end_date: "2026-05-01",
    });
    const closedTask = makeTask("stanah/gh-gantt#20", {
      title: "完了済みタスク",
      state: "closed",
      closed_at: "2026-05-02T00:00:00Z",
      end_date: "2026-05-01",
      custom_fields: { Status: "Done" },
    });
    const tasks = [overdueTask, closedTask];

    const html = renderToStaticMarkup(
      <GanttChart
        tasks={tasks}
        flatList={flatList(tasks)}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
      />,
    );

    expect(html).toContain("遅延タスク, from 2026-05-01 to 2026-05-01");
    expect(html).toContain("overdue 3 days");
    expect(html).toContain("+3d");
    expect(html).toContain('stroke-dasharray="4 2"');
    expect(html).toContain("完了済みタスク, from 2026-05-01 to 2026-05-01");
    expect(html).toContain("done");
    expect(html).not.toContain("完了済みタスク, from 2026-05-01 to 2026-05-01, overdue");
  });

  it("[FR-VIS-018-AC2] TaskRow は遅延日数バッジを表示する", () => {
    const overdueTask = makeTask("stanah/gh-gantt#19", {
      title: "遅延タスク",
      end_date: "2026-05-01",
    });

    const html = renderToStaticMarkup(
      <TaskRow
        task={overdueTask}
        depth={0}
        hasChildren={false}
        isCollapsed={false}
        onToggle={() => {}}
        onClick={() => {}}
        isSelected={false}
        statusFieldName={config.statuses.field_name}
        statusValues={config.statuses.values}
        taskType={config.task_types.task}
      />,
    );

    expect(html).toContain("期限超過: 3日");
    expect(html).toContain("+3d");
  });

  it("[FR-VIS-018-AC3] gantt.at_risk_threshold_days で D-n 表示範囲を変更できる", () => {
    const atRiskTask = makeTask("stanah/gh-gantt#21", {
      title: "リスクタスク",
      start_date: "2026-05-04",
      end_date: "2026-05-08",
    });
    const tasks = [atRiskTask];

    const chartHtml = renderToStaticMarkup(
      <GanttChart
        tasks={tasks}
        flatList={flatList(tasks)}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
      />,
    );
    const rowHtml = renderToStaticMarkup(
      <TaskRow
        task={atRiskTask}
        depth={0}
        hasChildren={false}
        isCollapsed={false}
        onToggle={() => {}}
        onClick={() => {}}
        isSelected={false}
        statusFieldName={config.statuses.field_name}
        statusValues={config.statuses.values}
        taskType={config.task_types.task}
        atRiskThresholdDays={config.gantt.at_risk_threshold_days}
      />,
    );

    expect(chartHtml).toContain("リスクタスク, from 2026-05-04 to 2026-05-08");
    expect(chartHtml).toContain("due in 4 days");
    expect(chartHtml).toContain("D-4");
    expect(rowHtml).toContain("期限まで: 4日");
    expect(rowHtml).toContain("D-4");
  });
});
