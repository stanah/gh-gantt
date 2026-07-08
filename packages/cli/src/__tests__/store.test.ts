import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";

describe("[FR-STORE-001-AC1] gantt.config.json を Zod バリデーション付きで読み書きできる", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-gantt-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("writes and reads config", async () => {
    const store = new ConfigStore(dir);
    const config = {
      version: "1",
      project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
      sync: {
        auto_create_issues: false,
        field_mapping: { start_date: "S", end_date: "E" },
      },
      task_types: {
        task: { label: "Task", display: "bar" as const, color: "#000", github_label: null },
      },
      type_hierarchy: { task: [] },
      statuses: { field_name: "Status", values: { Done: { color: "#0f0", done: true } } },
      gantt: {
        default_view: "month" as const,
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
      },
    };
    await store.write(config);
    const loaded = await store.read();
    expect(loaded.project.name).toBe("test");
  });

  it("throws when config does not exist", async () => {
    const store = new ConfigStore(dir);
    await expect(store.read()).rejects.toThrow();
  });
});

describe("[FR-STORE-001-AC4] deprecated な sync.field_mapping.status の食い違い警告", () => {
  let dir: string;

  const baseConfig = {
    version: "1",
    project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "S", end_date: "E" },
    },
    task_types: {
      task: { label: "Task", display: "bar" as const, color: "#000", github_label: null },
    },
    type_hierarchy: { task: [] },
    statuses: { field_name: "Status", values: { Done: { color: "#0f0", done: true } } },
    gantt: {
      default_view: "month" as const,
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-gantt-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
    vi.restoreAllMocks();
  });

  it("statuses.field_name と食い違う field_mapping.status で読み込むと警告が出る", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ConfigStore(dir);
    await store.write({
      ...baseConfig,
      sync: {
        ...baseConfig.sync,
        field_mapping: { ...baseConfig.sync.field_mapping, status: "State" },
      },
    });
    const loaded = await store.read();
    expect(loaded.statuses.field_name).toBe("Status");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain("sync.field_mapping.status");
    expect(message).toContain("State");
    expect(message).toContain("Status");
    expect(message).toContain("deprecated");
  });

  it("field_mapping.status が statuses.field_name と一致する場合は警告が出ない", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ConfigStore(dir);
    await store.write({
      ...baseConfig,
      sync: {
        ...baseConfig.sync,
        field_mapping: { ...baseConfig.sync.field_mapping, status: "Status" },
      },
    });
    await store.read();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("field_mapping.status が未設定の場合は警告が出ない", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ConfigStore(dir);
    await store.write(baseConfig);
    await store.read();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("[FR-STORE-002-AC1] tasks.json を Zod バリデーション付きで読み書きできる", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-gantt-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("writes and reads tasks file", async () => {
    const store = new TasksStore(dir);
    const tasksFile = {
      tasks: [
        {
          id: "t1",
          type: "task",
          github_issue: 1,
          github_repo: "o/r",
          parent: null,
          sub_tasks: [],
          title: "Test",
          body: null,
          state: "open" as const,
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
        },
      ],
      cache: { comments: {}, reactions: {} },
    };
    await store.write(tasksFile);
    const loaded = await store.read();
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].title).toBe("Test");
  });
});
