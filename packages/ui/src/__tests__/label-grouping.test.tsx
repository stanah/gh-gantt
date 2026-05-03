// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { Toolbar } from "../components/toolbar/Toolbar.js";
import { TaskTreeBody } from "../components/TaskTree.js";
import { useTaskTree } from "../hooks/useTaskTree.js";
import type { Config, Task } from "../types/index.js";

vi.mock("../components/toolbar/ThemeToggle.js", () => ({
  ThemeToggle: () => null,
}));

afterEach(() => {
  cleanup();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1",
    type: "task",
    github_issue: 1,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "Task 1",
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
    end_date: "2026-01-02",
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
  grouping: {
    label_prefix: "pkg:",
  },
};

const groupedTasks = [
  makeTask({
    id: "owner/repo#1",
    github_issue: 1,
    title: "CLI task",
    labels: ["pkg:cli"],
  }),
  makeTask({
    id: "owner/repo#2",
    github_issue: 2,
    title: "UI task",
    labels: ["pkg:ui"],
  }),
  makeTask({
    id: "owner/repo#3",
    github_issue: 3,
    title: "Shared task",
    labels: ["pkg:cli", "pkg:ui"],
  }),
  makeTask({
    id: "owner/repo#4",
    github_issue: 4,
    title: "Other task",
    labels: [],
  }),
];

describe("[FR-VIS-013-AC1] Toolbar のラベルグルーピング切り替え", () => {
  it("grouping.label_prefix がある場合に icon button で切り替えられる", () => {
    const onToggle = vi.fn();
    const { getByLabelText } = render(
      <Toolbar
        projectName="Test Project"
        taskCount={4}
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
        allLabels={["pkg:cli", "pkg:ui"]}
        selectedLabels={[]}
        onSelectLabels={() => {}}
        labelGroupingPrefix={config.grouping?.label_prefix}
        labelGroupingEnabled={false}
        onToggleLabelGrouping={onToggle}
        searchQuery=""
        onSearchChange={() => {}}
        taskSortMode="default"
        onTaskSortModeChange={() => {}}
      />,
    );

    fireEvent.click(getByLabelText("Label Grouping: pkg:"));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("[FR-VIS-013-AC2][FR-VIS-013-AC4] useTaskTree のラベルグルーピング", () => {
  it("prefix 一致ラベルで group header を作り、複数ラベル task とその他 group を扱う", () => {
    function Probe() {
      const { flatList } = useTaskTree(groupedTasks, new Set(["task"]), {
        labelGrouping: { enabled: true, labelPrefix: "pkg:" },
      });
      return (
        <output>
          {flatList
            .map((node) => `${node.kind === "group" ? "group" : "task"}:${node.task.title}`)
            .join("|")}
        </output>
      );
    }

    const html = renderToStaticMarkup(<Probe />);

    expect(html).toContain("group:pkg:cli|task:CLI task|task:Shared task");
    expect(html).toContain("group:pkg:ui|task:UI task|task:Shared task");
    expect(html).toContain("group:その他|task:Other task");
  });
});

describe("[FR-VIS-013-AC3] グループヘッダーの折りたたみ", () => {
  it("TaskTreeBody は group header を表示しクリックで折りたたみを切り替える", () => {
    function Probe() {
      const { flatList, collapsed, toggle } = useTaskTree(groupedTasks, new Set(["task"]), {
        labelGrouping: { enabled: true, labelPrefix: "pkg:" },
      });
      return (
        <TaskTreeBody
          config={config}
          selectedTaskId={null}
          onSelectTask={() => {}}
          flatList={flatList}
          collapsed={collapsed}
          onToggleCollapse={toggle}
          totalTaskCount={groupedTasks.length}
        />
      );
    }

    const { getByText, queryByText } = render(<Probe />);

    expect(getByText("pkg:cli")).toBeTruthy();
    expect(getByText("CLI task")).toBeTruthy();

    fireEvent.click(getByText("pkg:cli"));

    expect(queryByText("CLI task")).toBeNull();
    expect(getByText("pkg:ui")).toBeTruthy();
  });
});
