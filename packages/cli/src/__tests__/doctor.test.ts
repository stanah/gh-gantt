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
});
