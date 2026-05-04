// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config, Task } from "@gh-gantt/shared";
import { Toolbar } from "../components/toolbar/Toolbar.js";
import { downloadGanttExport } from "../lib/export-download.js";

vi.mock("../components/toolbar/ThemeToggle.js", () => ({
  ThemeToggle: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

const config: Config = {
  version: "1",
  project: {
    name: "Export Project",
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

const task: Task = {
  id: "stanah/gh-gantt#20",
  type: "task",
  github_issue: 20,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "SVG/PNGエクスポート",
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
  start_date: "2026-05-04",
  end_date: "2026-05-08",
  date: null,
  blocked_by: [],
};

describe("[FR-VIS-019-AC4] Toolbar のエクスポートメニュー", () => {
  it("形式・範囲・2x オプションを選んで export handler に渡せる", () => {
    const onExport = vi.fn();
    const { getByLabelText, getByTitle } = render(
      <Toolbar
        projectName="Test Project"
        taskCount={1}
        activeScale="month"
        onScaleChange={() => {}}
        onScrollToToday={() => {}}
        onPull={() => {}}
        onPush={() => {}}
        syncing={null}
        displayOptions={new Set()}
        onToggleDisplayOption={() => {}}
        dependencyHighlightEnabled={false}
        onToggleDependencyHighlight={() => {}}
        hideClosed={false}
        onToggleHideClosed={() => {}}
        taskTypes={{
          task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
        }}
        enabledTypes={new Set(["task"])}
        onToggleType={() => {}}
        selectedAssignee={null}
        allAssignees={[]}
        onSelectAssignee={() => {}}
        searchQuery=""
        onSearchChange={() => {}}
        taskSortMode="default"
        onTaskSortModeChange={() => {}}
        onExport={onExport}
      />,
    );

    fireEvent.click(getByTitle("Export"));
    fireEvent.change(getByLabelText("Export format"), { target: { value: "png" } });
    fireEvent.change(getByLabelText("Export scope"), { target: { value: "project" } });
    fireEvent.click(getByLabelText("High resolution 2x"));
    fireEvent.click(getByLabelText("Run export"));

    expect(onExport).toHaveBeenCalledWith({
      format: "png",
      scope: "project",
      scaleFactor: 2,
    });
  });

  it("SVG ダウンロードの Blob URL はクリック直後ではなく次 tick で revoke する", async () => {
    vi.useFakeTimers();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:gh-gantt-export"),
      revokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadGanttExport({
      tasks: [task],
      visibleNodes: [{ task, depth: 0 }],
      config,
      request: { format: "svg", scope: "project", scaleFactor: 1 },
      viewScale: "month",
    });

    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:gh-gantt-export");
  });
});
