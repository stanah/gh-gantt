import { describe, it, expect } from "vitest";
import { buildDraftTaskId, isDraftTask, getNextDraftNumber } from "../github/issues.js";
import { replaceTaskIdReferences } from "../sync/push-executor.js";
import type { Task } from "@gh-gantt/shared";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1",
    type: "task",
    github_issue: 1,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "Test task",
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
  };
}

describe("buildDraftTaskId", () => {
  it("generates correct draft ID format", () => {
    expect(buildDraftTaskId("owner/repo", 1)).toBe("owner/repo#draft-1");
    expect(buildDraftTaskId("owner/repo", 42)).toBe("owner/repo#draft-42");
  });
});

describe("isDraftTask", () => {
  it("returns true for draft task IDs", () => {
    expect(isDraftTask("owner/repo#draft-1")).toBe(true);
    expect(isDraftTask("owner/repo#draft-99")).toBe(true);
  });

  it("returns false for regular task IDs", () => {
    expect(isDraftTask("owner/repo#1")).toBe(false);
    expect(isDraftTask("owner/repo#42")).toBe(false);
  });

  it("returns false for malformed IDs", () => {
    expect(isDraftTask("no-hash")).toBe(false);
    expect(isDraftTask("owner/repo#draftx-1")).toBe(false);
  });
});

describe("getNextDraftNumber", () => {
  it("returns 1 when no drafts exist", () => {
    const tasks = [makeTask({ id: "owner/repo#1" })];
    expect(getNextDraftNumber(tasks)).toBe(1);
  });

  it("returns max + 1", () => {
    const tasks = [
      makeTask({ id: "owner/repo#draft-1" }),
      makeTask({ id: "owner/repo#draft-3" }),
      makeTask({ id: "owner/repo#draft-2" }),
    ];
    expect(getNextDraftNumber(tasks)).toBe(4);
  });

  it("ignores non-draft tasks", () => {
    const tasks = [
      makeTask({ id: "owner/repo#100" }),
      makeTask({ id: "owner/repo#draft-5" }),
    ];
    expect(getNextDraftNumber(tasks)).toBe(6);
  });
});

describe("replaceTaskIdReferences", () => {
  it("replaces parent reference", () => {
    const tasks = [
      makeTask({ id: "owner/repo#2", parent: "owner/repo#draft-1" }),
    ];
    replaceTaskIdReferences(tasks, "owner/repo#draft-1", "owner/repo#42");
    expect(tasks[0].parent).toBe("owner/repo#42");
  });

  it("replaces sub_tasks reference", () => {
    const tasks = [
      makeTask({ id: "owner/repo#1", sub_tasks: ["owner/repo#draft-1", "owner/repo#3"] }),
    ];
    replaceTaskIdReferences(tasks, "owner/repo#draft-1", "owner/repo#42");
    expect(tasks[0].sub_tasks).toEqual(["owner/repo#42", "owner/repo#3"]);
  });

  it("replaces blocked_by reference", () => {
    const tasks = [
      makeTask({
        id: "owner/repo#2",
        blocked_by: [{ task: "owner/repo#draft-1", type: "finish-to-start", lag: 0 }],
      }),
    ];
    replaceTaskIdReferences(tasks, "owner/repo#draft-1", "owner/repo#42");
    expect(tasks[0].blocked_by[0].task).toBe("owner/repo#42");
  });

  it("does not modify unrelated references", () => {
    const tasks = [
      makeTask({ id: "owner/repo#2", parent: "owner/repo#1", sub_tasks: ["owner/repo#3"] }),
    ];
    replaceTaskIdReferences(tasks, "owner/repo#draft-1", "owner/repo#42");
    expect(tasks[0].parent).toBe("owner/repo#1");
    expect(tasks[0].sub_tasks).toEqual(["owner/repo#3"]);
  });
});
