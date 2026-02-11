import { describe, it, expect } from "vitest";
import { detectConflicts } from "../sync/conflict.js";
import type { Task, SyncState } from "@gh-gantt/shared";
import { hashTask, extractSyncFields } from "../sync/hash.js";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
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
  ...overrides,
});

describe("detectConflicts", () => {
  it("returns field details when both local and remote changed", () => {
    const snapshot = makeTask();
    const local = makeTask({ state: "closed" });
    const remote = makeTask({ custom_fields: { Status: "Done" } });

    const syncState: SyncState = {
      last_synced_at: "2026-01-01T00:00:00Z",
      project_node_id: "node1",
      id_map: {},
      field_ids: {},
      snapshots: {
        "owner/repo#1": {
          hash: hashTask(snapshot),
          synced_at: "2026-01-01T00:00:00Z",
          syncFields: extractSyncFields(snapshot),
        },
      },
    };

    const conflicts = detectConflicts([local], [remote], syncState);
    expect(conflicts).toHaveLength(1);

    const c = conflicts[0];
    expect(c.localChangedFields).toContain("state");
    expect(c.remoteChangedFields).toContain("custom_fields");

    const stateDetail = c.fieldDetails.find((d) => d.field === "state");
    expect(stateDetail).toBeDefined();
    expect(stateDetail!.local).toBe("closed");
    expect(stateDetail!.snapshot).toBe("open");

    const cfDetail = c.fieldDetails.find((d) => d.field === "custom_fields");
    expect(cfDetail).toBeDefined();
    expect(cfDetail!.remote).toEqual({ Status: "Done" });
    expect(cfDetail!.snapshot).toEqual({ Status: "Todo" });
  });

  it("returns empty field details when snapshot has no syncFields", () => {
    const snapshot = makeTask();
    const local = makeTask({ state: "closed" });
    const remote = makeTask({ custom_fields: { Status: "Done" } });

    const syncState: SyncState = {
      last_synced_at: "2026-01-01T00:00:00Z",
      project_node_id: "node1",
      id_map: {},
      field_ids: {},
      snapshots: {
        "owner/repo#1": {
          hash: hashTask(snapshot),
          synced_at: "2026-01-01T00:00:00Z",
          // no syncFields
        },
      },
    };

    const conflicts = detectConflicts([local], [remote], syncState);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].localChangedFields).toEqual([]);
    expect(conflicts[0].remoteChangedFields).toEqual([]);
    expect(conflicts[0].fieldDetails).toEqual([]);
  });

  it("does not report a conflict when only one side changed", () => {
    const snapshot = makeTask();
    const local = makeTask(); // unchanged
    const remote = makeTask({ state: "closed" }); // changed

    const syncState: SyncState = {
      last_synced_at: "2026-01-01T00:00:00Z",
      project_node_id: "node1",
      id_map: {},
      field_ids: {},
      snapshots: {
        "owner/repo#1": {
          hash: hashTask(snapshot),
          synced_at: "2026-01-01T00:00:00Z",
          syncFields: extractSyncFields(snapshot),
        },
      },
    };

    const conflicts = detectConflicts([local], [remote], syncState);
    expect(conflicts).toHaveLength(0);
  });
});
