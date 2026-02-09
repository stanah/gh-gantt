import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";

describe("ConfigStore", () => {
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
      sync: { conflict_strategy: "remote-wins" as const, auto_create_issues: false, field_mapping: { start_date: "S", end_date: "E", status: "St" } },
      task_types: { task: { label: "Task", display: "bar" as const, color: "#000", github_label: null } },
      type_hierarchy: { task: [] },
      statuses: { field_name: "Status", values: { Done: { color: "#0f0", done: true } } },
      gantt: { default_view: "month" as const, working_days: [1, 2, 3, 4, 5], colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" } },
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

describe("TasksStore", () => {
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
      tasks: [{
        id: "t1", type: "task", github_issue: 1, github_repo: "o/r",
        parent: null, sub_tasks: [], title: "Test", body: null,
        state: "open" as const, state_reason: null, assignees: [], labels: [],
        milestone: null, linked_prs: [], created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z", closed_at: null,
        custom_fields: {}, start_date: "2026-01-01", end_date: "2026-01-10",
        date: null, blocked_by: [],
      }],
      cache: { comments: {}, reactions: {} },
    };
    await store.write(tasksFile);
    const loaded = await store.read();
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].title).toBe("Test");
  });
});
