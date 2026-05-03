import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Task, TasksFile } from "@gh-gantt/shared";
import { CONFIG_FILE, GANTT_DIR, TASKS_FILE } from "@gh-gantt/shared";
import { createSprintCommand } from "../commands/sprint.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "owner", repo: "repo", project_number: 1 },
    },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000000", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: {
        critical_path: "#ff0000",
        on_track: "#00ff00",
        at_risk: "#ffff00",
        overdue: "#ff0000",
      },
    },
    ...overrides,
  };
}

async function writeConfig(root: string, config: Config): Promise<void> {
  const configDir = join(root, GANTT_DIR);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
}

async function readConfig(root: string): Promise<Config> {
  const raw = await readFile(join(root, GANTT_DIR, CONFIG_FILE), "utf-8");
  return JSON.parse(raw) as Config;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1",
    type: "task",
    github_issue: 1,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "Task 1",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    custom_fields: { Status: "Todo" },
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

async function writeTasks(root: string, tasks: Task[]): Promise<void> {
  const configDir = join(root, GANTT_DIR);
  await mkdir(configDir, { recursive: true });
  const tasksFile: TasksFile = {
    tasks,
    cache: {
      comments: { "owner/repo#1": [{ author: "bot", body: "cached", created_at: "2026-05-01" }] },
      reactions: {},
    },
  };
  await writeFile(join(configDir, TASKS_FILE), JSON.stringify(tasksFile, null, 2) + "\n");
}

async function readTasks(root: string): Promise<TasksFile> {
  const raw = await readFile(join(root, GANTT_DIR, TASKS_FILE), "utf-8");
  return JSON.parse(raw) as TasksFile;
}

async function runSprintCommand(args: string[]): Promise<void> {
  const command = createSprintCommand();
  command.exitOverride();
  await command.parseAsync(args, { from: "user" });
}

describe("[FR-CLI-009-AC1] sprint CLI で config の sprints を CRUD できる", () => {
  let tmpRoot: string;
  let originalCwd: string;
  let originalExitCode: number | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "gh-gantt-sprint-"));
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    process.chdir(tmpRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeConfig(tmpRoot, makeConfig());
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("list/create/update/delete が JSON とテキスト出力で同じ sprint 設定を扱う", async () => {
    await runSprintCommand([
      "create",
      "Sprint 1",
      "--start-date",
      "2026-05-04",
      "--end-date",
      "2026-05-15",
      "--color",
      "#123abc",
      "--json",
    ]);

    const created = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      sprint: { name: string; start_date: string; end_date: string; color: string };
    };
    expect(created.sprint).toEqual({
      name: "Sprint 1",
      start_date: "2026-05-04",
      end_date: "2026-05-15",
      color: "#123abc",
    });
    await expect(readConfig(tmpRoot)).resolves.toMatchObject({
      sprints: [created.sprint],
    });

    await runSprintCommand(["list", "--json"]);
    const listed = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      sprints: (typeof created.sprint)[];
    };
    expect(listed.sprints).toEqual([created.sprint]);

    await runSprintCommand([
      "update",
      "Sprint 1",
      "--name",
      "Sprint 1A",
      "--start-date",
      "2026-05-05",
      "--end-date",
      "2026-05-16",
      "--color",
      "#abcdef",
      "--json",
    ]);
    const updated = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      sprint: { name: string; start_date: string; end_date: string; color: string };
    };
    expect(updated.sprint).toEqual({
      name: "Sprint 1A",
      start_date: "2026-05-05",
      end_date: "2026-05-16",
      color: "#abcdef",
    });

    await runSprintCommand(["delete", "Sprint 1A"]);
    expect(logSpy.mock.calls.at(-1)?.[0]).toBe("Deleted sprint: Sprint 1A");
    await expect(readConfig(tmpRoot)).resolves.toMatchObject({ sprints: [] });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("[FR-CLI-009-AC2] sprint CLI は重複 name と不正な日付範囲を拒否する", () => {
  let tmpRoot: string;
  let originalCwd: string;
  let originalExitCode: number | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "gh-gantt-sprint-invalid-"));
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    process.chdir(tmpRoot);
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeConfig(
      tmpRoot,
      makeConfig({
        sprints: [
          {
            name: "Sprint 1",
            start_date: "2026-05-04",
            end_date: "2026-05-15",
            color: "#123abc",
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("既存 name の create と end_date < start_date の update を失敗扱いにする", async () => {
    await runSprintCommand([
      "create",
      "Sprint 1",
      "--start-date",
      "2026-06-01",
      "--end-date",
      "2026-06-14",
      "--color",
      "#654321",
    ]);
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toContain("already exists");

    process.exitCode = undefined;
    await runSprintCommand([
      "update",
      "Sprint 1",
      "--start-date",
      "2026-05-20",
      "--end-date",
      "2026-05-10",
    ]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toContain("start_date");
    await expect(readConfig(tmpRoot)).resolves.toMatchObject({
      sprints: [
        {
          name: "Sprint 1",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
          color: "#123abc",
        },
      ],
    });
  });
});

describe("[FR-CLI-010-AC1][FR-CLI-010-AC2][FR-CLI-010-AC3] sprint CLI で task を sprint へ移動できる", () => {
  let tmpRoot: string;
  let originalCwd: string;
  let originalExitCode: number | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const sprintConfig = makeConfig({
    statuses: {
      field_name: "Status",
      values: {
        Todo: { color: "#3498db", done: false },
        Done: { color: "#2ecc71", done: true },
      },
    },
    sprints: [
      {
        name: "Sprint 1",
        start_date: "2026-05-04",
        end_date: "2026-05-15",
        color: "#123abc",
      },
      {
        name: "Sprint 2",
        start_date: "2026-05-18",
        end_date: "2026-05-29",
        color: "#654321",
      },
    ],
  });

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "gh-gantt-sprint-move-"));
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    process.chdir(tmpRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeConfig(tmpRoot, sprintConfig);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("[FR-CLI-010-AC1] assign は指定 task の期間を sprint 期間に更新し JSON を返す", async () => {
    await writeTasks(tmpRoot, [
      makeTask({ id: "owner/repo#1", github_issue: 1, title: "Backlog task" }),
      makeTask({
        id: "owner/repo#2",
        github_issue: 2,
        title: "Scheduled task",
        start_date: "2026-06-01",
        end_date: "2026-06-03",
      }),
    ]);

    await runSprintCommand(["assign", "Sprint 1", "1", "owner/repo#2", "--json"]);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      sprint: { name: string };
      updated: Task[];
    };
    expect(payload.sprint.name).toBe("Sprint 1");
    expect(payload.updated.map((task) => task.id)).toEqual(["owner/repo#1", "owner/repo#2"]);
    expect(payload.updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "owner/repo#1",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
        }),
        expect.objectContaining({
          id: "owner/repo#2",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
        }),
      ]),
    );

    const tasksFile = await readTasks(tmpRoot);
    expect(tasksFile.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "owner/repo#1",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
        }),
        expect.objectContaining({
          id: "owner/repo#2",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
        }),
      ]),
    );
    expect(tasksFile.cache.comments["owner/repo#1"]?.[0]?.body).toBe("cached");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("[FR-CLI-010-AC2] carry-over は source sprint 内の未完了 task だけを target sprint へ移す", async () => {
    await writeTasks(tmpRoot, [
      makeTask({
        id: "owner/repo#1",
        github_issue: 1,
        title: "Open in sprint",
        start_date: "2026-05-04",
        end_date: "2026-05-15",
      }),
      makeTask({
        id: "owner/repo#2",
        github_issue: 2,
        title: "Closed in sprint",
        state: "closed",
        start_date: "2026-05-04",
        end_date: "2026-05-15",
      }),
      makeTask({
        id: "owner/repo#3",
        github_issue: 3,
        title: "Done in sprint",
        custom_fields: { Status: "Done" },
        start_date: "2026-05-04",
        end_date: "2026-05-15",
      }),
      makeTask({
        id: "owner/repo#4",
        github_issue: 4,
        title: "Outside sprint",
        start_date: "2026-06-01",
        end_date: "2026-06-03",
      }),
    ]);

    await runSprintCommand(["carry-over", "Sprint 1", "Sprint 2", "--json"]);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      from: { name: string };
      to: { name: string };
      updated: Task[];
    };
    expect(payload.from.name).toBe("Sprint 1");
    expect(payload.to.name).toBe("Sprint 2");
    expect(payload.updated.map((task) => task.id)).toEqual(["owner/repo#1"]);

    const tasksFile = await readTasks(tmpRoot);
    expect(tasksFile.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "owner/repo#1",
          start_date: "2026-05-18",
          end_date: "2026-05-29",
        }),
        expect.objectContaining({
          id: "owner/repo#2",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
        }),
        expect.objectContaining({
          id: "owner/repo#3",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
        }),
        expect.objectContaining({
          id: "owner/repo#4",
          start_date: "2026-06-01",
          end_date: "2026-06-03",
        }),
      ]),
    );
  });

  it("[FR-CLI-010-AC3] unknown task と unknown sprint は失敗し task を変更しない", async () => {
    const originalTask = makeTask({
      id: "owner/repo#1",
      github_issue: 1,
      title: "Stable task",
      start_date: "2026-06-01",
      end_date: "2026-06-03",
    });
    await writeTasks(tmpRoot, [originalTask]);

    await runSprintCommand(["assign", "Sprint 1", "999"]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toContain("Task not found");
    await expect(readTasks(tmpRoot)).resolves.toMatchObject({ tasks: [originalTask] });

    process.exitCode = undefined;
    await runSprintCommand(["carry-over", "Missing", "Sprint 2"]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toContain('Sprint not found: "Missing"');
    await expect(readTasks(tmpRoot)).resolves.toMatchObject({ tasks: [originalTask] });
  });
});
