import { describe, it, expect } from "vitest";
import { mergeRemoteIntoLocal } from "../sync/mapper.js";
import type { Task } from "@gh-gantt/shared";

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

describe("mergeRemoteIntoLocal", () => {
  it("uses remote parent and sub_tasks", () => {
    const local = { ...baseTask, parent: null, sub_tasks: [] };
    const remote = {
      ...baseTask,
      parent: "owner/repo#10",
      sub_tasks: ["owner/repo#2", "owner/repo#3"],
      title: "Updated title",
    };
    const merged = mergeRemoteIntoLocal(local, remote);
    expect(merged.parent).toBe("owner/repo#10");
    expect(merged.sub_tasks).toEqual(["owner/repo#2", "owner/repo#3"]);
    expect(merged.title).toBe("Updated title");
  });

  it("merges blocked_by using remote refs with local type/lag", () => {
    const localDep = { task: "owner/repo#5", type: "start-to-start" as const, lag: 2 };
    const remoteDep = { task: "owner/repo#5", type: "finish-to-start" as const, lag: 0 };
    const local = { ...baseTask, blocked_by: [localDep] };
    const remote = { ...baseTask, blocked_by: [remoteDep] };
    const merged = mergeRemoteIntoLocal(local, remote);
    // Remote ref exists, local type/lag preserved
    expect(merged.blocked_by).toEqual([localDep]);
  });

  it("drops local blocked_by when remote has none", () => {
    const dep = { task: "owner/repo#5", type: "finish-to-start" as const, lag: 0 };
    const local = { ...baseTask, blocked_by: [dep] };
    const remote = { ...baseTask, blocked_by: [] };
    const merged = mergeRemoteIntoLocal(local, remote);
    expect(merged.blocked_by).toEqual([]);
  });

  it("preserves local type when type field not configured", () => {
    const local = { ...baseTask, type: "epic" };
    const remote = { ...baseTask, type: "task" };
    const merged = mergeRemoteIntoLocal(local, remote);
    expect(merged.type).toBe("epic");
  });

  it("uses remote type when type field is configured", () => {
    const local = { ...baseTask, type: "epic" };
    const remote = { ...baseTask, type: "milestone" };
    const merged = mergeRemoteIntoLocal(local, remote, { typeFieldConfigured: true });
    expect(merged.type).toBe("milestone");
  });
});
