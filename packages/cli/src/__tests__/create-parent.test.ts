import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCreateCommand } from "../commands/create.js";
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
    epic: { label: "Epic", display: "bar", color: "#00f", github_label: "epic" },
  },
  type_hierarchy: {},
  statuses: { field_name: "Status", values: {} },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "owner/repo",
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

function makeTasksFile(tasks: Task[] = []): TasksFile {
  return { tasks, cache: { comments: {}, reactions: {} } };
}

let currentTasksFile = makeTasksFile();
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

async function runCreate(args: string[]): Promise<void> {
  await createCreateCommand().parseAsync(args, { from: "user" });
}

describe("[FR-CLI-004-AC3] create --parent は参照を正規形へ解決して保存する", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    // 親候補: draft と実 Issue の両方を用意する
    currentTasksFile = makeTasksFile([
      makeTask("owner/repo#draft-1", { type: "epic" }),
      makeTask("owner/repo#293", { github_issue: 293 }),
    ]);
    writtenTasksFile = null;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("draft 短縮形 (draft-1) を正規形 owner/repo#draft-1 に解決して保存する", async () => {
    await runCreate(["--title", "子タスク", "--type", "task", "--parent", "draft-1", "--json"]);

    const created = writtenTasksFile?.tasks.find((t) => t.id === "owner/repo#draft-2");
    expect(created?.parent).toBe("owner/repo#draft-1");
    // 親の sub_tasks にも正規形の子 ID が追加される
    const parent = writtenTasksFile?.tasks.find((t) => t.id === "owner/repo#draft-1");
    expect(parent?.sub_tasks).toContain("owner/repo#draft-2");
    expect(process.exitCode).toBeUndefined();
  });

  it("番号形式 (293) を正規形 owner/repo#293 に解決して保存する", async () => {
    await runCreate(["--title", "子タスク", "--type", "task", "--parent", "293", "--json"]);

    const created = writtenTasksFile?.tasks.find((t) => t.id === "owner/repo#draft-2");
    expect(created?.parent).toBe("owner/repo#293");
    const parent = writtenTasksFile?.tasks.find((t) => t.id === "owner/repo#293");
    expect(parent?.sub_tasks).toContain("owner/repo#draft-2");
  });

  it("#付き番号形式 (#293) を正規形 owner/repo#293 に解決して保存する", async () => {
    await runCreate(["--title", "子タスク", "--type", "task", "--parent", "#293", "--json"]);

    const created = writtenTasksFile?.tasks.find((t) => t.id === "owner/repo#draft-2");
    expect(created?.parent).toBe("owner/repo#293");
  });

  it("完全形 (owner/repo#293) はそのまま保存する", async () => {
    await runCreate([
      "--title",
      "子タスク",
      "--type",
      "task",
      "--parent",
      "owner/repo#293",
      "--json",
    ]);

    const created = writtenTasksFile?.tasks.find((t) => t.id === "owner/repo#draft-2");
    expect(created?.parent).toBe("owner/repo#293");
  });

  it("存在しないタスクを指す --parent はエラーになりタスクを作成しない", async () => {
    await runCreate(["--title", "子タスク", "--type", "task", "--parent", "draft-99", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(writtenTasksFile).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Parent task not found: owner/repo#draft-99");
  });

  it("不正な入力 (foo-bar) は fallback 解決後に存在しない親としてエラーになる", async () => {
    await runCreate(["--title", "子タスク", "--type", "task", "--parent", "foo-bar", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(writtenTasksFile).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Parent task not found: owner/repo#foo-bar");
  });

  it("--parent 未指定なら parent は null のまま作成される", async () => {
    await runCreate(["--title", "単独タスク", "--type", "task", "--json"]);

    const created = writtenTasksFile?.tasks.find((t) => t.id === "owner/repo#draft-2");
    expect(created?.parent).toBeNull();
    expect(process.exitCode).toBeUndefined();
  });
});
