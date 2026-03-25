import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTaskListCommand } from "../commands/task/list.js";

vi.mock("../store/config.js", () => {
  return {
    ConfigStore: class {
      async read() {
        return {
          version: "1",
          project: { name: "test", github: { owner: "owner", repo: "repo", project_number: 1 } },
          sync: {
            auto_create_issues: false,
            field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
          },
          task_types: {
            task: { label: "Task", display: "bar", color: "#000", github_label: null },
            epic: { label: "Epic", display: "summary", color: "#00f", github_label: "epic" },
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
    },
  };
});

vi.mock("../store/tasks.js", () => {
  return {
    TasksStore: class {
      async read() {
        return {
          tasks: [
            {
              id: "milestone:owner/repo#1",
              type: "milestone",
              github_issue: null,
              github_repo: "owner/repo",
              parent: null,
              sub_tasks: [],
              title: "v1.0",
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
              date: "2026-06-01",
              blocked_by: [],
            },
          ],
        };
      }
    },
  };
});

describe("list command --type validation", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("does not error for --type milestone even when not in config.task_types", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const cmd = createTaskListCommand();
    await cmd.parseAsync(["list", "--type", "milestone"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("errors for truly unknown types", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cmd = createTaskListCommand();
    await cmd.parseAsync(["list", "--type", "nonexistent"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown task type"));
  });
});
