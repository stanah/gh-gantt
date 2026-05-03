import { describe, expect, it } from "vitest";
import {
  getEstimateHoursField,
  getTaskEstimateHours,
  getTaskSizeExcess,
  parseEstimateHours,
  type Config,
  type Task,
} from "../index.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: "1",
    project: { name: "test", github: { owner: "owner", repo: "repo", project_number: 1 } },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1",
    type: "task",
    github_issue: 1,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "Test task",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

describe("[FR-CLI-015-AC1] タスクサイズ見積もりの設定解決", () => {
  it("estimate_hours field mapping が未設定なら既定キーを使う", () => {
    expect(getEstimateHoursField(makeConfig())).toBe("estimate_hours");
  });

  it("estimate_hours field mapping があればそのフィールドを読む", () => {
    const config = makeConfig({
      sync: {
        auto_create_issues: false,
        field_mapping: {
          start_date: "Start",
          end_date: "End",
          status: "Status",
          estimate_hours: "Estimate",
        },
      },
      max_task_size_hours: 8,
    });
    const task = makeTask({ custom_fields: { Estimate: "13" } });

    expect(getTaskEstimateHours(task, config)).toBe(13);
    expect(getTaskSizeExcess(task, config)).toEqual({
      estimate_hours: 13,
      max_task_size_hours: 8,
    });
  });

  it("数値でない estimate_hours は無視する", () => {
    expect(parseEstimateHours("not-a-number")).toBeNull();
    expect(parseEstimateHours(-1)).toBeNull();
  });
});
