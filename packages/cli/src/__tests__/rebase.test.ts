import { describe, it, expect } from "vitest";
import type { SyncFields, Config, TaskType } from "@gh-gantt/shared";
import { rebaseSyncFields } from "../sync/rebase.js";

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

function makeConfig(
  overrides: {
    task_types?: Record<string, TaskType>;
    field_mapping?: Partial<Config["sync"]["field_mapping"]>;
  } = {},
): Config {
  return {
    version: "1",
    project: { name: "test", github: { owner: "test", repo: "test", project_number: 1 } },
    sync: {
      auto_create_issues: false,
      field_mapping: {
        start_date: "Start",
        end_date: "End",
        status: "Status",
        ...overrides.field_mapping,
      },
    },
    task_types: overrides.task_types ?? {
      task: { label: "Task", display: "bar", color: "#0000ff", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
  };
}

describe("rebaseSyncFields", () => {
  it("re-resolves type using current config task_types", () => {
    const syncFields = makeSyncFields({
      type: "feature", // 旧設定で解決された値
      labels: ["type:feature"],
    });

    // 新設定では "type:feature" ラベルにマッチしない
    const config = makeConfig({
      task_types: {
        feature: { label: "Feature", display: "bar", color: "#0f0", github_label: "feat" },
        task: { label: "Task", display: "bar", color: "#00f", github_label: null },
      },
    });

    const rebased = rebaseSyncFields(syncFields, config);
    expect(rebased.type).toBe("task"); // 新設定で再解決
  });

  it("re-resolves type from github_field_value", () => {
    const syncFields = makeSyncFields({
      type: "epic",
      custom_fields: { Type: "Epic" },
    });

    const config = makeConfig({
      task_types: {
        epic: {
          label: "Epic",
          display: "summary",
          color: "#f00",
          github_label: null,
          github_field_value: "Epic",
        },
        task: { label: "Task", display: "bar", color: "#00f", github_label: null },
      },
      field_mapping: { start_date: "Start", end_date: "End", status: "Status", type: "Type" },
    });

    const rebased = rebaseSyncFields(syncFields, config);
    expect(rebased.type).toBe("epic"); // マッチするので変わらない
  });

  it("re-resolves start_date/end_date from custom_fields using field_mapping", () => {
    const syncFields = makeSyncFields({
      start_date: "2026-01-01",
      end_date: "2026-01-10",
      custom_fields: { Start: "2026-01-01", End: "2026-01-10" },
    });

    // field_mapping が正しい場合: custom_fields から値を取得
    const config = makeConfig({
      field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
    });
    const rebased = rebaseSyncFields(syncFields, config);
    expect(rebased.start_date).toBe("2026-01-01");
    expect(rebased.end_date).toBe("2026-01-10");
  });

  it("falls back to original start_date when field_mapping key not in custom_fields", () => {
    const syncFields = makeSyncFields({
      start_date: "2026-01-01",
      end_date: "2026-01-10",
      custom_fields: { Start: "2026-01-01", End: "2026-01-10" },
    });

    // field_mapping が誤っている場合: custom_fields にキーがない → フォールバック
    const config = makeConfig({
      field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
    });
    const rebased = rebaseSyncFields(syncFields, config);
    expect(rebased.start_date).toBe("2026-01-01"); // フォールバック
    expect(rebased.end_date).toBe("2026-01-10"); // フォールバック
  });

  it("does not modify non-config-dependent fields", () => {
    const syncFields = makeSyncFields({
      title: "My title",
      body: "My body",
      assignees: ["alice"],
      labels: ["bug"],
    });

    const config = makeConfig();
    const rebased = rebaseSyncFields(syncFields, config);
    expect(rebased.title).toBe("My title");
    expect(rebased.body).toBe("My body");
    expect(rebased.assignees).toEqual(["alice"]);
    expect(rebased.labels).toEqual(["bug"]);
  });
});
