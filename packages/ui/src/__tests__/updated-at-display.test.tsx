import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskRow } from "../components/TaskRow.js";
import { TaskDetailPanel } from "../components/TaskDetailPanel.js";
import { Toolbar } from "../components/toolbar/Toolbar.js";
import { useTaskTree } from "../hooks/useTaskTree.js";
import type { Config, Task } from "../types/index.js";

vi.mock("../components/toolbar/ThemeToggle.js", () => ({
  ThemeToggle: () => null,
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1",
    type: "task",
    github_issue: 1,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "更新日時つきタスク",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T03:04:05Z",
    closed_at: null,
    custom_fields: { Status: "Todo" },
    start_date: "2026-01-01",
    end_date: "2026-01-03",
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

const config: Config = {
  version: "1",
  project: { name: "Test Project", github: { owner: "owner", repo: "repo", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
  },
  type_hierarchy: {},
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

describe("[FR-VIS-006-AC2] 更新日時表示", () => {
  it("TaskRow はホバー時に更新日時をツールチップ表示する", () => {
    const task = makeTask();
    const html = renderToStaticMarkup(
      <TaskRow
        task={task}
        depth={0}
        hasChildren={false}
        isCollapsed={false}
        onToggle={() => {}}
        onClick={() => {}}
        isSelected={false}
        isHovered={true}
        statusFieldName="Status"
        statusValues={config.statuses.values}
        taskType={config.task_types.task}
      />,
    );

    expect(html).toContain("Updated");
    expect(html).toContain("2026-01-02 03:04 UTC");
  });

  it("TaskDetailPanel は更新日時を表示する", () => {
    const task = makeTask();
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={task}
        config={config}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    expect(html).toContain("Updated");
    expect(html).toContain("2026-01-02 03:04 UTC");
  });
});

describe("[FR-VIS-003-AC2] 更新日時ソート", () => {
  it("Toolbar は更新日時の昇順・降順ソートを選べる", () => {
    const html = renderToStaticMarkup(
      <Toolbar
        projectName="Test Project"
        taskCount={3}
        activeScale="month"
        onScaleChange={() => {}}
        onScrollToToday={() => {}}
        onPull={() => {}}
        onPush={() => {}}
        syncing={null}
        displayOptions={new Set()}
        onToggleDisplayOption={() => {}}
        dependencyHighlightEnabled={true}
        onToggleDependencyHighlight={() => {}}
        hideClosed={false}
        onToggleHideClosed={() => {}}
        taskTypes={config.task_types}
        enabledTypes={new Set(["task"])}
        onToggleType={() => {}}
        selectedAssignee={null}
        allAssignees={[]}
        onSelectAssignee={() => {}}
        searchQuery=""
        onSearchChange={() => {}}
        taskSortMode="default"
        onTaskSortModeChange={() => {}}
      />,
    );

    expect(html).toContain("Updated ↑");
    expect(html).toContain("Updated ↓");
  });

  it("useTaskTree は更新日時の降順でタスクを並べ替える", () => {
    const tasks = [
      makeTask({ id: "owner/repo#1", updated_at: "2026-01-01T00:00:00Z" }),
      makeTask({ id: "owner/repo#2", updated_at: "2026-01-03T00:00:00Z" }),
      makeTask({ id: "owner/repo#3", updated_at: "2026-01-02T00:00:00Z" }),
    ];

    function TaskTreeProbe() {
      const { flatList } = useTaskTree(tasks, new Set(["task"]), {
        taskSortMode: "updated_at_desc",
      });
      return <output>{flatList.map((node) => node.task.id).join(",")}</output>;
    }

    const html = renderToStaticMarkup(<TaskTreeProbe />);

    expect(html).toContain("owner/repo#2,owner/repo#3,owner/repo#1");
  });
});
