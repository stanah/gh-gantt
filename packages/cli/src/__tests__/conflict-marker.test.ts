import { describe, it, expect } from "vitest";
import type { Task } from "@gh-gantt/shared";
import {
  applyConflictMarkers,
  detectMarkers,
  resolveMarker,
  hasUnresolvedMarkers,
} from "../sync/conflict-marker.js";
import type { FieldConflict } from "../sync/three-way-merge.js";

const baseTask: Task = {
  id: "owner/repo#1",
  type: "task",
  github_issue: 1,
  github_repo: "owner/repo",
  parent: null,
  sub_tasks: [],
  title: "Original title",
  body: "Original body",
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

describe("[FR-SYNC-001-AC2] コンフリクトマーカーを生成しユーザーに解決を促す", () => {
  it("adds _current and _incoming keys for each conflict", () => {
    const conflicts: FieldConflict[] = [
      {
        field: "title",
        base: "Base title",
        current: "Local title",
        incoming: "Remote title",
      },
    ];

    const result = applyConflictMarkers(baseTask, conflicts);

    expect(result.title_current).toBe("Local title");
    expect(result.title_incoming).toBe("Remote title");
  });

  it("keeps current (local) value in the original field", () => {
    const task = { ...baseTask, title: "Local title" };
    const conflicts: FieldConflict[] = [
      {
        field: "title",
        base: "Base title",
        current: "Local title",
        incoming: "Remote title",
      },
    ];

    const result = applyConflictMarkers(task, conflicts);

    expect(result.title).toBe("Local title");
  });

  it("handles multiple conflicts", () => {
    const task = { ...baseTask, title: "Local title", state: "open" as const };
    const conflicts: FieldConflict[] = [
      {
        field: "title",
        base: "Base title",
        current: "Local title",
        incoming: "Remote title",
      },
      {
        field: "state",
        base: "open",
        current: "open",
        incoming: "closed",
      },
    ];

    const result = applyConflictMarkers(task, conflicts);

    expect(result.title_current).toBe("Local title");
    expect(result.title_incoming).toBe("Remote title");
    expect(result.state_current).toBe("open");
    expect(result.state_incoming).toBe("closed");
  });

  it("preserves all original task fields", () => {
    const conflicts: FieldConflict[] = [
      {
        field: "title",
        base: "Base",
        current: "Local",
        incoming: "Remote",
      },
    ];

    const result = applyConflictMarkers(baseTask, conflicts);

    expect(result.id).toBe(baseTask.id);
    expect(result.github_issue).toBe(baseTask.github_issue);
    expect(result.assignees).toEqual(baseTask.assignees);
  });
});

describe("detectMarkers", () => {
  it("detects conflict markers from task data", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title: "Local title",
      title_current: "Local title",
      title_incoming: "Remote title",
    };

    const conflicts = detectMarkers(taskData);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe("title");
    expect(conflicts[0].current).toBe("Local title");
    expect(conflicts[0].incoming).toBe("Remote title");
    expect(conflicts[0].base).toBeUndefined();
  });

  it("ignores orphaned _current without matching _incoming", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title_current: "Local title",
      // no title_incoming
    };

    const conflicts = detectMarkers(taskData);

    expect(conflicts).toHaveLength(0);
  });

  it("ignores non-SyncFields keys", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      created_at_current: "2026-01-01",
      created_at_incoming: "2026-02-01",
    };

    const conflicts = detectMarkers(taskData);

    expect(conflicts).toHaveLength(0);
  });

  it("detects multiple markers", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title_current: "Local title",
      title_incoming: "Remote title",
      state_current: "open",
      state_incoming: "closed",
    };

    const conflicts = detectMarkers(taskData);

    expect(conflicts).toHaveLength(2);
    const fields = conflicts.map((c) => c.field).sort();
    expect(fields).toEqual(["state", "title"]);
  });
});

describe("resolveMarker", () => {
  it("ours: keeps current value and removes marker keys", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title: "Local title",
      title_current: "Local title",
      title_incoming: "Remote title",
    };

    resolveMarker(taskData, "title", "ours");

    expect(taskData.title).toBe("Local title");
    expect(taskData.title_current).toBeUndefined();
    expect(taskData.title_incoming).toBeUndefined();
  });

  it("theirs: adopts incoming value and removes marker keys", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title: "Local title",
      title_current: "Local title",
      title_incoming: "Remote title",
    };

    resolveMarker(taskData, "title", "theirs");

    expect(taskData.title).toBe("Remote title");
    expect(taskData.title_current).toBeUndefined();
    expect(taskData.title_incoming).toBeUndefined();
  });

  it("removes only the specified field's markers", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title: "Local title",
      title_current: "Local title",
      title_incoming: "Remote title",
      state: "open",
      state_current: "open",
      state_incoming: "closed",
    };

    resolveMarker(taskData, "title", "ours");

    // title markers removed
    expect(taskData.title_current).toBeUndefined();
    expect(taskData.title_incoming).toBeUndefined();
    // state markers still present
    expect(taskData.state_current).toBe("open");
    expect(taskData.state_incoming).toBe("closed");
  });
});

describe("hasUnresolvedMarkers", () => {
  it("returns true when markers exist", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title_current: "Local title",
      title_incoming: "Remote title",
    };

    expect(hasUnresolvedMarkers(taskData)).toBe(true);
  });

  it("returns false when no markers exist", () => {
    const taskData: Record<string, unknown> = { ...baseTask };

    expect(hasUnresolvedMarkers(taskData)).toBe(false);
  });

  it("returns false for orphaned markers (only _current without _incoming)", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      title_current: "Local title",
    };

    expect(hasUnresolvedMarkers(taskData)).toBe(false);
  });

  it("returns false for non-SyncFields markers", () => {
    const taskData: Record<string, unknown> = {
      ...baseTask,
      created_at_current: "2026-01-01",
      created_at_incoming: "2026-02-01",
    };

    expect(hasUnresolvedMarkers(taskData)).toBe(false);
  });
});
