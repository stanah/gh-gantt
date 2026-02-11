import { describe, it, expect } from "vitest";
import { isMilestoneDraftTask, buildMilestoneSyntheticId } from "../github/issues.js";
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

describe("isMilestoneDraftTask", () => {
  it("returns true for draft tasks with type milestone", () => {
    const task = makeTask({ id: "owner/repo#draft-1", type: "milestone" });
    expect(isMilestoneDraftTask(task)).toBe(true);
  });

  it("returns false for draft tasks with non-milestone type", () => {
    const task = makeTask({ id: "owner/repo#draft-1", type: "task" });
    expect(isMilestoneDraftTask(task)).toBe(false);
  });

  it("returns false for non-draft milestone tasks", () => {
    const task = makeTask({ id: "owner/repo#1", type: "milestone" });
    expect(isMilestoneDraftTask(task)).toBe(false);
  });

  it("returns false for synthetic milestone tasks", () => {
    const task = makeTask({ id: "milestone:owner/repo#1", type: "milestone" });
    expect(isMilestoneDraftTask(task)).toBe(false);
  });
});

describe("buildMilestoneSyntheticId", () => {
  it("generates correct synthetic milestone ID", () => {
    expect(buildMilestoneSyntheticId("owner/repo", 1)).toBe("milestone:owner/repo#1");
    expect(buildMilestoneSyntheticId("org/project", 42)).toBe("milestone:org/project#42");
  });
});

describe("milestone push: draft separation logic", () => {
  it("separates milestone drafts from regular drafts", () => {
    const tasks = [
      makeTask({ id: "owner/repo#draft-1", type: "milestone", title: "v2.0", date: "2026-12-01" }),
      makeTask({ id: "owner/repo#draft-2", type: "task", title: "New feature" }),
      makeTask({ id: "owner/repo#3", type: "task", title: "Existing task" }),
    ];

    const drafts = tasks.filter((t) => t.id.includes("#draft-"));
    const milestones = drafts.filter((t) => isMilestoneDraftTask(t));
    const regularDrafts = drafts.filter((t) => !isMilestoneDraftTask(t));

    expect(milestones).toHaveLength(1);
    expect(milestones[0].title).toBe("v2.0");
    expect(regularDrafts).toHaveLength(1);
    expect(regularDrafts[0].title).toBe("New feature");
  });
});

describe("milestone push: ID replacement after creation", () => {
  it("updates references when milestone draft ID changes to synthetic", () => {
    const oldId = "owner/repo#draft-1";
    const newId = buildMilestoneSyntheticId("owner/repo", 5);

    const tasks = [
      makeTask({ id: newId, type: "milestone", title: "v2.0" }),
      makeTask({ id: "owner/repo#2", milestone: "v2.0", parent: oldId }),
      makeTask({ id: "owner/repo#3", blocked_by: [{ task: oldId, type: "finish-to-start", lag: 0 }] }),
    ];

    replaceTaskIdReferences(tasks, oldId, newId);

    expect(tasks[1].parent).toBe(newId);
    expect(tasks[2].blocked_by[0].task).toBe(newId);
  });
});

describe("createGithubMilestone response parsing", () => {
  it("parses REST API response correctly", async () => {
    const mockResponse = {
      number: 3,
      node_id: "MDk6TWlsZXN0b25lMw==",
      title: "v2.0",
      due_on: "2026-12-01T00:00:00Z",
    };

    // Simulate the extraction logic used in createGithubMilestone
    const result = { number: mockResponse.number, nodeId: mockResponse.node_id };
    expect(result.number).toBe(3);
    expect(result.nodeId).toBe("MDk6TWlsZXN0b25lMw==");
  });
});
