// @vitest-environment jsdom
import React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GanttChart } from "../components/GanttChart.js";
import { TaskRow } from "../components/TaskRow.js";
import { useTaskTree } from "../hooks/useTaskTree.js";
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
    end_date: "2026-01-03",
    date: null,
    blocked_by: [],
    ...options,
  };
}

describe("[FR-VIS-015-AC1] 未スケジュール子タスクのツリー分類", () => {
  it("スケジュール済み親タスク配下の未スケジュール子タスクを親ツリーに残して識別する", () => {
    const parent = makeTask("stanah/gh-gantt#1", {
      title: "スケジュール済み親",
      sub_tasks: ["stanah/gh-gantt#2"],
    });
    const child = makeTask("stanah/gh-gantt#2", {
      title: "未スケジュール子",
      parent: parent.id,
      start_date: null,
      end_date: null,
    });
    const rootBacklog = makeTask("stanah/gh-gantt#3", {
      title: "親なし未スケジュール",
      start_date: null,
      end_date: null,
    });

    function Probe() {
      const { flatList } = useTaskTree([parent, child, rootBacklog], new Set(["task"]));
      return (
        <output>
          {flatList
            .map((node) => `${node.task.title}:${node.depth}:${node.scheduleState}`)
            .join("|")}
        </output>
      );
    }

    const html = renderToStaticMarkup(<Probe />);

    expect(html).toContain(
      "スケジュール済み親:0:scheduled|未スケジュール子:1:unscheduled_child|親なし未スケジュール:0:unscheduled_root",
    );
  });
});

describe("[FR-VIS-015-AC2] ツリー内未スケジュール子タスクの視覚表示", () => {
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

  it("TaskRow はツリー内未スケジュール子タスクに状態属性とラベルを表示する", () => {
    const task = makeTask("stanah/gh-gantt#2", {
      title: "未スケジュール子",
      start_date: null,
      end_date: null,
    });

    const html = renderToStaticMarkup(
      <TaskRow
        task={task}
        depth={1}
        hasChildren={false}
        isCollapsed={false}
        onToggle={() => {}}
        onClick={() => {}}
        isSelected={false}
        statusFieldName="Status"
        statusValues={config.statuses.values}
        taskType={config.task_types.task}
        scheduleState="unscheduled_child"
      />,
    );

    expect(html).toContain('data-schedule-state="unscheduled_child"');
    expect(html).toContain("未スケジュール");
  });

  it("GanttChart はツリー内未スケジュール子タスクの行にプレースホルダーを表示する", () => {
    const parent = makeTask("stanah/gh-gantt#1", {
      title: "スケジュール済み親",
      sub_tasks: ["stanah/gh-gantt#2"],
    });
    const child = makeTask("stanah/gh-gantt#2", {
      title: "未スケジュール子",
      parent: parent.id,
      start_date: null,
      end_date: null,
    });
    const flatList: TreeNode[] = [
      { task: parent, children: [], depth: 0, scheduleState: "scheduled" },
      { task: child, children: [], depth: 1, scheduleState: "unscheduled_child" },
    ];

    const html = renderToStaticMarkup(
      <GanttChart
        tasks={[parent, child]}
        flatList={flatList}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
        dependencyHighlightEnabled={false}
      />,
    );

    expect(html).toContain('data-unscheduled-placeholder="stanah/gh-gantt#2"');
  });
});
