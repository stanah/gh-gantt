import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskCloseCommand } from "../commands/task/close.js";
import type { Config, Task, TasksFile } from "@gh-gantt/shared";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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
    acceptance_criteria: [],
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

function makeTasksFile(task: Task): TasksFile {
  return { tasks: [task], cache: { comments: {}, reactions: {} } };
}

let currentConfig = makeConfig();
let currentTasksFile = makeTasksFile(makeTask());
let writtenTasksFile: TasksFile | null = null;

vi.mock("../store/config.js", () => ({
  ConfigStore: class {
    async read() {
      return currentConfig;
    }
  },
}));

vi.mock("../store/tasks.js", () => ({
  TasksStore: class {
    async read() {
      return clone(currentTasksFile);
    }

    async write(data: TasksFile) {
      writtenTasksFile = clone(data);
      currentTasksFile = clone(data);
    }
  },
}));

vi.mock("../util/task-id.js", () => ({
  resolveTaskId: () => "owner/repo#1",
}));

describe("[FR-CLI-016-AC1] close command の evidence warning", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    currentConfig = makeConfig();
    currentTasksFile = makeTasksFile(makeTask());
    writtenTasksFile = null;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("空白だけの --evidence は実効証跡なしとして警告する", async () => {
    const cmd = createTaskCloseCommand();

    await cmd.parseAsync(["close", "1", "--evidence", "   "], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Closed task: owner/repo#1");
    expect(warnSpy).toHaveBeenCalledWith(
      'Warning: closing without evidence. Use --evidence "<summary>".',
    );
    expect(writtenTasksFile?.tasks[0].state).toBe("closed");
    expect(writtenTasksFile?.tasks[0].body).toBeNull();
  });
});
