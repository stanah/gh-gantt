import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../schema.js";

describe("ConfigSchema", () => {
  it("validates a minimal valid config", () => {
    const config = {
      version: "1",
      project: {
        name: "test",
        github: { owner: "stanah", repo: "my-repo", project_number: 1 },
      },
      sync: {
        conflict_strategy: "remote-wins",
        auto_create_issues: false,
        field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
      },
      task_types: {
        task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
      },
      type_hierarchy: { task: [] },
      statuses: {
        field_name: "Status",
        values: {
          Done: { color: "#2ECC71", done: true },
          Todo: { color: "#3498DB", done: false },
        },
      },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#E74C3C", on_track: "#2ECC71", at_risk: "#F39C12", overdue: "#E74C3C" },
      },
    };
    expect(ConfigSchema.parse(config)).toBeDefined();
  });

  it("rejects config with invalid display type", () => {
    const config = {
      version: "1",
      project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
      sync: { conflict_strategy: "remote-wins", auto_create_issues: false, field_mapping: { start_date: "S", end_date: "E", status: "St" } },
      task_types: { task: { label: "Task", display: "invalid", color: "#000", github_label: null } },
      type_hierarchy: { task: [] },
      statuses: { field_name: "Status", values: {} },
      gantt: { default_view: "month", working_days: [1], colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" } },
    };
    expect(() => ConfigSchema.parse(config)).toThrow();
  });
});
