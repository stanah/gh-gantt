import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GanttChart } from "../components/GanttChart.js";
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

describe("Sprint display integration", () => {
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation((message: unknown, ...args: unknown[]) => {
      if (typeof message === "string" && message.includes("useLayoutEffect does nothing on the server")) {
        return;
      }
      originalConsoleError(message, ...args);
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("passes sprint config into the gantt grid rendering", () => {
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

    expect(html).toContain("#123456");
  });

  it("reserves extra task tree header height when sprint bands are enabled", () => {
    const html = renderToStaticMarkup(
      <TaskTreeHeader
        config={config}
        enabledTypes={new Set(["task"])}
        onToggleType={() => {}}
      />,
    );

    expect(html).toContain("height:52px");
    expect(html).toContain("padding-top:20px");
  });
});
