import { describe, it, expect } from "vitest";
import { wouldCreateParentCycle, isTypeHierarchyAllowed } from "../lib/validation.js";
import type { Task } from "../types/index.js";

function makeTask(id: string, parent: string | null = null, subTasks: string[] = []): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "owner/repo",
    parent,
    sub_tasks: subTasks,
    title: id,
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
  };
}

describe("wouldCreateParentCycle", () => {
  it("returns false for unrelated tasks", () => {
    const tasks = [makeTask("A"), makeTask("B"), makeTask("C")];
    expect(wouldCreateParentCycle(tasks, "A", "B")).toBe(false);
  });

  it("returns true for direct cycle (A -> B -> A)", () => {
    const tasks = [makeTask("A", "B"), makeTask("B")];
    // Making B's parent = A would create A->B->A
    expect(wouldCreateParentCycle(tasks, "B", "A")).toBe(true);
  });

  it("returns true for indirect cycle (A -> B -> C -> A)", () => {
    const tasks = [makeTask("A", "B"), makeTask("B", "C"), makeTask("C")];
    // Making C's parent = A would create A->B->C->A
    expect(wouldCreateParentCycle(tasks, "C", "A")).toBe(true);
  });

  it("returns false when parent chain does not reach child", () => {
    const tasks = [makeTask("A"), makeTask("B", "A"), makeTask("C")];
    // Making C's parent = B is fine: B->A (no cycle)
    expect(wouldCreateParentCycle(tasks, "C", "B")).toBe(false);
  });

  it("returns false for root-level task as new parent", () => {
    const tasks = [makeTask("A"), makeTask("B")];
    expect(wouldCreateParentCycle(tasks, "A", "B")).toBe(false);
  });

  it("handles deep chains without false positives", () => {
    const tasks = [
      makeTask("A"),
      makeTask("B", "A"),
      makeTask("C", "B"),
      makeTask("D", "C"),
      makeTask("E"),
    ];
    // Making E's parent = D is fine
    expect(wouldCreateParentCycle(tasks, "E", "D")).toBe(false);
    // Making A's parent = D would create D->C->B->A->D
    expect(wouldCreateParentCycle(tasks, "A", "D")).toBe(true);
  });
});

describe("isTypeHierarchyAllowed", () => {
  it("returns true when parent type has no entry (no restriction)", () => {
    const hierarchy = {};
    expect(isTypeHierarchyAllowed(hierarchy, "epic", "task")).toBe(true);
  });

  it("returns true when child type is in allowed list", () => {
    const hierarchy = { epic: ["task", "story"] };
    expect(isTypeHierarchyAllowed(hierarchy, "epic", "task")).toBe(true);
    expect(isTypeHierarchyAllowed(hierarchy, "epic", "story")).toBe(true);
  });

  it("returns false when child type is not in allowed list", () => {
    const hierarchy = { epic: ["task"] };
    expect(isTypeHierarchyAllowed(hierarchy, "epic", "milestone")).toBe(false);
  });

  it("returns true when allowed list is empty (no restriction)", () => {
    const hierarchy = { task: [] as string[] };
    expect(isTypeHierarchyAllowed(hierarchy, "task", "task")).toBe(true);
  });

  it("handles multiple parent types independently", () => {
    const hierarchy = { epic: ["task", "story"], task: ["subtask"] };
    expect(isTypeHierarchyAllowed(hierarchy, "epic", "task")).toBe(true);
    expect(isTypeHierarchyAllowed(hierarchy, "task", "task")).toBe(false);
    expect(isTypeHierarchyAllowed(hierarchy, "task", "subtask")).toBe(true);
  });

  it("returns true when parent type has empty array (no restriction)", () => {
    const hierarchy = { epic: [] as string[], task: ["subtask"] };
    expect(isTypeHierarchyAllowed(hierarchy, "epic", "task")).toBe(true);
    expect(isTypeHierarchyAllowed(hierarchy, "epic", "anything")).toBe(true);
  });
});
