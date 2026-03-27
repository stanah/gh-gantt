import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailSubTasks } from "../components/detail/DetailSubTasks.js";
import type { Task } from "../types/index.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    type: "task",
    github_issue: null,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "Default Title",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

describe("DetailSubTasks", () => {
  it("renders nothing when subTaskIds is empty", () => {
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={[]} allTasks={[]} onSelectTask={vi.fn()} />,
    );
    expect(html).toBe("");
  });

  it("renders header with sub-task count", () => {
    const task = makeTask({ id: "task-2", title: "Child Task", github_issue: 42 });
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={["task-2"]} allTasks={[task]} onSelectTask={vi.fn()} />,
    );
    expect(html).toContain("Sub-tasks (1)");
  });

  it("renders task title and issue number", () => {
    const task = makeTask({ id: "task-2", title: "My Sub Task", github_issue: 99 });
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={["task-2"]} allTasks={[task]} onSelectTask={vi.fn()} />,
    );
    expect(html).toContain("My Sub Task");
    expect(html).toContain("#99");
  });

  it("renders task without issue number when github_issue is null", () => {
    const task = makeTask({ id: "task-3", title: "No Issue Task", github_issue: null });
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={["task-3"]} allTasks={[task]} onSelectTask={vi.fn()} />,
    );
    expect(html).toContain("No Issue Task");
    expect(html).not.toContain("#null");
  });

  it("renders nested sub-tasks (recursive)", () => {
    const child = makeTask({
      id: "child-1",
      title: "Child Task",
      github_issue: 10,
      sub_tasks: ["grandchild-1"],
    });
    const grandchild = makeTask({ id: "grandchild-1", title: "Grandchild Task", github_issue: 11 });
    const html = renderToStaticMarkup(
      <DetailSubTasks
        subTaskIds={["child-1"]}
        allTasks={[child, grandchild]}
        onSelectTask={vi.fn()}
      />,
    );
    expect(html).toContain("Child Task");
    expect(html).toContain("Grandchild Task");
    expect(html).toContain("#10");
    expect(html).toContain("#11");
  });

  it("renders closed state badge for closed task", () => {
    const task = makeTask({
      id: "task-closed",
      title: "Closed Task",
      state: "closed",
      github_issue: 5,
    });
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={["task-closed"]} allTasks={[task]} onSelectTask={vi.fn()} />,
    );
    expect(html).toContain("Closed");
  });

  it("renders open state badge for open task", () => {
    const task = makeTask({ id: "task-open", title: "Open Task", state: "open", github_issue: 6 });
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={["task-open"]} allTasks={[task]} onSelectTask={vi.fn()} />,
    );
    expect(html).toContain("Open");
  });

  it("renders multiple sub-tasks", () => {
    const task1 = makeTask({ id: "task-a", title: "Task Alpha", github_issue: 1 });
    const task2 = makeTask({ id: "task-b", title: "Task Beta", github_issue: 2 });
    const html = renderToStaticMarkup(
      <DetailSubTasks
        subTaskIds={["task-a", "task-b"]}
        allTasks={[task1, task2]}
        onSelectTask={vi.fn()}
      />,
    );
    expect(html).toContain("Sub-tasks (2)");
    expect(html).toContain("Task Alpha");
    expect(html).toContain("Task Beta");
  });
});
