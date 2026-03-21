import { describe, it, expect } from "vitest";
import { threeWayMerge, SYNC_FIELD_KEYS } from "../sync/three-way-merge.js";
import type { SyncFields } from "@gh-gantt/shared";

function makeSyncFields(overrides: Partial<SyncFields> = {}): SyncFields {
  return {
    title: "Test task",
    body: null,
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
    ...overrides,
  };
}

describe("SYNC_FIELD_KEYS", () => {
  it("exports all SyncFields keys", () => {
    const fields = makeSyncFields();
    const objectKeys = Object.keys(fields).sort();
    const exportedKeys = [...SYNC_FIELD_KEYS].sort();
    expect(exportedKeys).toEqual(objectKeys);
  });
});

describe("threeWayMerge", () => {
  it("returns base unchanged when nothing changed", () => {
    const base = makeSyncFields();
    const current = makeSyncFields();
    const incoming = makeSyncFields();
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual(base);
  });

  it("adopts incoming when only remote changed (remote-only)", () => {
    const base = makeSyncFields({ title: "Old" });
    const current = makeSyncFields({ title: "Old" });
    const incoming = makeSyncFields({ title: "New from remote" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.title).toBe("New from remote");
  });

  it("keeps current when only local changed (local-only)", () => {
    const base = makeSyncFields({ title: "Old" });
    const current = makeSyncFields({ title: "New local" });
    const incoming = makeSyncFields({ title: "Old" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.title).toBe("New local");
  });

  it("keeps current when both changed to the same value", () => {
    const base = makeSyncFields({ title: "Old" });
    const current = makeSyncFields({ title: "Same new" });
    const incoming = makeSyncFields({ title: "Same new" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.title).toBe("Same new");
  });

  it("reports conflict when both changed to different values", () => {
    const base = makeSyncFields({ title: "Old" });
    const current = makeSyncFields({ title: "Local change" });
    const incoming = makeSyncFields({ title: "Remote change" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      field: "title",
      base: "Old",
      current: "Local change",
      incoming: "Remote change",
    });
    // On conflict, merged should keep current
    expect(result.merged.title).toBe("Local change");
  });

  it("handles multiple fields with mixed changes", () => {
    const base = makeSyncFields({
      title: "Old title",
      body: "Old body",
      state: "open",
      milestone: null,
    });
    const current = makeSyncFields({
      title: "Old title",       // unchanged
      body: "Local body",       // local-only change
      state: "closed",          // conflict
      milestone: "v1.0",        // local-only change
    });
    const incoming = makeSyncFields({
      title: "Remote title",    // remote-only change
      body: "Old body",         // unchanged
      state: "open",            // conflict (changed in current but not incoming -> local-only actually)
      milestone: null,          // unchanged
    });
    // Wait: state: base=open, current=closed, incoming=open → local-only change (base==incoming)
    // Let me fix the test case for a real conflict
    const base2 = makeSyncFields({
      title: "Old title",
      body: "Old body",
      state: "open",
    });
    const current2 = makeSyncFields({
      title: "Old title",       // unchanged
      body: "Local body",       // local-only change
      state: "closed",          // both changed differently → conflict
    });
    const incoming2 = makeSyncFields({
      title: "Remote title",    // remote-only change
      body: "Old body",         // unchanged
      state: "open",            // unchanged from base
    });
    // Actually state: base=open, current=closed, incoming=open → base==incoming → local-only
    // Let me make a proper conflict:
    const base3 = makeSyncFields({
      title: "Old",
      body: "Old body",
      milestone: "v0",
    });
    const current3 = makeSyncFields({
      title: "Local",         // conflict
      body: "Local body",     // local-only
      milestone: "v1",        // conflict
    });
    const incoming3 = makeSyncFields({
      title: "Remote",        // conflict
      body: "Old body",       // unchanged
      milestone: "v2",        // conflict
    });
    const result = threeWayMerge(base3, current3, incoming3);
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.map((c) => c.field).sort()).toEqual(["milestone", "title"]);
    expect(result.merged.body).toBe("Local body"); // local-only wins
    expect(result.merged.title).toBe("Local"); // conflict → keep current
    expect(result.merged.milestone).toBe("v1"); // conflict → keep current
  });

  describe("array fields", () => {
    it("compares assignees with sorted normalization", () => {
      // Same values in different order → no change
      const base = makeSyncFields({ assignees: ["bob", "alice"] });
      const current = makeSyncFields({ assignees: ["alice", "bob"] });
      const incoming = makeSyncFields({ assignees: ["bob", "alice"] });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toEqual([]);
    });

    it("detects remote-only change in assignees", () => {
      const base = makeSyncFields({ assignees: ["alice"] });
      const current = makeSyncFields({ assignees: ["alice"] });
      const incoming = makeSyncFields({ assignees: ["alice", "bob"] });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toEqual([]);
      expect(result.merged.assignees).toEqual(["alice", "bob"]);
    });

    it("detects conflict in labels", () => {
      const base = makeSyncFields({ labels: ["bug"] });
      const current = makeSyncFields({ labels: ["bug", "urgent"] });
      const incoming = makeSyncFields({ labels: ["bug", "wontfix"] });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].field).toBe("labels");
    });
  });

  describe("blocked_by with type/lag", () => {
    it("compares blocked_by sorted by task field", () => {
      const base = makeSyncFields({
        blocked_by: [
          { task: "repo#2", type: "finish_to_start", lag: 0 },
          { task: "repo#1", type: "finish_to_start", lag: 0 },
        ],
      });
      // Same deps, different order → no change
      const current = makeSyncFields({
        blocked_by: [
          { task: "repo#1", type: "finish_to_start", lag: 0 },
          { task: "repo#2", type: "finish_to_start", lag: 0 },
        ],
      });
      const incoming = makeSyncFields({
        blocked_by: [
          { task: "repo#2", type: "finish_to_start", lag: 0 },
          { task: "repo#1", type: "finish_to_start", lag: 0 },
        ],
      });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toEqual([]);
    });

    it("detects changes in blocked_by lag", () => {
      const base = makeSyncFields({
        blocked_by: [{ task: "repo#1", type: "finish_to_start", lag: 0 }],
      });
      const current = makeSyncFields({
        blocked_by: [{ task: "repo#1", type: "finish_to_start", lag: 0 }],
      });
      const incoming = makeSyncFields({
        blocked_by: [{ task: "repo#1", type: "finish_to_start", lag: 1 }],
      });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toEqual([]);
      expect(result.merged.blocked_by).toEqual([
        { task: "repo#1", type: "finish_to_start", lag: 1 },
      ]);
    });
  });

  describe("custom_fields key order", () => {
    it("compares custom_fields regardless of key order", () => {
      const base = makeSyncFields({
        custom_fields: { priority: "high", status: "active" },
      });
      // Same content, potentially different insertion order
      const current = makeSyncFields({
        custom_fields: { status: "active", priority: "high" },
      });
      const incoming = makeSyncFields({
        custom_fields: { priority: "high", status: "active" },
      });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toEqual([]);
    });

    it("detects remote-only change in custom_fields", () => {
      const base = makeSyncFields({
        custom_fields: { priority: "low" },
      });
      const current = makeSyncFields({
        custom_fields: { priority: "low" },
      });
      const incoming = makeSyncFields({
        custom_fields: { priority: "high" },
      });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toEqual([]);
      expect(result.merged.custom_fields).toEqual({ priority: "high" });
    });

    it("detects conflict in custom_fields", () => {
      const base = makeSyncFields({
        custom_fields: { priority: "low" },
      });
      const current = makeSyncFields({
        custom_fields: { priority: "medium" },
      });
      const incoming = makeSyncFields({
        custom_fields: { priority: "high" },
      });
      const result = threeWayMerge(base, current, incoming);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].field).toBe("custom_fields");
    });
  });
});
