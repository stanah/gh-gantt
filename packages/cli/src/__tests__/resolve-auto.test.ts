import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResolveCommand } from "../commands/resolve.js";
import { extractSyncFields } from "../sync/hash.js";
import type { Config, SyncState, Task, TasksFile } from "@gh-gantt/shared";

function makeTask(issue: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `owner/repo#${issue}`,
    type: "task",
    github_issue: issue,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: `Task ${issue}`,
    body: null,
    acceptance_criteria: [],
    acceptance_criteria_slot: false,
    implementer: null,
    reviewer: null,
    require_review: false,
    review_approved_by: null,
    review_approved_at: null,
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

function makeConfig(sync: Config["sync"]): Config {
  return {
    version: "1",
    project: { name: "test", github: { owner: "owner", repo: "repo", project_number: 1 } },
    sync,
    task_types: {
      task: { label: "Task", display: "bar", color: "#000", github_label: null },
    },
    type_hierarchy: { task: [] },
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: {
        critical_path: "#f00",
        on_track: "#0f0",
        at_risk: "#ff0",
        overdue: "#f00",
      },
    },
  };
}

describe("[FR-SYNC-001-AC6] resolve --auto は設定済みフィールドだけを部分解決する", () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gh-gantt-resolve-auto-"));
    await mkdir(join(root, ".gantt-sync"), { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture(
    tasks: unknown[],
    conflictPolicy: Config["sync"]["conflict_policy"],
    legacyStrategy?: string,
  ): Promise<void> {
    const sync = {
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End" },
      conflict_policy: conflictPolicy,
      ...(legacyStrategy === undefined ? {} : { conflict_strategy: legacyStrategy }),
    } as Config["sync"];
    const config = makeConfig(sync);
    const tasksFile: TasksFile = {
      tasks: tasks as unknown as Task[],
      cache: { comments: {}, reactions: {} },
      has_conflicts: true,
    };
    const taskRecords = tasks as Record<string, unknown>[];
    const snapshots = Object.fromEntries(
      taskRecords.map((task) => [
        task.id as string,
        {
          hash: `local-${String(task.github_issue)}`,
          remoteHash: `remote-${String(task.github_issue)}`,
          synced_at: "2026-01-01T00:00:00Z",
          syncFields: extractSyncFields(task as unknown as Task),
        },
      ]),
    );
    const state: SyncState = {
      last_synced_at: "2026-01-01T00:00:00Z",
      project_node_id: "PVT_1",
      id_map: {},
      field_ids: {},
      snapshots,
    };
    await writeFile(join(root, ".gantt-sync/gantt.config.json"), `${JSON.stringify(config)}\n`);
    await writeFile(join(root, ".gantt-sync/tasks.json"), `${JSON.stringify(tasksFile)}\n`);
    await writeFile(join(root, ".gantt-sync/sync-state.json"), `${JSON.stringify(state)}\n`);
  }

  async function readTasks(): Promise<TasksFile & { tasks: Record<string, unknown>[] }> {
    return JSON.parse(await readFile(join(root, ".gantt-sync/tasks.json"), "utf8"));
  }

  async function readState(): Promise<SyncState> {
    return JSON.parse(await readFile(join(root, ".gantt-sync/sync-state.json"), "utf8"));
  }

  async function run(args: string[]): Promise<void> {
    await createResolveCommand({ projectRoot: () => root }).parseAsync(args, { from: "user" });
  }

  it("ours/theirs を適用し manual・未定義を残して has_conflicts を維持する", async () => {
    const task = Object.assign(makeTask(8), {
      state_current: "open",
      state_incoming: "closed",
      title_current: "Task 8",
      title_incoming: "Remote title",
      labels_current: [],
      labels_incoming: ["remote"],
      body_current: null,
      body_incoming: "Remote body",
    });
    await writeFixture([task], { state: "ours", labels: "theirs", title: "manual" });

    await run(["--auto"]);

    const tasksFile = await readTasks();
    expect(tasksFile.tasks[0]).not.toHaveProperty("state_current");
    expect(tasksFile.tasks[0].state).toBe("open");
    expect(tasksFile.tasks[0].labels).toEqual(["remote"]);
    expect(tasksFile.tasks[0]).toHaveProperty("title_current");
    expect(tasksFile.tasks[0]).toHaveProperty("body_current");
    expect(tasksFile.has_conflicts).toBe(true);
    expect((await readState()).snapshots[task.id]?.hash).toBe("local-8");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("title"));
  });

  it("issue と field filter の範囲外を変更しない", async () => {
    const task8 = Object.assign(makeTask(8), {
      state_current: "open",
      state_incoming: "closed",
      labels_current: [],
      labels_incoming: ["remote"],
    });
    const task9 = Object.assign(makeTask(9), {
      state_current: "open",
      state_incoming: "closed",
    });
    await writeFixture([task8, task9], { state: "theirs", labels: "theirs" });

    await run(["8", "--auto", "--field", "state", "--json"]);

    const tasksFile = await readTasks();
    expect(tasksFile.tasks[0].state).toBe("closed");
    expect(tasksFile.tasks[0]).toHaveProperty("labels_current");
    expect(tasksFile.tasks[1]).toHaveProperty("state_current");
    const json = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(json.task_count).toBe(1);
    expect(json).not.toHaveProperty("conflicts");
    expect(json.tasks[0].conflicts[0].field).toBe("labels");
  });

  it("issue filter対象外のconflict-free taskとsnapshotを構造的に変更しない", async () => {
    const task8 = Object.assign(makeTask(8), {
      state_current: "open",
      state_incoming: "closed",
    });
    const task9 = makeTask(9, { title: "未pushのローカル編集" });
    await writeFixture([task8, task9], { state: "theirs" });

    const seededState = await readState();
    seededState.snapshots[task9.id] = {
      ...seededState.snapshots[task9.id]!,
      hash: "old-local-9",
      syncFields: {
        ...seededState.snapshots[task9.id]!.syncFields!,
        title: "古いsnapshot title",
      },
    };
    await writeFile(join(root, ".gantt-sync/sync-state.json"), `${JSON.stringify(seededState)}\n`);
    const beforeTask9 = structuredClone((await readTasks()).tasks[1]);
    const beforeSnapshot9 = structuredClone((await readState()).snapshots[task9.id]);

    await run(["8", "--auto"]);

    const afterTasks = await readTasks();
    const afterState = await readState();
    expect(afterTasks.tasks[1]).toEqual(beforeTask9);
    expect(afterState.snapshots[task9.id]).toEqual(beforeSnapshot9);
    expect(afterTasks.tasks[1].title).toBe("未pushのローカル編集");
    expect(afterState.snapshots[task9.id]?.syncFields?.title).toBe("古いsnapshot title");
  });

  it("全フィールド theirs の完全解決だけ snapshot.hash を remoteHash に揃える", async () => {
    const task = Object.assign(makeTask(8), {
      state_current: "open",
      state_incoming: "closed",
      labels_current: [],
      labels_incoming: ["remote"],
    });
    await writeFixture([task], { state: "theirs", labels: "theirs" });

    await run(["8", "--auto"]);

    expect((await readState()).snapshots[task.id]?.hash).toBe("remote-8");
    expect((await readTasks()).has_conflicts).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith("No conflicts.");
  });

  it("ours が混在した完全解決では snapshot.hash を維持する", async () => {
    const task = Object.assign(makeTask(8), {
      state_current: "open",
      state_incoming: "closed",
      labels_current: [],
      labels_incoming: ["remote"],
    });
    await writeFixture([task], { state: "ours", labels: "theirs" });

    await run(["8", "--auto"]);

    expect((await readState()).snapshots[task.id]?.hash).toBe("local-8");
  });

  it("--auto と --ours/--theirs の競合はファイルを書き換える前に拒否する", async () => {
    const task = Object.assign(makeTask(8), {
      state_current: "open",
      state_incoming: "closed",
    });
    await writeFixture([task], { state: "theirs" });
    const before = await readFile(join(root, ".gantt-sync/tasks.json"), "utf8");

    await expect(run(["--auto", "--ours"])).rejects.toThrow(/排他的/);
    expect(await readFile(join(root, ".gantt-sync/tasks.json"), "utf8")).toBe(before);
  });

  it("non-SyncFields の対キーは marker と見なさず同期を停止しない", async () => {
    const task = Object.assign(makeTask(8), {
      unknown_current: "local",
      unknown_incoming: "remote",
    });
    await writeFixture([task], {});

    await run(["--auto"]);

    const tasksFile = await readTasks();
    expect(tasksFile.tasks[0]).toHaveProperty("unknown_current");
    expect(tasksFile.has_conflicts).toBeUndefined();
    expect((await readState()).snapshots[task.id]?.hash).toBe("local-8");
  });

  describe("[FR-SYNC-001-AC7] legacy conflict_strategy は読み込みだけを維持する", () => {
    it("stderr に1回警告し、値を自動解決へ適用せず JSON stdout を汚さない", async () => {
      const task = Object.assign(makeTask(8), {
        state_current: "open",
        state_incoming: "closed",
      });
      await writeFixture([task], {}, "remote-wins");

      await run(["--auto", "--json"]);

      const tasksFile = await readTasks();
      expect(tasksFile.tasks[0].state).toBe("open");
      expect(tasksFile.tasks[0]).toHaveProperty("state_current");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflict_policy"));
      expect(() => JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string)).not.toThrow();
    });
  });
});
