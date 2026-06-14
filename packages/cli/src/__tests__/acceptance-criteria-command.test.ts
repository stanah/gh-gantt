import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptanceCriteriaCommand } from "../commands/ac.js";
import type { Config, Task, TasksFile } from "@gh-gantt/shared";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const mockConfig: Config = {
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
};

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

let currentTasksFile = makeTasksFile(makeTask());
let writtenTasksFile: TasksFile | null = null;

vi.mock("../store/config.js", () => ({
  ConfigStore: class {
    async read() {
      return mockConfig;
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

describe("[FR-CLI-011-AC2] ac add/check で受入基準を更新できる", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    currentTasksFile = makeTasksFile(makeTask());
    writtenTasksFile = null;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("ac add は未完了の受入基準を追加する", async () => {
    const cmd = createAcceptanceCriteriaCommand();
    await cmd.parseAsync(["add", "1", "期待する出力を表示できる", "--json"], {
      from: "user",
    });

    expect(writtenTasksFile?.tasks[0].acceptance_criteria).toEqual([
      { description: "期待する出力を表示できる", checked: false },
    ]);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string) as Task;
    expect(parsed.acceptance_criteria).toEqual(writtenTasksFile?.tasks[0].acceptance_criteria);
  });

  it("ac check は 1 始まりの index で受入基準を完了にする", async () => {
    currentTasksFile = makeTasksFile(
      makeTask({
        acceptance_criteria: [{ description: "期待する出力を表示できる", checked: false }],
      }),
    );

    const cmd = createAcceptanceCriteriaCommand();
    await cmd.parseAsync(["check", "1", "--index", "1", "--json"], { from: "user" });

    expect(writtenTasksFile?.tasks[0].acceptance_criteria).toEqual([
      { description: "期待する出力を表示できる", checked: true },
    ]);
  });

  it("範囲外の index では task を書き換えない", async () => {
    currentTasksFile = makeTasksFile(
      makeTask({
        acceptance_criteria: [{ description: "期待する出力を表示できる", checked: false }],
      }),
    );

    const cmd = createAcceptanceCriteriaCommand();
    await cmd.parseAsync(["check", "1", "--index", "2"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(writtenTasksFile).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("out of range"));
  });
});
