import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailRelations } from "../components/detail/DetailRelations.js";
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

describe("DetailRelations", () => {
  it("returns null when both blockedBy and linkedPrs are empty", () => {
    const html = renderToStaticMarkup(
      <DetailRelations
        blockedBy={[]}
        linkedPrs={[]}
        allTasks={[]}
        onSelectTask={vi.fn()}
        githubRepo="owner/repo"
      />,
    );
    expect(html).toBe("");
  });

  it("renders Blocked by section title", () => {
    const blocker = makeTask({ id: "owner/repo#10", title: "Blocker Task", github_issue: 10 });
    const html = renderToStaticMarkup(
      <DetailRelations
        blockedBy={[{ task: "owner/repo#10" }]}
        linkedPrs={[]}
        allTasks={[blocker]}
        onSelectTask={vi.fn()}
        githubRepo="owner/repo"
      />,
    );
    expect(html).toContain("Blocked by");
    expect(html).toContain("Blocker Task");
    expect(html).toContain("#10");
  });

  it("renders Linked PRs with correct links", () => {
    const html = renderToStaticMarkup(
      <DetailRelations
        blockedBy={[]}
        linkedPrs={[42, 99]}
        allTasks={[]}
        onSelectTask={vi.fn()}
        githubRepo="stanah/gh-gantt"
      />,
    );
    expect(html).toContain("Linked PRs");
    expect(html).toContain("https://github.com/stanah/gh-gantt/pull/42");
    expect(html).toContain("https://github.com/stanah/gh-gantt/pull/99");
    expect(html).toContain("#42");
    expect(html).toContain("#99");
  });
});
