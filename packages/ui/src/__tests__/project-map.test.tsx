// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, fireEvent } from "@testing-library/react";
import { buildProjectMapViewModel } from "@gh-gantt/shared";
import { ProjectMapPage } from "../components/project-map/ProjectMapPage.js";
import type { Config, Task } from "../types/index.js";

const baseTask = (overrides: Partial<Task>): Task => ({
  id: "T",
  type: "task",
  github_issue: 1,
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
    epic: { label: "Epic", display: "summary", color: "#8957e5", github_label: null },
    task: { label: "Task", display: "bar", color: "#27ae60", github_label: null },
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
    colors: {
      critical_path: "#E74C3C",
      on_track: "#2ECC71",
      at_risk: "#F39C12",
      overdue: "#E74C3C",
    },
  },
};

function sampleTasks(): Task[] {
  return [
    baseTask({ id: "epic", type: "epic", title: "Epic A", sub_tasks: ["t1", "t2"] }),
    baseTask({ id: "t1", parent: "epic", title: "ViewModel", custom_fields: { Status: "Done" } }),
    baseTask({
      id: "t2",
      parent: "epic",
      title: "UI Shell",
      custom_fields: { Status: "Todo" },
      blocked_by: [{ task: "t1", type: "finish-to-start", lag: 0 }],
    }),
  ];
}

function renderPage(selectedTaskId: string | null, onSelectTask = vi.fn()) {
  const vm = buildProjectMapViewModel(sampleTasks(), config);
  const result = render(
    <ProjectMapPage
      viewModel={vm}
      config={config}
      selectedTaskId={selectedTaskId}
      onSelectTask={onSelectTask}
    />,
  );
  return { ...result, onSelectTask };
}

describe("[FR-VIS-024] Project Map ページ", () => {
  it("5 パネルのレイアウトと System Tree のタスクが描画される", () => {
    const { container, getByText } = renderPage(null);
    expect(container.querySelector('[data-testid="project-map-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-map-layout"]')).not.toBeNull();
    expect(getByText("Epic A")).toBeTruthy();
    expect(getByText("System Tree")).toBeTruthy();
    expect(getByText("Project Board")).toBeTruthy();
    expect(getByText("Dependency Map")).toBeTruthy();
    expect(getByText("Next Actions")).toBeTruthy();
    expect(getByText("Compact Gantt")).toBeTruthy();
  });

  it("依存解除済みでない t2 は Ready Now ではなく Blocked 列に出る（t1 完了済みなら Ready）", () => {
    // t1 は Done なので t2 の依存は解除済み → t2 は Ready Now 列
    const { container } = renderPage(null);
    const readyColumn = container.querySelector('[data-column="ready_now"]');
    expect(readyColumn?.textContent).toContain("UI Shell");
  });

  it("System Tree のノードクリックで onSelectTask が呼ばれる", () => {
    const { container, onSelectTask } = renderPage(null);
    const node = container.querySelector('[data-task-id="t2"]');
    expect(node).not.toBeNull();
    fireEvent.click(node!);
    expect(onSelectTask).toHaveBeenCalledWith("t2");
  });

  it("Next Actions に着手可能なタスクが推薦される", () => {
    const { container } = renderPage(null);
    const next = container.querySelector('[aria-label="Next Actions"]');
    expect(next?.textContent).toContain("UI Shell");
  });
});
