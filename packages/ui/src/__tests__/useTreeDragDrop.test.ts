import { describe, expect, it } from "vitest";
import type { Task } from "../types/index.js";
import { shouldHandleRootDrop } from "../hooks/useTreeDragDrop.js";

describe("shouldHandleRootDrop", () => {
  const tasks: Task[] = [
    {
      id: "root",
      type: "task",
      github_issue: null,
      github_repo: "o/r",
      parent: null,
      sub_tasks: [],
      title: "Root Task",
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
      start_date: "2026-01-01",
      end_date: "2026-01-02",
      date: null,
      blocked_by: [],
    },
    {
      id: "child",
      type: "task",
      github_issue: null,
      github_repo: "o/r",
      parent: "root",
      sub_tasks: [],
      title: "Child Task",
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
      start_date: "2026-01-01",
      end_date: "2026-01-02",
      date: null,
      blocked_by: [],
    },
  ];

  it("returns false for root tasks", () => {
    expect(shouldHandleRootDrop(tasks, "root")).toBe(false);
  });

  it("returns true for children", () => {
    expect(shouldHandleRootDrop(tasks, "child")).toBe(true);
  });

  it("returns false when dragId is missing", () => {
    expect(shouldHandleRootDrop(tasks, null)).toBe(false);
    expect(shouldHandleRootDrop(tasks, "missing")).toBe(false);
  });
});
