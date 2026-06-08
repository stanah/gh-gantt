// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
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

afterEach(() => cleanup());

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

describe("[FR-VIS-024] Project Map フィルタ (PM-08)", () => {
  it("検索でタスクが絞り込まれ、System Tree / Board に一貫適用される", () => {
    const { container } = renderPage(null);
    const board = container.querySelector('[aria-label="Project Board"]') as HTMLElement;
    const tree = container.querySelector('[aria-label="System Tree"]') as HTMLElement;
    expect(board.textContent).toContain("UI Shell");

    const search = container.querySelector(
      'input[aria-label="Project Map 検索"]',
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "ViewModel" } });

    // ViewModel に一致しない "UI Shell" は Board から消える
    expect(board.textContent).not.toContain("UI Shell");
    // 一致する ViewModel と、その祖先 Epic A は Tree に残る
    expect(tree.textContent).toContain("Epic A");
    expect(tree.textContent).toContain("ViewModel");
  });

  it("readiness フィルタ (Blocked) で該当列以外のタスクが除外される", () => {
    const { container } = renderPage(null);
    const filterGroup = container.querySelector('[aria-label="Readiness フィルタ"]') as HTMLElement;
    // t1=Done, t2=Ready。Blocked フィルタでは両方除外される
    fireEvent.click(within(filterGroup).getByText("Blocked"));
    const board = container.querySelector('[aria-label="Project Board"]') as HTMLElement;
    expect(board.textContent).not.toContain("UI Shell");
  });

  it("マッチ件数が表示される", () => {
    const { container } = renderPage(null);
    // 全 3 タスク
    expect(container.textContent).toContain("3/3 件");
  });
});

describe("[FR-VIS-025] Project Map の Group by 軸セレクタ (GRP-02)", () => {
  it("Group by を type に切り替えると System Tree がグループ表示になる", () => {
    const { container } = renderPage(null);
    const tree = container.querySelector('[aria-label="System Tree"]') as HTMLElement;
    // 既定は階層表示
    expect(tree.textContent).toContain("構造を探索");

    const select = container.querySelector('select[aria-label="Group by 軸"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "type" } });

    // グループ表示に切り替わり、タイプ別グループ見出しが出る
    expect(tree.textContent).toContain("グループ表示");
    expect(tree.textContent).toContain("Epic");
    expect(tree.textContent).toContain("Task");
  });

  it("Group by セレクタに組み込み軸が並ぶ", () => {
    const { container } = renderPage(null);
    const select = container.querySelector('select[aria-label="Group by 軸"]') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("hierarchy");
    expect(values).toContain("type");
    expect(values).toContain("status");
  });

  it("Group by 時に Project Board がスイムレーン表示になる (GRP-03)", () => {
    const { container } = renderPage(null);
    const board = container.querySelector('[aria-label="Project Board"]') as HTMLElement;
    // 既定（hierarchy）はスイムレーンなし
    expect(board.querySelector("[data-lane]")).toBeNull();

    const select = container.querySelector('select[aria-label="Group by 軸"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "type" } });

    expect(board.textContent).toContain("スイムレーン");
    expect(board.querySelector("[data-lane]")).not.toBeNull();
    expect(board.textContent).toContain("UI Shell");
  });
});
