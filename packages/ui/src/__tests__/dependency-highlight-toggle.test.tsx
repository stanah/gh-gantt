// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const dependencyGraphMocks = vi.hoisted(() => ({
  buildDependencyEdges: vi.fn(() => [
    {
      from: "stanah/gh-gantt#1",
      to: "stanah/gh-gantt#2",
      type: "finish-to-start",
      lag: 0,
    },
  ]),
  detectCycles: vi.fn(() => []),
  getEdgeCoordinates: vi.fn(() => ({ path: "M 0 0 L 10 10" })),
}));

vi.mock("../lib/dependency-graph.js", () => dependencyGraphMocks);

import { GanttChart } from "../components/GanttChart.js";
import { TaskTreeBody } from "../components/TaskTree.js";
import { useTaskFilter } from "../hooks/useTaskFilter.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";
import type { Config, Task } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";

const baseTask: Task = {
  id: "stanah/gh-gantt#1",
  type: "task",
  github_issue: 1,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "Base task",
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
  custom_fields: { Status: "Todo" },
  start_date: "2026-04-01",
  end_date: "2026-04-05",
  date: null,
  blocked_by: [],
};

const relatedTask: Task = {
  ...baseTask,
  id: "stanah/gh-gantt#2",
  github_issue: 2,
  title: "Related task",
  blocked_by: [{ task: "stanah/gh-gantt#1", type: "finish-to-start", lag: 0 }],
};

const unrelatedTask: Task = {
  ...baseTask,
  id: "stanah/gh-gantt#3",
  github_issue: 3,
  title: "Unrelated task",
  start_date: "2026-04-06",
  end_date: "2026-04-10",
};

const config: Config = {
  version: "1",
  project: {
    name: "Test Project",
    github: {
      owner: "stanah",
      repo: "gh-gantt",
      project_number: 1,
    },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: {
      start_date: "Start Date",
      end_date: "End Date",
      status: "Status",
    },
  },
  task_types: {
    task: {
      label: "Task",
      display: "bar",
      color: "#27AE60",
      github_label: null,
    },
  },
  type_hierarchy: {
    task: [],
  },
  statuses: {
    field_name: "Status",
    values: {
      Todo: {
        color: "#3498DB",
        done: false,
      },
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

const tasks = [baseTask, relatedTask, unrelatedTask];
const flatList: TreeNode[] = tasks.map((task) => ({ task, children: [], depth: 0 }));
const highlightRelationMap = new Map<string, RelationType>([[relatedTask.id, "blocked"]]);
const highlightedTaskIds = new Set([baseTask.id, relatedTask.id]);
const originalConsoleError = console.error.bind(console);

function FilterProbe() {
  const { dependencyHighlightEnabled, toggleDependencyHighlight } = useTaskFilter([]);
  return (
    <button type="button" data-testid="toggle" onClick={toggleDependencyHighlight}>
      {dependencyHighlightEnabled ? "on" : "off"}
    </button>
  );
}

describe("依存ハイライトトグル", () => {
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

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("URL パラメータがない場合は依存ハイライトを有効にする", () => {
    window.history.replaceState({}, "", "/");
    const { getByTestId } = render(<FilterProbe />);

    expect(getByTestId("toggle").textContent).toBe("on");
  });

  it("URL パラメータで依存ハイライトの OFF 状態を復元する", () => {
    window.history.replaceState({}, "", "/?dependencyHighlight=off");
    const { getByTestId } = render(<FilterProbe />);

    expect(getByTestId("toggle").textContent).toBe("off");
  });

  it("依存ハイライトの OFF 状態を URL に永続化する", () => {
    window.history.replaceState({}, "", "/");
    const { getByTestId } = render(<FilterProbe />);

    act(() => getByTestId("toggle").click());

    expect(new URL(window.location.href).searchParams.get("dependencyHighlight")).toBe("off");
  });

  it("依存ハイライトを再度 ON にすると URL パラメータを削除する", () => {
    window.history.replaceState({}, "", "/?dependencyHighlight=off");
    const { getByTestId } = render(<FilterProbe />);

    act(() => getByTestId("toggle").click());

    expect(new URL(window.location.href).searchParams.has("dependencyHighlight")).toBe(false);
  });

  it("GanttChart は ON のときホバーした非関連タスクを dim する", () => {
    const html = renderToStaticMarkup(
      <GanttChart
        tasks={tasks}
        flatList={flatList}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
        hoveredTaskId={baseTask.id}
        highlightRelationMap={highlightRelationMap}
        dependencyHighlightEnabled={true}
      />,
    );

    expect(html).toContain('opacity="0.3"');
  });

  it("GanttChart は OFF のときホバーしても非関連タスクを dim しない", () => {
    const html = renderToStaticMarkup(
      <GanttChart
        tasks={tasks}
        flatList={flatList}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
        hoveredTaskId={baseTask.id}
        highlightRelationMap={highlightRelationMap}
        dependencyHighlightEnabled={false}
      />,
    );

    expect(html).not.toContain('opacity="0.3"');
  });

  it("GanttChart は OFF のとき依存線を描画せず依存グラフも計算しない", () => {
    dependencyGraphMocks.buildDependencyEdges.mockClear();
    dependencyGraphMocks.detectCycles.mockClear();
    dependencyGraphMocks.getEdgeCoordinates.mockClear();

    renderToStaticMarkup(
      <GanttChart
        tasks={tasks}
        flatList={flatList}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
        hoveredTaskId={baseTask.id}
        dependencyHighlightEnabled={false}
      />,
    );

    expect(dependencyGraphMocks.buildDependencyEdges).not.toHaveBeenCalled();
    expect(dependencyGraphMocks.detectCycles).not.toHaveBeenCalled();
    expect(dependencyGraphMocks.getEdgeCoordinates).not.toHaveBeenCalled();
  });

  it("TaskTreeBody は ON のときホバーした非関連タスクを dim する", () => {
    const html = renderToStaticMarkup(
      <TaskTreeBody
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        flatList={flatList}
        collapsed={new Set()}
        onToggleCollapse={() => {}}
        hoveredTaskId={baseTask.id}
        highlightedTaskIds={highlightedTaskIds}
        dependencyHighlightEnabled={true}
      />,
    );

    expect(html).toContain("opacity:0.4");
  });

  it("TaskTreeBody は OFF のときホバーしても非関連タスクを dim しない", () => {
    const html = renderToStaticMarkup(
      <TaskTreeBody
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        flatList={flatList}
        collapsed={new Set()}
        onToggleCollapse={() => {}}
        hoveredTaskId={baseTask.id}
        highlightedTaskIds={highlightedTaskIds}
        dependencyHighlightEnabled={false}
      />,
    );

    expect(html).not.toContain("opacity:0.4");
  });
});
