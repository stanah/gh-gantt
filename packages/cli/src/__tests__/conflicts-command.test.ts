import { describe, it, expect } from "vitest";
import { formatConflictList } from "../commands/conflicts.js";
import type { SyncState } from "@gh-gantt/shared";

describe("formatConflictList", () => {
  it("formats conflict list with base values from snapshots", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8",
        title: "Fix login bug",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
      },
    ];

    const snapshots: SyncState["snapshots"] = {
      "owner/repo#8": {
        hash: "abc123",
        synced_at: "2026-01-01T00:00:00Z",
        syncFields: {
          title: "Fix login bug",
          body: "",
          state: "open",
          type: "task",
          assignees: [],
          labels: [],
          milestone: null,
          custom_fields: {},
          parent: null,
          sub_tasks: [],
          start_date: null,
          end_date: null,
          date: null,
          blocked_by: [],
        },
      },
    };

    const result = formatConflictList(tasks, snapshots);
    expect(result).toContain("#8: Fix login bug");
    expect(result).toContain("state");
    expect(result).toContain('current="open"');
    expect(result).toContain('incoming="closed"');
    expect(result).toContain('base="open"');
    expect(result).toContain("1 task(s), 1 conflict(s)");
  });

  it("returns 'No conflicts.' when no markers exist", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#1",
        title: "Normal task",
        state: "open",
      },
    ];

    const snapshots: SyncState["snapshots"] = {};

    const result = formatConflictList(tasks, snapshots);
    expect(result).toBe("No conflicts.");
  });

  it("filters by issue number", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8",
        title: "Task 8",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
      },
      {
        id: "owner/repo#9",
        title: "Task 9",
        title_current: "Task 9",
        title_incoming: "Task 9 updated",
      },
    ];

    const snapshots: SyncState["snapshots"] = {
      "owner/repo#8": {
        hash: "abc",
        synced_at: "2026-01-01T00:00:00Z",
        syncFields: {
          title: "Task 8",
          body: "",
          state: "open",
          type: "task",
          assignees: [],
          labels: [],
          milestone: null,
          custom_fields: {},
          parent: null,
          sub_tasks: [],
          start_date: null,
          end_date: null,
          date: null,
          blocked_by: [],
        },
      },
      "owner/repo#9": {
        hash: "def",
        synced_at: "2026-01-01T00:00:00Z",
        syncFields: {
          title: "Task 9",
          body: "",
          state: "open",
          type: "task",
          assignees: [],
          labels: [],
          milestone: null,
          custom_fields: {},
          parent: null,
          sub_tasks: [],
          start_date: null,
          end_date: null,
          date: null,
          blocked_by: [],
        },
      },
    };

    const result = formatConflictList(tasks, snapshots, 8);
    expect(result).toContain("#8: Task 8");
    expect(result).not.toContain("#9");
    expect(result).toContain("1 task(s), 1 conflict(s)");
  });

  it("shows multiple conflicts for the same task", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#5",
        title: "Multi conflict",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
        title_current: "Multi conflict",
        title_incoming: "Renamed task",
      },
    ];

    const snapshots: SyncState["snapshots"] = {
      "owner/repo#5": {
        hash: "xyz",
        synced_at: "2026-01-01T00:00:00Z",
        syncFields: {
          title: "Original title",
          body: "",
          state: "open",
          type: "task",
          assignees: [],
          labels: [],
          milestone: null,
          custom_fields: {},
          parent: null,
          sub_tasks: [],
          start_date: null,
          end_date: null,
          date: null,
          blocked_by: [],
        },
      },
    };

    const result = formatConflictList(tasks, snapshots);
    expect(result).toContain("#5: Multi conflict");
    expect(result).toContain("state");
    expect(result).toContain("title");
    expect(result).toContain("1 task(s), 2 conflict(s)");
  });
});
