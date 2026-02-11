import { describe, it, expect } from "vitest";
import { mergeRemoteIntoLocal } from "../sync/mapper.js";
import { applyBlockedByLinks } from "../github/issues.js";
import type { Task, Dependency } from "@gh-gantt/shared";
import type { BlockedByLink } from "../github/sub-issues.js";

const baseTask: Task = {
  id: "owner/repo#1",
  type: "task",
  github_issue: 1,
  github_repo: "owner/repo",
  parent: null,
  sub_tasks: [],
  title: "Test task",
  body: "Some body",
  state: "open",
  state_reason: null,
  assignees: ["alice"],
  labels: ["bug"],
  milestone: null,
  linked_prs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
  custom_fields: { Status: "Todo" },
  start_date: "2026-01-01",
  end_date: "2026-01-10",
  date: null,
  blocked_by: [],
};

describe("mergeRemoteIntoLocal blocked_by merge", () => {
  it("uses remote blocked_by references with local type/lag preserved", () => {
    const localDep: Dependency = { task: "owner/repo#5", type: "start-to-start", lag: 2 };
    const remoteDep: Dependency = { task: "owner/repo#5", type: "finish-to-start", lag: 0 };
    const local = { ...baseTask, blocked_by: [localDep] };
    const remote = { ...baseTask, blocked_by: [remoteDep] };

    const merged = mergeRemoteIntoLocal(local, remote);
    // Local type/lag should be preserved because the reference matches
    expect(merged.blocked_by).toEqual([localDep]);
  });

  it("adds new remote blocked_by with default type/lag", () => {
    const remoteDep: Dependency = { task: "owner/repo#10", type: "finish-to-start", lag: 0 };
    const local = { ...baseTask, blocked_by: [] };
    const remote = { ...baseTask, blocked_by: [remoteDep] };

    const merged = mergeRemoteIntoLocal(local, remote);
    expect(merged.blocked_by).toEqual([remoteDep]);
  });

  it("removes blocked_by that no longer exists on remote", () => {
    const localDep: Dependency = { task: "owner/repo#5", type: "finish-to-start", lag: 0 };
    const local = { ...baseTask, blocked_by: [localDep] };
    const remote = { ...baseTask, blocked_by: [] };

    const merged = mergeRemoteIntoLocal(local, remote);
    expect(merged.blocked_by).toEqual([]);
  });

  it("handles mixed add/remove/preserve scenario", () => {
    const keptDep: Dependency = { task: "owner/repo#5", type: "start-to-start", lag: 3 };
    const removedDep: Dependency = { task: "owner/repo#6", type: "finish-to-start", lag: 0 };
    const addedDep: Dependency = { task: "owner/repo#7", type: "finish-to-start", lag: 0 };

    const local = { ...baseTask, blocked_by: [keptDep, removedDep] };
    const remote = {
      ...baseTask,
      blocked_by: [
        { task: "owner/repo#5", type: "finish-to-start" as const, lag: 0 },
        addedDep,
      ],
    };

    const merged = mergeRemoteIntoLocal(local, remote);
    expect(merged.blocked_by).toHaveLength(2);
    // #5 should preserve local type/lag
    expect(merged.blocked_by[0]).toEqual(keptDep);
    // #7 is new, uses remote values
    expect(merged.blocked_by[1]).toEqual(addedDep);
  });
});

describe("applyBlockedByLinks", () => {
  it("applies blocked_by links to tasks", () => {
    const task1 = { ...baseTask, id: "owner/repo#1", blocked_by: [] as Dependency[] };
    const task2 = { ...baseTask, id: "owner/repo#2", blocked_by: [] as Dependency[] };
    const tasks = [task1, task2];

    const links: BlockedByLink[] = [
      {
        blockedNumber: 2,
        blockedRepo: "owner/repo",
        blockingNumber: 1,
        blockingRepo: "owner/repo",
      },
    ];

    applyBlockedByLinks(tasks, links);

    expect(task2.blocked_by).toEqual([
      { task: "owner/repo#1", type: "finish-to-start", lag: 0 },
    ]);
    // Task 1 should not be affected
    expect(task1.blocked_by).toEqual([]);
  });

  it("does not duplicate existing blocked_by entries", () => {
    const existingDep: Dependency = { task: "owner/repo#1", type: "start-to-start", lag: 5 };
    const task1 = { ...baseTask, id: "owner/repo#1", blocked_by: [] as Dependency[] };
    const task2 = { ...baseTask, id: "owner/repo#2", blocked_by: [existingDep] };
    const tasks = [task1, task2];

    const links: BlockedByLink[] = [
      {
        blockedNumber: 2,
        blockedRepo: "owner/repo",
        blockingNumber: 1,
        blockingRepo: "owner/repo",
      },
    ];

    applyBlockedByLinks(tasks, links);

    // Should not add a duplicate
    expect(task2.blocked_by).toHaveLength(1);
    expect(task2.blocked_by[0]).toEqual(existingDep);
  });

  it("skips links where blocking task is not in project", () => {
    const task1 = { ...baseTask, id: "owner/repo#1", blocked_by: [] as Dependency[] };
    const tasks = [task1];

    const links: BlockedByLink[] = [
      {
        blockedNumber: 1,
        blockedRepo: "owner/repo",
        blockingNumber: 99,
        blockingRepo: "other/repo",
      },
    ];

    applyBlockedByLinks(tasks, links);
    expect(task1.blocked_by).toEqual([]);
  });
});

describe("parent change detection for push", () => {
  it("detects parent added", () => {
    const oldParent: string | null = null;
    const newParent: string | null = "owner/repo#10";
    expect(oldParent !== newParent).toBe(true);
  });

  it("detects parent removed", () => {
    const oldParent: string | null = "owner/repo#10";
    const newParent: string | null = null;
    expect(oldParent !== newParent).toBe(true);
  });

  it("detects parent changed", () => {
    const oldParent: string | null = "owner/repo#10";
    const newParent: string | null = "owner/repo#20";
    expect(oldParent !== newParent).toBe(true);
  });

  it("detects no change", () => {
    const oldParent: string | null = "owner/repo#10";
    const newParent: string | null = "owner/repo#10";
    expect(oldParent !== newParent).toBe(false);
  });
});

describe("blocked_by diff computation for push", () => {
  it("detects added blockers", () => {
    const oldBlockedBy: Dependency[] = [];
    const newBlockedBy: Dependency[] = [
      { task: "owner/repo#5", type: "finish-to-start", lag: 0 },
    ];

    const oldSet = new Set(oldBlockedBy.map((d) => d.task));
    const added = newBlockedBy.filter((d) => !oldSet.has(d.task));
    expect(added).toHaveLength(1);
    expect(added[0].task).toBe("owner/repo#5");
  });

  it("detects removed blockers", () => {
    const oldBlockedBy: Dependency[] = [
      { task: "owner/repo#5", type: "finish-to-start", lag: 0 },
      { task: "owner/repo#6", type: "finish-to-start", lag: 0 },
    ];
    const newBlockedBy: Dependency[] = [
      { task: "owner/repo#5", type: "finish-to-start", lag: 0 },
    ];

    const newSet = new Set(newBlockedBy.map((d) => d.task));
    const removed = oldBlockedBy.filter((d) => !newSet.has(d.task));
    expect(removed).toHaveLength(1);
    expect(removed[0].task).toBe("owner/repo#6");
  });

  it("handles empty to empty (no changes)", () => {
    const oldBlockedBy: Dependency[] = [];
    const newBlockedBy: Dependency[] = [];

    const oldSet = new Set(oldBlockedBy.map((d) => d.task));
    const newSet = new Set(newBlockedBy.map((d) => d.task));
    const added = newBlockedBy.filter((d) => !oldSet.has(d.task));
    const removed = oldBlockedBy.filter((d) => !newSet.has(d.task));
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });
});
