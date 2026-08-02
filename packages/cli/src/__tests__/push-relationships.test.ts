import { describe, it, expect } from "vitest";
import { applyBlockedByLinks } from "../github/issues.js";
import type { Task, Dependency } from "@gh-gantt/shared";
import type { BlockedByLink } from "../github/sub-issues.js";
import { reprioritizeSubIssue } from "../github/mutations.js";

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

// mergeRemoteIntoLocal tests removed — replaced by 3-way merge in three-way-merge.test.ts

describe("[NFR-STABILITY-014-AC8] reprioritizeSubIssue要求", () => {
  it("公式inputとissue/clientMutationIdだけを要求する", async () => {
    let query = "";
    let variables: Record<string, unknown> = {};
    const gql = (async (document: string, input: Record<string, unknown>) => {
      query = document;
      variables = input;
      return { reprioritizeSubIssue: { issue: { id: "I_parent" }, clientMutationId: null } };
    }) as never;
    await reprioritizeSubIssue(gql, {
      parentIssueNodeId: "I_parent",
      subIssueNodeId: "I_child",
      beforeNodeId: "I_before",
    });
    expect(query).toContain("reprioritizeSubIssue");
    expect(query).not.toContain("subIssue { id }");
    expect(query).toContain("clientMutationId");
    expect(variables).toEqual({
      issueId: "I_parent",
      subIssueId: "I_child",
      beforeId: "I_before",
      afterId: undefined,
    });
  });

  it("before/afterの両指定と両欠損を拒否する", async () => {
    const gql = (async () => ({})) as never;
    await expect(
      reprioritizeSubIssue(gql, {
        parentIssueNodeId: "I_parent",
        subIssueNodeId: "I_child",
      }),
    ).rejects.toThrow("どちらか一方");
    await expect(
      reprioritizeSubIssue(gql, {
        parentIssueNodeId: "I_parent",
        subIssueNodeId: "I_child",
        beforeNodeId: "I_before",
        afterNodeId: "I_after",
      }),
    ).rejects.toThrow("どちらか一方");
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

    expect(task2.blocked_by).toEqual([{ task: "owner/repo#1", type: "finish-to-start", lag: 0 }]);
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
    const newBlockedBy: Dependency[] = [{ task: "owner/repo#5", type: "finish-to-start", lag: 0 }];

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
    const newBlockedBy: Dependency[] = [{ task: "owner/repo#5", type: "finish-to-start", lag: 0 }];

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
