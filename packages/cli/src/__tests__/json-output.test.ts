import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTaskListCommand } from "../commands/task/list.js";
import { createTaskShowCommand } from "../commands/task/show.js";
import { buildConflictJson } from "../commands/conflicts.js";
import type { SyncState } from "@gh-gantt/shared";

// --- 共通モックデータ ---

const mockTask = {
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
  start_date: "2026-01-01",
  end_date: "2026-01-10",
  date: null,
  blocked_by: [],
};

const mockConfig = {
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
      return { tasks: [mockTask] };
    }
  },
}));

vi.mock("../util/task-id.js", () => ({
  resolveTaskId: (_id: string, _config: unknown) => "owner/repo#1",
}));

// --- list --json ---

describe("[Issue #E-1] list --json が機械可読な JSON を出力する", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs valid JSON with tasks array", async () => {
    const cmd = createTaskListCommand();
    await cmd.parseAsync(["list", "--json"], { from: "user" });

    expect(logSpy).toHaveBeenCalledOnce();
    const raw = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("tasks");
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks[0]).toMatchObject({ id: "owner/repo#1", title: "Test task" });
  });

  it("outputs text table without --json", async () => {
    const cmd = createTaskListCommand();
    await cmd.parseAsync(["list"], { from: "user" });

    expect(logSpy).toHaveBeenCalled();
    const raw = logSpy.mock.calls[0][0] as string;
    // テキスト出力は JSON としてパースできない
    expect(() => JSON.parse(raw)).toThrow();
  });
});

// --- show --json ---

describe("[Issue #E-1] show --json が機械可読な JSON を出力する", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs task as JSON object", async () => {
    const cmd = createTaskShowCommand();
    await cmd.parseAsync(["show", "1", "--json"], { from: "user" });

    expect(logSpy).toHaveBeenCalledOnce();
    const raw = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ id: "owner/repo#1", title: "Test task", type: "task" });
  });

  it("outputs text format without --json", async () => {
    const cmd = createTaskShowCommand();
    await cmd.parseAsync(["show", "1"], { from: "user" });

    expect(logSpy).toHaveBeenCalledOnce();
    const raw = logSpy.mock.calls[0][0] as string;
    expect(raw).toContain("ID:");
    expect(raw).toContain("Title:");
  });
});

// --- buildConflictJson ---

describe("[Issue #E-1] buildConflictJson がコンフリクトを JSON で返す", () => {
  const tasks: Record<string, unknown>[] = [
    {
      id: "owner/repo#8",
      title: "Fix login bug",
      state: "open",
      state_current: "open",
      state_incoming: "closed",
    },
  ];

  const snapshots: SyncState["snapshots"] = {
    "owner/repo#8": {
      hash: "abc123",
      synced_at: "2026-01-01T00:00:00Z",
      syncFields: {
        title: "Fix login bug",
        body: "",
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
      },
    },
  };

  it("returns task_count and conflict_count", () => {
    const result = buildConflictJson(tasks, snapshots);
    expect(result.task_count).toBe(1);
    expect(result.conflict_count).toBe(1);
  });

  it("includes task id, title, issue number and conflict details", () => {
    const result = buildConflictJson(tasks, snapshots);
    expect(result.tasks).toHaveLength(1);
    const t = result.tasks[0];
    expect(t.id).toBe("owner/repo#8");
    expect(t.title).toBe("Fix login bug");
    expect(t.issue).toBe(8);
    expect(t.conflicts).toHaveLength(1);
    expect(t.conflicts[0].field).toBe("state");
    expect(t.conflicts[0].current).toBe("open");
    expect(t.conflicts[0].incoming).toBe("closed");
    expect(t.conflicts[0].base).toBe("open");
  });

  it("returns empty tasks array when no conflicts", () => {
    const noConflictTasks: Record<string, unknown>[] = [
      { id: "owner/repo#1", title: "Normal task", state: "open" },
    ];
    const result = buildConflictJson(noConflictTasks, {});
    expect(result.tasks).toHaveLength(0);
    expect(result.task_count).toBe(0);
    expect(result.conflict_count).toBe(0);
  });

  it("filters by issue number", () => {
    const multipleTasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8",
        title: "Task 8",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
      },
      {
        id: "owner/repo#9",
        title: "Task 9",
        title_current: "Task 9",
        title_incoming: "Task 9 updated",
      },
    ];
    const result = buildConflictJson(multipleTasks, snapshots, 8);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe("owner/repo#8");
    expect(result.task_count).toBe(1);
  });
});
