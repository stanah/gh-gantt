import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskDetailPanel } from "../components/TaskDetailPanel.js";
import type { Task, Config } from "../types/index.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "TASK-1",
    type: "task",
    github_issue: 42,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: "Test Task Title",
    body: "Task description body",
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: { Status: "In Progress" },
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    date: null,
    blocked_by: [],
    _progress: 50,
    ...overrides,
  };
}

const config: Config = {
  version: "1",
  project: {
    name: "Test Project",
    github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#4a90d9", github_label: null },
    epic: { label: "Epic", display: "summary", color: "#e5a00d", github_label: "epic" },
  },
  type_hierarchy: { epic: ["task"] },
  statuses: {
    field_name: "Status",
    values: {
      "In Progress": { color: "#4a90d9", done: false },
      Done: { color: "#2ea44f", done: true },
    },
  },
  gantt: {
    default_view: "month",
    working_days: [1, 2, 3, 4, 5],
    colors: {
      critical_path: "#ff0000",
      on_track: "#00ff00",
      at_risk: "#ffaa00",
      overdue: "#ff0000",
    },
  },
};

describe("TaskDetailPanel", () => {
  it("renders title and issue number", () => {
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

    expect(html).toContain("Test Task Title");
    expect(html).toContain("#42");
  });

  it("renders description", () => {
    const task = makeTask({ body: "Important description text" });
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

    expect(html).toContain("Important description text");
  });

  it("renders sub-tasks with titles", () => {
    const childTask = makeTask({ id: "TASK-2", title: "Child Task Title", parent: "TASK-1" });
    const parentTask = makeTask({ sub_tasks: ["TASK-2"] });
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={parentTask}
        config={config}
        comments={[]}
        allTasks={[parentTask, childTask]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    expect(html).toContain("Child Task Title");
  });
});
