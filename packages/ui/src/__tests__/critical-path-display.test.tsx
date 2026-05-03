import React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GanttChart } from "../components/GanttChart.js";
import { GanttTooltip } from "../components/GanttTooltip.js";
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: { Status: "Todo" },
    start_date: "2026-01-01",
    end_date: "2026-01-01",
    date: null,
    blocked_by: [],
    ...options,
  };
}

function flatList(tasks: Task[]): TreeNode[] {
  return tasks.map((task) => ({ task, children: [], depth: 0 }));
}

describe("クリティカルパス表示", () => {
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

  it("[FR-VIS-014-AC2] critical task と blocked_by edge を赤色強調対象として描画する", () => {
    const tasks = [
      makeTask("stanah/gh-gantt#1", { start_date: "2026-01-01", end_date: "2026-01-02" }),
      makeTask("stanah/gh-gantt#2", {
        start_date: "2026-01-03",
        end_date: "2026-01-05",
        blocked_by: [{ task: "stanah/gh-gantt#1", type: "finish-to-start", lag: 0 }],
      }),
      makeTask("stanah/gh-gantt#3", { start_date: "2026-01-01", end_date: "2026-01-01" }),
    ];

    const html = renderToStaticMarkup(
      <GanttChart
        tasks={tasks}
        flatList={flatList(tasks)}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
        dependencyHighlightEnabled={true}
      />,
    );

    expect(html.match(/data-critical-path="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(html).toContain("#E74C3C");
  });

  it("[FR-VIS-014-AC3] tooltip に total float を表示する", () => {
    const task = makeTask("stanah/gh-gantt#1");

    const html = renderToStaticMarkup(
      <GanttTooltip
        task={task}
        taskType={config.task_types.task}
        x={100}
        y={100}
        criticalPathTiming={{
          taskId: task.id,
          durationDays: 1,
          earlyStart: 0,
          earlyFinish: 1,
          lateStart: 0,
          lateFinish: 1,
          totalFloat: 0,
          isCritical: true,
        }}
      />,
    );

    expect(html).toContain("Critical path");
    expect(html).toContain("Float: 0d");
  });

  it("[FR-VIS-014-AC4] 循環依存がある場合はチャート上に警告を表示する", () => {
    const tasks = [
      makeTask("stanah/gh-gantt#1", {
        blocked_by: [{ task: "stanah/gh-gantt#2", type: "finish-to-start", lag: 0 }],
      }),
      makeTask("stanah/gh-gantt#2", {
        blocked_by: [{ task: "stanah/gh-gantt#1", type: "finish-to-start", lag: 0 }],
      }),
    ];

    const html = renderToStaticMarkup(
      <GanttChart
        tasks={tasks}
        flatList={flatList(tasks)}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
        dependencyHighlightEnabled={true}
      />,
    );

    expect(html).toContain("循環依存があるためクリティカルパスを計算できません");
  });
});
