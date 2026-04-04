import { describe, it, expect } from "vitest";
import { mapRemoteItemToTask } from "../sync/mapper.js";

// mergeRemoteIntoLocal was removed in sync-engine-redesign.
// Tests for the new 3-way merge logic are in three-way-merge.test.ts.

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    project: { github: { owner: "o", repo: "r", project_number: 1 } },
    sync: {
      field_mapping: { start_date: "Start", end_date: "End", type: "" },
      auto_create_issues: false,
    },
    task_types: { task: { github_label: null } },
    statuses: { field_name: "Status", values: {} },
    type_hierarchy: {},
    ...overrides,
  } as any;
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item1",
    content: {
      number: 42,
      repository: "owner/repo",
      title: "Test task",
      body: "Task body",
      state: "open",
      stateReason: null,
      assignees: ["alice"],
      labels: ["bug"],
      milestone: "v1.0",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      closedAt: null,
    },
    fieldValues: {
      Start: "2026-01-10",
      End: "2026-01-20",
    },
    ...overrides,
  } as any;
}

describe("[FR-SYNC-004-AC1] GitHub Project Item をローカル Task 形式に変換できる", () => {
  it("returns null for items without content", () => {
    const item = { id: "item1", content: null, fieldValues: {} };
    const config = makeConfig();
    expect(mapRemoteItemToTask(item, config)).toBeNull();
  });

  it("maps all fields correctly for a full item", () => {
    const task = mapRemoteItemToTask(makeItem(), makeConfig());
    expect(task).not.toBeNull();
    expect(task!.id).toBe("owner/repo#42");
    expect(task!.title).toBe("Test task");
    expect(task!.body).toBe("Task body");
    expect(task!.state).toBe("open");
    expect(task!.state_reason).toBeNull();
    expect(task!.github_issue).toBe(42);
    expect(task!.github_repo).toBe("owner/repo");
    expect(task!.assignees).toEqual(["alice"]);
    expect(task!.labels).toEqual(["bug"]);
    expect(task!.milestone).toBe("v1.0");
    expect(task!.created_at).toBe("2026-01-01T00:00:00Z");
    expect(task!.updated_at).toBe("2026-01-02T00:00:00Z");
    expect(task!.closed_at).toBeNull();
    expect(task!.parent).toBeNull();
    expect(task!.sub_tasks).toEqual([]);
    expect(task!.linked_prs).toEqual([]);
    expect(task!.blocked_by).toEqual([]);
    expect(task!.date).toBeNull();
  });

  it("handles null body and milestone", () => {
    const item = makeItem({
      content: {
        number: 10,
        repository: "owner/repo",
        title: "Minimal",
        body: null,
        state: "open",
        stateReason: null,
        assignees: [],
        labels: [],
        milestone: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        closedAt: null,
      },
    });
    const task = mapRemoteItemToTask(item, makeConfig());
    expect(task!.body).toBeNull();
    expect(task!.milestone).toBeNull();
  });

  it("maps start_date and end_date from field_mapping", () => {
    const task = mapRemoteItemToTask(makeItem(), makeConfig());
    expect(task!.start_date).toBe("2026-01-10");
    expect(task!.end_date).toBe("2026-01-20");
  });

  it("returns null start_date/end_date when field not present in fieldValues", () => {
    const item = makeItem({ fieldValues: {} });
    const task = mapRemoteItemToTask(item, makeConfig());
    expect(task!.start_date).toBeNull();
    expect(task!.end_date).toBeNull();
  });

  it("resolves type from labels when no custom field", () => {
    const config = makeConfig({
      task_types: {
        task: { github_label: null },
        epic: { github_label: "epic" },
        bug: { github_label: "bug" },
      },
    });
    const item = makeItem();
    item.content.labels = ["bug"];
    const task = mapRemoteItemToTask(item, config);
    expect(task!.type).toBe("bug");
  });

  it("resolves type from custom field value (github_field_value)", () => {
    const config = makeConfig({
      sync: {
        field_mapping: { start_date: "Start", end_date: "End", type: "TaskType" },
        auto_create_issues: false,
      },
      task_types: {
        task: { github_label: null },
        epic: { github_label: "epic", github_field_value: "Epic" },
        feature: { github_label: "feature", github_field_value: "Feature" },
      },
    });
    const item = makeItem({
      fieldValues: {
        Start: "2026-01-10",
        End: "2026-01-20",
        TaskType: "Feature",
      },
    });
    const task = mapRemoteItemToTask(item, config);
    expect(task!.type).toBe("feature");
  });

  it("maps custom_fields from all fieldValues", () => {
    const item = makeItem({
      fieldValues: {
        Start: "2026-01-10",
        End: "2026-01-20",
        Status: "In Progress",
        Priority: "High",
      },
    });
    const task = mapRemoteItemToTask(item, makeConfig());
    expect(task!.custom_fields).toEqual({
      Start: "2026-01-10",
      End: "2026-01-20",
      Status: "In Progress",
      Priority: "High",
    });
  });

  it("defaults type to 'task' when no label or field value matches", () => {
    const config = makeConfig({
      task_types: {
        task: { github_label: null },
        epic: { github_label: "epic", github_field_value: "Epic" },
      },
    });
    const item = makeItem();
    item.content.labels = ["unrelated-label"];
    const task = mapRemoteItemToTask(item, config);
    expect(task!.type).toBe("task");
  });

  it("handles closed state and closedAt", () => {
    const item = makeItem({
      content: {
        number: 42,
        repository: "owner/repo",
        title: "Closed task",
        body: "Done",
        state: "closed",
        stateReason: "completed",
        assignees: [],
        labels: [],
        milestone: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
        closedAt: "2026-01-05T00:00:00Z",
      },
    });
    const task = mapRemoteItemToTask(item, makeConfig());
    expect(task!.state).toBe("closed");
    expect(task!.state_reason).toBe("completed");
    expect(task!.closed_at).toBe("2026-01-05T00:00:00Z");
  });
});
