import { describe, it, expect } from "vitest";
import { resolveTaskId } from "../util/task-id.js";
import type { Config } from "@gh-gantt/shared";

function makeConfig(): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "owner", repo: "repo", project_number: 1 },
    },
    sync: {
      conflict_strategy: "remote-wins",
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
  };
}

describe("resolveTaskId", () => {
  const config = makeConfig();

  it("resolves #6 to owner/repo#6", () => {
    expect(resolveTaskId("#6", config)).toBe("owner/repo#6");
  });

  it("resolves 6 to owner/repo#6", () => {
    expect(resolveTaskId("6", config)).toBe("owner/repo#6");
  });

  it("resolves draft-1 to owner/repo#draft-1", () => {
    expect(resolveTaskId("draft-1", config)).toBe("owner/repo#draft-1");
  });

  it("resolves #draft-1 to owner/repo#draft-1", () => {
    expect(resolveTaskId("#draft-1", config)).toBe("owner/repo#draft-1");
  });

  it("passes through fully qualified IDs", () => {
    expect(resolveTaskId("owner/repo#6", config)).toBe("owner/repo#6");
  });

  it("passes through cross-repo IDs", () => {
    expect(resolveTaskId("other/project#10", config)).toBe("other/project#10");
  });
});
