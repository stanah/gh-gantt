/**
 * [NFR-STABILITY-001] doctor コマンドの整合性チェック
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectCycles,
  GANTT_DIR,
  CONFIG_FILE,
  TASKS_FILE,
  SYNC_STATE_FILE,
} from "@gh-gantt/shared";
import type { Task, SyncState, TasksFile, Config } from "@gh-gantt/shared";

// ── ヘルパー ──

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "o/r",
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
    created_at: "",
    updated_at: "",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeSyncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    last_synced_at: "",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots: {},
    ...overrides,
  };
}

function makeTasksFile(tasks: Task[]): TasksFile {
  return {
    tasks,
    cache: { comments: {}, reactions: {} },
  };
}

function makeConfig(): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "o", repo: "r", project_number: 1 },
    },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: { Done: { color: "#0f0", done: true } } },
    doctor: { stale_in_progress_days: 7 },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
  };
}

async function setupProjectDir(opts: {
  config?: Config | false;
  tasksFile?: TasksFile | false;
  syncState?: SyncState | false;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "doctor-test-"));
  const ganttDir = join(dir, GANTT_DIR);
  await mkdir(ganttDir, { recursive: true });

  if (opts.config !== false) {
    await writeFile(
      join(ganttDir, CONFIG_FILE),
      JSON.stringify(opts.config ?? makeConfig(), null, 2),
    );
  }
  if (opts.tasksFile !== false) {
    await writeFile(
      join(ganttDir, TASKS_FILE),
      JSON.stringify(opts.tasksFile ?? makeTasksFile([]), null, 2),
    );
  }
  if (opts.syncState !== false) {
    await writeFile(
      join(ganttDir, SYNC_STATE_FILE),
      JSON.stringify(opts.syncState ?? makeSyncState(), null, 2),
    );
  }

  return dir;
}

/**
 * doctor コマンドを --json --offline で実行し結果オブジェクトを返す。
 * --offline を常に付与して GitHub 認証の外部依存を排除する。
 */
async function runDoctorJson(
  dir: string,
  extraArgs: string[] = [],
): Promise<{
  checks: Array<{
    name: string;
    status: string;
    message: string;
    details?: string[];
    fixed?: boolean;
  }>;
  summary: { pass: number; warn: number; fail: number };
}> {
  const originalCwd = process.cwd();
  process.chdir(dir);

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  const origExitCode = process.exitCode;

  try {
    const { doctorCommand } = await import("../commands/doctor.js");
    const args = ["node", "doctor", "--json"];
    // --offline がまだ含まれていなければ追加
    if (!extraArgs.includes("--offline")) {
      args.push("--offline");
    }
    args.push(...extraArgs);
    await doctorCommand.parseAsync(args, { from: "user" });
    return JSON.parse(logs.join(""));
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode;
    process.chdir(originalCwd);
  }
}

// ── テスト ──

describe("[NFR-STABILITY-001] doctor コマンド", () => {
  let testDir: string | undefined;
  const safeDir = tmpdir();

  beforeEach(() => {
    process.chdir(safeDir);
  });

  afterEach(async () => {
    process.chdir(safeDir);
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
  });

  // ── 単体ロジックテスト（shared の detectCycles を使用） ──

  describe("循環依存チェック（shared detectCycles）", () => {
    it("循環がない場合は空配列を返す", () => {
      const tasks = [
        makeTask("A"),
        makeTask("B", { blocked_by: [{ task: "A", type: "finish-to-start", lag: 0 }] }),
      ];
      expect(detectCycles(tasks)).toEqual([]);
    });

    it("直接的な循環を検出する", () => {
      const tasks = [
        makeTask("A", { blocked_by: [{ task: "B", type: "finish-to-start", lag: 0 }] }),
        makeTask("B", { blocked_by: [{ task: "A", type: "finish-to-start", lag: 0 }] }),
      ];
      const cycles = detectCycles(tasks);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("三角形の循環を検出する", () => {
      const tasks = [
        makeTask("A", { blocked_by: [{ task: "C", type: "finish-to-start", lag: 0 }] }),
        makeTask("B", { blocked_by: [{ task: "A", type: "finish-to-start", lag: 0 }] }),
        makeTask("C", { blocked_by: [{ task: "B", type: "finish-to-start", lag: 0 }] }),
      ];
      const cycles = detectCycles(tasks);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("依存関係がない場合は空配列を返す", () => {
      const tasks = [makeTask("A"), makeTask("B"), makeTask("C")];
      expect(detectCycles(tasks)).toEqual([]);
    });
  });

  // ── コマンド定義テスト ──

  describe("コマンド定義", () => {
    it("doctor コマンドが program に登録されている", async () => {
      const { buildProgram } = await import("../program.js");
      const program = buildProgram();
      const names = program.commands.map((c) => c.name());
      expect(names).toContain("doctor");
    });

    it("--fix, --offline, --json オプションが定義されている", async () => {
      const { doctorCommand } = await import("../commands/doctor.js");
      const optionNames = doctorCommand.options.map((o) => o.long);
      expect(optionNames).toContain("--fix");
      expect(optionNames).toContain("--offline");
      expect(optionNames).toContain("--json");
    });
  });

  // ── 統合テスト（ファイルシステムベース） ──

  describe("ファイル存在チェック", () => {
    it("全ファイルが正常な場合 PASS を返す", async () => {
      testDir = await setupProjectDir({});
      const output = await runDoctorJson(testDir);

      const configCheck = output.checks.find((c) => c.name === "config-schema");
      expect(configCheck?.status).toBe("PASS");
      const tasksCheck = output.checks.find((c) => c.name === "tasks-file");
      expect(tasksCheck?.status).toBe("PASS");
      const stateCheck = output.checks.find((c) => c.name === "sync-state-file");
      expect(stateCheck?.status).toBe("PASS");
    });

    it("config が存在しない場合 FAIL を返す", async () => {
      testDir = await setupProjectDir({ config: false });
      const output = await runDoctorJson(testDir);

      const configCheck = output.checks.find((c) => c.name === "config-schema");
      expect(configCheck?.status).toBe("FAIL");
      expect(configCheck?.message).toContain("見つかりません");
    });

    it("tasks.json が存在しない場合 FAIL を返す", async () => {
      testDir = await setupProjectDir({ tasksFile: false });
      const output = await runDoctorJson(testDir);

      const tasksCheck = output.checks.find((c) => c.name === "tasks-file");
      expect(tasksCheck?.status).toBe("FAIL");
    });

    it("sync-state.json が存在しない場合 FAIL を返す", async () => {
      testDir = await setupProjectDir({ syncState: false });
      const output = await runDoctorJson(testDir);

      const stateCheck = output.checks.find((c) => c.name === "sync-state-file");
      expect(stateCheck?.status).toBe("FAIL");
    });
  });

  describe("循環依存検出（統合）", () => {
    it("循環がなければ PASS", async () => {
      const tasks = [
        makeTask("o/r#1", { github_issue: 1 }),
        makeTask("o/r#2", {
          github_issue: 2,
          blocked_by: [{ task: "o/r#1", type: "finish-to-start", lag: 0 }],
        }),
      ];
      testDir = await setupProjectDir({
        tasksFile: makeTasksFile(tasks),
        syncState: makeSyncState({
          id_map: {
            "o/r#1": { issue_number: 1, issue_node_id: "I_1", project_item_id: "PI_1" },
            "o/r#2": { issue_number: 2, issue_node_id: "I_2", project_item_id: "PI_2" },
          },
          snapshots: {
            "o/r#1": { hash: "abc", synced_at: "2026-01-01T00:00:00Z" },
            "o/r#2": { hash: "def", synced_at: "2026-01-01T00:00:00Z" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);
      const cycleCheck = output.checks.find((c) => c.name === "dependency-cycles");
      expect(cycleCheck?.status).toBe("PASS");
    });

    it("循環があれば FAIL と詳細を返す", async () => {
      const tasks = [
        makeTask("o/r#1", {
          github_issue: 1,
          blocked_by: [{ task: "o/r#2", type: "finish-to-start", lag: 0 }],
        }),
        makeTask("o/r#2", {
          github_issue: 2,
          blocked_by: [{ task: "o/r#1", type: "finish-to-start", lag: 0 }],
        }),
      ];
      testDir = await setupProjectDir({
        tasksFile: makeTasksFile(tasks),
        syncState: makeSyncState({
          id_map: {
            "o/r#1": { issue_number: 1, issue_node_id: "I_1", project_item_id: "PI_1" },
            "o/r#2": { issue_number: 2, issue_node_id: "I_2", project_item_id: "PI_2" },
          },
          snapshots: {
            "o/r#1": { hash: "abc", synced_at: "2026-01-01T00:00:00Z" },
            "o/r#2": { hash: "def", synced_at: "2026-01-01T00:00:00Z" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);
      const cycleCheck = output.checks.find((c) => c.name === "dependency-cycles");
      expect(cycleCheck?.status).toBe("FAIL");
      expect(cycleCheck?.details?.length).toBeGreaterThan(0);
    });
  });

  describe("[NFR-STABILITY-009-AC1] [Issue #140] project-level stale 検出", () => {
    it("in-progress の stale / PR 未紐付け / closed blocker / 孤立を WARN として返す", async () => {
      const config = makeConfig();
      config.statuses.values["In Progress"] = {
        color: "#00f",
        done: false,
        starts_work: true,
      };
      const closedBlocker = makeTask("o/r#1", {
        github_issue: 1,
        state: "closed",
        closed_at: "2026-01-02T00:00:00Z",
        custom_fields: { Status: "Done" },
      });
      const target = makeTask("o/r#2", {
        github_issue: 2,
        parent: null,
        updated_at: "2000-01-01T00:00:00Z",
        custom_fields: { Status: "In Progress" },
        blocked_by: [{ task: "o/r#1", type: "finish-to-start", lag: 0 }],
      });
      const healthy = makeTask("o/r#3", {
        github_issue: 3,
        parent: "o/r#99",
        updated_at: new Date().toISOString(),
        custom_fields: { Status: "In Progress" },
        linked_prs: [{ number: 10, title: "作業中", state: "open", url: null }],
      });
      const epicParent = makeTask("o/r#99", {
        github_issue: 99,
        type: "epic",
        custom_fields: { Status: "Todo" },
      });

      testDir = await setupProjectDir({
        config,
        tasksFile: makeTasksFile([closedBlocker, target, healthy, epicParent]),
        syncState: makeSyncState({
          id_map: {
            "o/r#1": { issue_number: 1, issue_node_id: "I_1", project_item_id: "PI_1" },
            "o/r#2": { issue_number: 2, issue_node_id: "I_2", project_item_id: "PI_2" },
            "o/r#3": { issue_number: 3, issue_node_id: "I_3", project_item_id: "PI_3" },
            "o/r#99": { issue_number: 99, issue_node_id: "I_99", project_item_id: "PI_99" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);

      const staleCheck = output.checks.find((c) => c.name === "project-stale-in-progress");
      expect(staleCheck?.status).toBe("WARN");
      expect(staleCheck?.details).toEqual([expect.stringContaining("o/r#2")]);

      const prCheck = output.checks.find((c) => c.name === "project-in-progress-pr");
      expect(prCheck?.status).toBe("WARN");
      expect(prCheck?.details).toEqual([expect.stringContaining("o/r#2")]);

      const blockerCheck = output.checks.find((c) => c.name === "project-closed-blockers");
      expect(blockerCheck?.status).toBe("WARN");
      expect(blockerCheck?.details).toEqual([expect.stringContaining("o/r#2")]);

      const orphanCheck = output.checks.find((c) => c.name === "project-orphan-in-progress");
      expect(orphanCheck?.status).toBe("WARN");
      expect(orphanCheck?.details).toEqual([expect.stringContaining("o/r#2")]);
    });

    it("stale 判定の閾値は gantt.config.json で変更できる", async () => {
      const config = makeConfig();
      config.doctor = { stale_in_progress_days: 999_999 };
      config.statuses.values["In Progress"] = {
        color: "#00f",
        done: false,
        category: "in_progress",
      };
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#99",
        updated_at: "2000-01-01T00:00:00Z",
        custom_fields: { Status: "In Progress" },
        linked_prs: [{ number: 10, title: "作業中", state: "open", url: null }],
      });

      testDir = await setupProjectDir({
        config,
        tasksFile: makeTasksFile([task]),
        syncState: makeSyncState({
          id_map: {
            "o/r#1": { issue_number: 1, issue_node_id: "I_1", project_item_id: "PI_1" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);
      const staleCheck = output.checks.find((c) => c.name === "project-stale-in-progress");

      expect(staleCheck?.status).toBe("PASS");
    });

    it("Epic ancestor を持たない nested task を孤立として検出する", async () => {
      const config = makeConfig();
      config.statuses.values["In Progress"] = {
        color: "#00f",
        done: false,
        starts_work: true,
      };
      const topLevelEpicLabel = makeTask("o/r#1", {
        github_issue: 1,
        labels: ["Epic"],
        custom_fields: { Status: "In Progress" },
      });
      const epic = makeTask("o/r#2", {
        github_issue: 2,
        type: "epic",
        custom_fields: { Status: "Todo" },
      });
      const featureUnderEpic = makeTask("o/r#3", {
        github_issue: 3,
        parent: "o/r#2",
        custom_fields: { Status: "Todo" },
      });
      const childUnderEpic = makeTask("o/r#4", {
        github_issue: 4,
        parent: "o/r#3",
        custom_fields: { Status: "In Progress" },
      });
      const orphanParent = makeTask("o/r#5", {
        github_issue: 5,
        custom_fields: { Status: "Todo" },
      });
      const orphanChild = makeTask("o/r#6", {
        github_issue: 6,
        parent: "o/r#5",
        custom_fields: { Status: "In Progress" },
      });
      const tasks = [
        topLevelEpicLabel,
        epic,
        featureUnderEpic,
        childUnderEpic,
        orphanParent,
        orphanChild,
      ];

      testDir = await setupProjectDir({
        config,
        tasksFile: makeTasksFile(tasks),
        syncState: makeSyncState({
          id_map: Object.fromEntries(
            tasks.map((task) => [
              task.id,
              {
                issue_number: task.github_issue ?? 0,
                issue_node_id: `I_${task.github_issue}`,
                project_item_id: `PI_${task.github_issue}`,
              },
            ]),
          ),
        }),
      });

      const output = await runDoctorJson(testDir);
      const orphanCheck = output.checks.find((c) => c.name === "project-orphan-in-progress");

      expect(orphanCheck?.status).toBe("WARN");
      expect(orphanCheck?.details).toEqual([expect.stringContaining("o/r#6")]);
    });

    it("未知 status の Working も in-progress として扱う", async () => {
      const config = makeConfig();
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#99",
        updated_at: "2000-01-01T00:00:00Z",
        custom_fields: { Status: "Working" },
        linked_prs: [{ number: 10, title: "作業中", state: "open", url: null }],
      });

      testDir = await setupProjectDir({
        config,
        tasksFile: makeTasksFile([task]),
        syncState: makeSyncState({
          id_map: {
            "o/r#1": { issue_number: 1, issue_node_id: "I_1", project_item_id: "PI_1" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);
      const staleCheck = output.checks.find((c) => c.name === "project-stale-in-progress");

      expect(staleCheck?.status).toBe("WARN");
      expect(staleCheck?.details).toEqual([expect.stringContaining("o/r#1")]);
    });

    it("updated_at 不正は stale 件数と分けて WARN にする", async () => {
      const config = makeConfig();
      config.statuses.values["In Progress"] = {
        color: "#00f",
        done: false,
        starts_work: true,
      };
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#99",
        updated_at: "not-a-date",
        custom_fields: { Status: "In Progress" },
        linked_prs: [{ number: 10, title: "作業中", state: "open", url: null }],
      });

      testDir = await setupProjectDir({
        config,
        tasksFile: makeTasksFile([task]),
        syncState: makeSyncState({
          id_map: {
            "o/r#1": { issue_number: 1, issue_node_id: "I_1", project_item_id: "PI_1" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);
      const invalidCheck = output.checks.find((c) => c.name === "project-invalid-updated-at");
      const staleCheck = output.checks.find((c) => c.name === "project-stale-in-progress");

      expect(invalidCheck?.status).toBe("WARN");
      expect(invalidCheck?.details).toEqual([expect.stringContaining("o/r#1")]);
      expect(staleCheck?.status).toBe("PASS");
    });
  });

  describe("--fix オプション", () => {
    it("--fix なしでは sync-state.json を書き換えない", async () => {
      testDir = await setupProjectDir({
        tasksFile: makeTasksFile([]),
        syncState: makeSyncState({
          snapshots: {
            "orphan-2": { hash: "xyz", synced_at: "2026-01-01T00:00:00Z" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);
      const integrityCheck = output.checks.find((c) => c.name === "sync-state-integrity");
      expect(integrityCheck?.fixed).toBeUndefined();

      // sync-state.json が書き戻されていないことを確認
      const written = JSON.parse(
        await readFile(join(testDir, GANTT_DIR, SYNC_STATE_FILE), "utf-8"),
      );
      expect(written.snapshots["orphan-2"]).toBeDefined();
    });

    it("orphan snapshot を自動修復して書き戻す", async () => {
      testDir = await setupProjectDir({
        tasksFile: makeTasksFile([]),
        syncState: makeSyncState({
          snapshots: {
            "orphan-1": { hash: "abc", synced_at: "2026-01-01T00:00:00Z" },
          },
        }),
      });

      const output = await runDoctorJson(testDir, ["--fix"]);
      const integrityCheck = output.checks.find((c) => c.name === "sync-state-integrity");
      expect(integrityCheck?.fixed).toBe(true);

      // sync-state.json が書き戻されていることを確認
      const written = JSON.parse(
        await readFile(join(testDir, GANTT_DIR, SYNC_STATE_FILE), "utf-8"),
      );
      expect(written.snapshots["orphan-1"]).toBeUndefined();
    });
  });

  describe("終了コード", () => {
    it("問題がなければ summary.fail が 0", async () => {
      testDir = await setupProjectDir({});
      const output = await runDoctorJson(testDir);
      expect(output.summary.fail).toBe(0);
    });

    it("FAIL チェックがあれば summary.fail > 0", async () => {
      testDir = await setupProjectDir({ config: false });
      const output = await runDoctorJson(testDir);
      expect(output.summary.fail).toBeGreaterThan(0);
    });
  });

  describe("[Issue #302] 宙ぶらりん参照の検出", () => {
    it("非正規形の parent 参照 (旧 create --parent の残骸) を WARN として検出する", async () => {
      // 過去の create --parent が生の "draft-1" / "293" を保存していたケースを再現
      const parent = makeTask("o/r#draft-1");
      const child1 = makeTask("o/r#draft-2", { parent: "draft-1" });
      const child2 = makeTask("o/r#draft-3", { parent: "293" });

      testDir = await setupProjectDir({
        tasksFile: makeTasksFile([parent, child1, child2]),
      });

      const output = await runDoctorJson(testDir);
      const check = output.checks.find((c) => c.name === "project-dangling-references");

      expect(check?.status).toBe("WARN");
      expect(check?.details).toHaveLength(2);
      expect(check?.details?.[0]).toContain('parent "draft-1" がタスク一覧に存在しません');
      expect(check?.details?.[1]).toContain('parent "293" がタスク一覧に存在しません');
    });

    it("存在しない blocked_by / sub_tasks 参照を WARN として検出する", async () => {
      const task = makeTask("o/r#1", {
        github_issue: 1,
        blocked_by: [{ task: "o/r#999", type: "finish-to-start", lag: 0 }],
        sub_tasks: ["o/r#draft-9"],
      });

      testDir = await setupProjectDir({ tasksFile: makeTasksFile([task]) });

      const output = await runDoctorJson(testDir);
      const check = output.checks.find((c) => c.name === "project-dangling-references");

      expect(check?.status).toBe("WARN");
      expect(check?.details).toHaveLength(2);
      expect(check?.details?.[0]).toContain('blocked_by "o/r#999" がタスク一覧に存在しません');
      expect(check?.details?.[1]).toContain('sub_tasks "o/r#draft-9" がタスク一覧に存在しません');
    });

    it("すべての参照が正規形で解決できる場合は PASS", async () => {
      const parent = makeTask("o/r#draft-1", { sub_tasks: ["o/r#draft-2"] });
      const child = makeTask("o/r#draft-2", {
        parent: "o/r#draft-1",
        blocked_by: [{ task: "o/r#draft-1", type: "finish-to-start", lag: 0 }],
      });

      testDir = await setupProjectDir({ tasksFile: makeTasksFile([parent, child]) });

      const output = await runDoctorJson(testDir);
      const check = output.checks.find((c) => c.name === "project-dangling-references");

      expect(check?.status).toBe("PASS");
    });
  });

  describe("[FR-CLI-015-AC3] doctor のタスクサイズ閾値チェック", () => {
    it("見積もりが max_task_size_hours を超えた open task を WARN として返す", async () => {
      const config = makeConfig();
      config.max_task_size_hours = 8;
      config.sync.field_mapping.estimate_hours = "Estimate";
      const task = makeTask("o/r#1", {
        github_issue: 1,
        updated_at: "2026-01-01T00:00:00Z",
        custom_fields: { Estimate: 13 },
      });

      testDir = await setupProjectDir({
        config,
        tasksFile: makeTasksFile([task]),
        syncState: makeSyncState({
          id_map: {
            "o/r#1": { issue_number: 1, issue_node_id: "I_1", project_item_id: "PI_1" },
          },
        }),
      });

      const output = await runDoctorJson(testDir);
      const taskSizeCheck = output.checks.find((c) => c.name === "project-task-size");

      expect(taskSizeCheck?.status).toBe("WARN");
      expect(taskSizeCheck?.details).toEqual([
        expect.stringContaining("gh-gantt-decompose で分解してください"),
      ]);
    });
  });
});
