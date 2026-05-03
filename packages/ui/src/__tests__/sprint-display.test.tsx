import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { scaleTime } from "d3-scale";
import { GanttChart } from "../components/GanttChart.js";
import { GanttGrid } from "../components/GanttGrid.js";
import { GanttTimeline } from "../components/GanttTimeline.js";
import { TaskTreeHeader } from "../components/TaskTree.js";
import type { Config, Task } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";

const task: Task = {
  id: "TASK-1",
  type: "task",
  github_issue: 1,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "Sprint-aware task",
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
  start_date: "2026-04-01",
  end_date: "2026-04-08",
  date: null,
  blocked_by: [],
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
  sprints: [
    {
      name: "Sprint 1",
      start_date: "2026-04-01",
      end_date: "2026-04-14",
      color: "#123456",
    },
  ],
};

const flatList: TreeNode[] = [
  {
    task,
    children: [],
    depth: 0,
  },
];

const originalConsoleError = console.error.bind(console);
const dateRange: [Date, Date] = [new Date(2026, 3, 1), new Date(2026, 3, 30)];
const xScale = scaleTime().domain(dateRange).range([0, 300]);

describe("Sprint display integration", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 7));
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("[FR-VIS-010-AC1][FR-VIS-010-AC2] sprint config をヘッダーとグリッド背景に表示し、現在 sprint を強調する", () => {
    const headerHtml = renderToStaticMarkup(
      <GanttTimeline
        xScale={xScale}
        dateRange={dateRange}
        viewScale="month"
        totalWidth={300}
        sprints={config.sprints}
      />,
    );
    const gridHtml = renderToStaticMarkup(
      <GanttGrid
        xScale={xScale}
        dateRange={dateRange}
        totalWidth={300}
        totalHeight={84}
        workingDays={config.gantt.working_days}
        pixelsPerDay={10}
        sprints={config.sprints}
      />,
    );
    const html = renderToStaticMarkup(
      <GanttChart
        tasks={[task]}
        flatList={flatList}
        config={config}
        selectedTaskId={null}
        onSelectTask={() => {}}
        header={() => {}}
      />,
    );

    expect(headerHtml).toContain("Sprint 1");
    expect(headerHtml).toContain("#123456");
    expect(headerHtml).toContain('fill-opacity="0.34"');
    expect(gridHtml).toContain("#123456");
    expect(gridHtml).toContain('fill-opacity="0.09"');
    expect(html).toContain("#123456");
  });

  it("[FR-VIS-010-AC1] sprint band 有効時はタスクツリーヘッダーに同じ高さを確保する", () => {
    const html = renderToStaticMarkup(<TaskTreeHeader config={config} />);

    expect(html).toContain("height:52px");
    expect(html).toContain("padding-top:20px");
  });

  it("[FR-VIS-010-AC3] sprint 未設定時は sprint band と追加ヘッダー余白を出さない", () => {
    const configWithoutSprints: Config = { ...config, sprints: undefined };
    const headerHtml = renderToStaticMarkup(
      <GanttTimeline
        xScale={xScale}
        dateRange={dateRange}
        viewScale="month"
        totalWidth={300}
        sprints={configWithoutSprints.sprints}
      />,
    );
    const gridHtml = renderToStaticMarkup(
      <GanttGrid
        xScale={xScale}
        dateRange={dateRange}
        totalWidth={300}
        totalHeight={84}
        workingDays={config.gantt.working_days}
        pixelsPerDay={10}
        sprints={configWithoutSprints.sprints}
      />,
    );
    const treeHeaderHtml = renderToStaticMarkup(<TaskTreeHeader config={configWithoutSprints} />);

    expect(headerHtml).not.toContain("Sprint 1");
    expect(headerHtml).not.toContain("#123456");
    expect(gridHtml).not.toContain("#123456");
    expect(treeHeaderHtml).toContain("height:32px");
    expect(treeHeaderHtml).not.toContain("padding-top:20px");
  });
});
