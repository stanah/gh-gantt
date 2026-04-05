import { describe, it, expect } from "vitest";
import {
  computeLocalDiff,
  detectChangedFields,
  estimateApiCalls,
  formatDiffPreview,
} from "../sync/diff.js";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import type { Task, SyncState, SyncFields } from "@gh-gantt/shared";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "o/r",
    parent: null,
    sub_tasks: [],
    title: `Task ${id}`,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "",
    updated_at: "",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeSyncState(snapshots: SyncState["snapshots"] = {}): SyncState {
  return {
    last_synced_at: "",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots,
  };
}

function snapshotFor(task: Task): { hash: string; synced_at: string; syncFields: SyncFields } {
  return {
    hash: hashTask(task),
    synced_at: "",
    syncFields: extractSyncFields(task),
  };
}

// ---------------------------------------------------------------------------
// detectChangedFields
// ---------------------------------------------------------------------------
describe("detectChangedFields", () => {
  it("returns empty array when fields are identical", () => {
    const task = makeTask("o/r#1");
    const fields = extractSyncFields(task);
    expect(detectChangedFields(fields, fields)).toEqual([]);
  });

  it("detects a single changed field", () => {
    const prev = extractSyncFields(makeTask("o/r#1", { title: "Old" }));
    const curr = extractSyncFields(makeTask("o/r#1", { title: "New" }));
    expect(detectChangedFields(curr, prev)).toEqual(["title"]);
  });

  it("detects multiple changed fields", () => {
    const prev = extractSyncFields(makeTask("o/r#1", { title: "Old", state: "open" }));
    const curr = extractSyncFields(makeTask("o/r#1", { title: "New", state: "closed" }));
    const changed = detectChangedFields(curr, prev);
    expect(changed).toContain("title");
    expect(changed).toContain("state");
    expect(changed).toHaveLength(2);
  });

  it("detects changes in array fields (labels)", () => {
    const prev = extractSyncFields(makeTask("o/r#1", { labels: ["bug"] }));
    const curr = extractSyncFields(makeTask("o/r#1", { labels: ["bug", "feature"] }));
    expect(detectChangedFields(curr, prev)).toEqual(["labels"]);
  });

  it("detects changes in nested fields (custom_fields)", () => {
    const prev = extractSyncFields(makeTask("o/r#1", { custom_fields: { Status: "Todo" } }));
    const curr = extractSyncFields(makeTask("o/r#1", { custom_fields: { Status: "Done" } }));
    expect(detectChangedFields(curr, prev)).toEqual(["custom_fields"]);
  });

  it("detects changes in date fields", () => {
    const prev = extractSyncFields(makeTask("o/r#1", { start_date: null }));
    const curr = extractSyncFields(makeTask("o/r#1", { start_date: "2026-01-01" }));
    expect(detectChangedFields(curr, prev)).toEqual(["start_date"]);
  });
});

// ---------------------------------------------------------------------------
// computeLocalDiff
// ---------------------------------------------------------------------------
describe("computeLocalDiff", () => {
  it("returns empty array when no tasks and no snapshots", () => {
    const diffs = computeLocalDiff([], makeSyncState());
    expect(diffs).toEqual([]);
  });

  it("returns empty array when tasks match snapshots", () => {
    const task = makeTask("o/r#1");
    const syncState = makeSyncState({ "o/r#1": snapshotFor(task) });
    const diffs = computeLocalDiff([task], syncState);
    expect(diffs).toEqual([]);
  });

  it("detects added tasks (no snapshot)", () => {
    const task = makeTask("o/r#1");
    const diffs = computeLocalDiff([task], makeSyncState());
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ id: "o/r#1", type: "added", task });
  });

  it("detects modified tasks with syncFields (changedFields populated)", () => {
    const original = makeTask("o/r#1", { title: "Original" });
    const modified = makeTask("o/r#1", { title: "Modified" });
    const syncState = makeSyncState({ "o/r#1": snapshotFor(original) });
    const diffs = computeLocalDiff([modified], syncState);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ id: "o/r#1", type: "modified" });
    expect(diffs[0].changedFields).toContain("title");
  });

  it("detects modified tasks without syncFields (changedFields undefined)", () => {
    const original = makeTask("o/r#1", { title: "Original" });
    const modified = makeTask("o/r#1", { title: "Modified" });
    const syncState = makeSyncState({
      "o/r#1": { hash: hashTask(original), synced_at: "" },
    });
    const diffs = computeLocalDiff([modified], syncState);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ id: "o/r#1", type: "modified" });
    expect(diffs[0].changedFields).toBeUndefined();
  });

  it("detects deleted tasks (snapshot exists but task is gone)", () => {
    const task = makeTask("o/r#1");
    const syncState = makeSyncState({ "o/r#1": snapshotFor(task) });
    const diffs = computeLocalDiff([], syncState);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ id: "o/r#1", type: "deleted" });
  });

  it("handles mixed: added, modified, deleted, and unchanged", () => {
    const unchanged = makeTask("o/r#1", { title: "Same" });
    const original = makeTask("o/r#2", { title: "Before" });
    const modified = makeTask("o/r#2", { title: "After" });
    const added = makeTask("o/r#4", { title: "New" });
    // o/r#3 exists in snapshots but not in tasks (deleted)
    const deleted = makeTask("o/r#3");

    const syncState = makeSyncState({
      "o/r#1": snapshotFor(unchanged),
      "o/r#2": snapshotFor(original),
      "o/r#3": snapshotFor(deleted),
    });

    const diffs = computeLocalDiff([unchanged, modified, added], syncState);
    expect(diffs).toHaveLength(3);

    const types = diffs.map((d) => d.type).sort();
    expect(types).toEqual(["added", "deleted", "modified"]);

    expect(diffs.find((d) => d.id === "o/r#4")?.type).toBe("added");
    expect(diffs.find((d) => d.id === "o/r#2")?.type).toBe("modified");
    expect(diffs.find((d) => d.id === "o/r#3")?.type).toBe("deleted");
  });
});

// ---------------------------------------------------------------------------
// estimateApiCalls
// ---------------------------------------------------------------------------
describe("[NFR-SYNC-002-AC1] 変更のないタスクに対して不要な API コールを行わない", () => {
  it("returns 0 for empty diffs", () => {
    expect(estimateApiCalls([])).toBe(0);
  });

  it("returns 0 for deleted tasks", () => {
    const diffs = [{ id: "o/r#1", type: "deleted" as const, task: { id: "o/r#1" } as Task }];
    expect(estimateApiCalls(diffs)).toBe(0);
  });

  it("returns 5 for a modified non-draft task", () => {
    const task = makeTask("o/r#1");
    const diffs = [{ id: "o/r#1", type: "modified" as const, task }];
    expect(estimateApiCalls(diffs)).toBe(5);
  });

  it("returns 6 for a draft task with autoCreateIssues (default)", () => {
    const task = makeTask("o/r#draft-1");
    const diffs = [{ id: "o/r#draft-1", type: "added" as const, task }];
    expect(estimateApiCalls(diffs)).toBe(6);
  });

  it("returns 0 for a draft task when autoCreateIssues is false", () => {
    const task = makeTask("o/r#draft-1");
    const diffs = [{ id: "o/r#draft-1", type: "added" as const, task }];
    expect(estimateApiCalls(diffs, { autoCreateIssues: false })).toBe(0);
  });

  it("returns 1 for a milestone draft task regardless of autoCreateIssues", () => {
    const task = makeTask("o/r#draft-1", { type: "milestone" });
    const diffs = [{ id: "o/r#draft-1", type: "added" as const, task }];
    expect(estimateApiCalls(diffs, { autoCreateIssues: true })).toBe(1);
    expect(estimateApiCalls(diffs, { autoCreateIssues: false })).toBe(1);
  });

  it("sums API calls for mixed diff types", () => {
    const draftTask = makeTask("o/r#draft-1");
    const modifiedTask = makeTask("o/r#2");
    const deletedTask = makeTask("o/r#3");
    const milestoneDraft = makeTask("o/r#draft-2", { type: "milestone" });

    const diffs = [
      { id: "o/r#draft-1", type: "added" as const, task: draftTask },
      { id: "o/r#2", type: "modified" as const, task: modifiedTask },
      { id: "o/r#3", type: "deleted" as const, task: deletedTask },
      { id: "o/r#draft-2", type: "added" as const, task: milestoneDraft },
    ];
    // 6 (draft) + 5 (modified) + 0 (deleted) + 1 (milestone draft) = 12
    expect(estimateApiCalls(diffs)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// formatDiffPreview
// ---------------------------------------------------------------------------
describe("[FR-SYNC-003-AC2] dry run で変更内容をプレビューできる", () => {
  it("returns zero counts for empty diffs", () => {
    const result = formatDiffPreview([]);
    expect(result.preview).toBe(true);
    expect(result.summary).toEqual({ create: 0, update: 0, skip: 0 });
    expect(result.estimated_api_calls).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it("counts draft tasks as create", () => {
    const task = makeTask("o/r#draft-1", { title: "New task" });
    const diffs = [{ id: "o/r#draft-1", type: "added" as const, task }];
    const result = formatDiffPreview(diffs);
    expect(result.summary.create).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      id: "o/r#draft-1",
      title: "New task",
      type: "added",
    });
  });

  it("counts modified non-draft tasks as update", () => {
    const task = makeTask("o/r#1", { title: "Updated" });
    const diffs = [{ id: "o/r#1", type: "modified" as const, task, changedFields: ["title"] }];
    const result = formatDiffPreview(diffs);
    expect(result.summary.update).toBe(1);
    expect(result.changes[0]).toMatchObject({
      id: "o/r#1",
      title: "Updated",
      type: "modified",
      changedFields: ["title"],
    });
  });

  it("counts deleted tasks as skip", () => {
    const diffs = [{ id: "o/r#1", type: "deleted" as const, task: { id: "o/r#1" } as Task }];
    const result = formatDiffPreview(diffs);
    expect(result.summary.skip).toBe(1);
    expect(result.changes).toEqual([]);
  });

  it("skips draft tasks when autoCreateIssues is false", () => {
    const task = makeTask("o/r#draft-1", { title: "Draft" });
    const diffs = [{ id: "o/r#draft-1", type: "added" as const, task }];
    const result = formatDiffPreview(diffs, { autoCreateIssues: false });
    expect(result.summary.skip).toBe(1);
    expect(result.summary.create).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it("still creates milestone draft tasks even when autoCreateIssues is false", () => {
    const task = makeTask("o/r#draft-1", { type: "milestone", title: "v1.0" });
    const diffs = [{ id: "o/r#draft-1", type: "added" as const, task }];
    const result = formatDiffPreview(diffs, { autoCreateIssues: false });
    expect(result.summary.create).toBe(1);
    expect(result.changes).toHaveLength(1);
  });

  it("filters out milestone synthetic tasks", () => {
    const syntheticTask = makeTask("milestone:o/r#1", { type: "milestone", title: "v1.0" });
    const realTask = makeTask("o/r#1", { title: "Real" });
    const diffs = [
      { id: "milestone:o/r#1", type: "modified" as const, task: syntheticTask },
      { id: "o/r#1", type: "modified" as const, task: realTask },
    ];
    const result = formatDiffPreview(diffs);
    // synthetic milestone should be excluded entirely
    expect(result.summary.update).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].id).toBe("o/r#1");
  });

  it("computes correct estimated_api_calls in preview", () => {
    const draft = makeTask("o/r#draft-1", { title: "New" });
    const modified = makeTask("o/r#2", { title: "Changed" });
    const diffs = [
      { id: "o/r#draft-1", type: "added" as const, task: draft },
      { id: "o/r#2", type: "modified" as const, task: modified },
    ];
    const result = formatDiffPreview(diffs);
    // 6 (draft auto-create) + 5 (modified) = 11
    expect(result.estimated_api_calls).toBe(11);
  });

  it("handles mixed scenario with correct summary", () => {
    const draft = makeTask("o/r#draft-1", { title: "Draft" });
    const milestoneDraft = makeTask("o/r#draft-2", { type: "milestone", title: "MS" });
    const modified = makeTask("o/r#5", { title: "Mod" });
    const deleted = { id: "o/r#9", type: "deleted" as const, task: { id: "o/r#9" } as Task };
    const synthetic = makeTask("milestone:o/r#3", { type: "milestone", title: "Syn" });

    const diffs = [
      { id: "o/r#draft-1", type: "added" as const, task: draft },
      { id: "o/r#draft-2", type: "added" as const, task: milestoneDraft },
      { id: "o/r#5", type: "modified" as const, task: modified, changedFields: ["title"] },
      deleted,
      { id: "milestone:o/r#3", type: "modified" as const, task: synthetic },
    ];

    const result = formatDiffPreview(diffs);
    // synthetic filtered out, so: 2 create (draft + milestone draft), 1 update, 1 skip (deleted)
    expect(result.summary.create).toBe(2);
    expect(result.summary.update).toBe(1);
    expect(result.summary.skip).toBe(1);
    expect(result.changes).toHaveLength(3);
  });
});
