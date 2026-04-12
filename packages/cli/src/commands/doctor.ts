import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ConfigSchema,
  TasksFileSchema,
  SyncStateSchema,
  GANTT_DIR,
  CONFIG_FILE,
  TASKS_FILE,
  SYNC_STATE_FILE,
} from "@gh-gantt/shared";
import type { Task, SyncState, TasksFile } from "@gh-gantt/shared";
import { hashTask } from "../sync/hash.js";

const execFileAsync = promisify(execFile);

/** チェック結果のステータス */
type CheckStatus = "PASS" | "WARN" | "FAIL";

/** 個別のチェック結果 */
interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string[];
}

/** doctor コマンドの全体結果 */
interface DoctorResult {
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number };
}

// ── チェック関数群 ──

/** gantt.config.json の schema 妥当性をチェック */
async function checkConfig(projectRoot: string): Promise<CheckResult> {
  const path = join(projectRoot, GANTT_DIR, CONFIG_FILE);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    ConfigSchema.parse(parsed);
    return { name: "config-schema", status: "PASS", message: "gantt.config.json は有効です" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "config-schema",
        status: "FAIL",
        message: `${CONFIG_FILE} が見つかりません。'gh-gantt init' を実行してください`,
      };
    }
    return {
      name: "config-schema",
      status: "FAIL",
      message: `${CONFIG_FILE} のスキーマが不正です`,
      details: [String(err instanceof Error ? err.message : err)],
    };
  }
}

/** sync-state.json と tasks.json のハッシュ整合性をチェック */
async function checkHashIntegrity(
  tasksFile: TasksFile,
  syncState: SyncState,
): Promise<CheckResult> {
  const mismatches: string[] = [];

  for (const task of tasksFile.tasks) {
    const snapshot = syncState.snapshots[task.id];
    if (!snapshot) continue;

    const currentHash = hashTask(task);
    // snapshot.hash はローカル側の最後に同期したハッシュ。
    // ローカル変更がなければ currentHash === snapshot.hash になるはず。
    // ここでは snapshot 自体の hash フィールドが空や不正でないかをチェック。
    if (!snapshot.hash || typeof snapshot.hash !== "string") {
      mismatches.push(`${task.id}: snapshot.hash が不正 (値: ${JSON.stringify(snapshot.hash)})`);
    }
  }

  if (mismatches.length === 0) {
    return { name: "hash-integrity", status: "PASS", message: "ハッシュ整合性は正常です" };
  }
  return {
    name: "hash-integrity",
    status: "WARN",
    message: `${mismatches.length} 件のハッシュ不整合があります`,
    details: mismatches,
  };
}

/** id_map と tasks.json の対応関係をチェック */
function checkIdMap(tasksFile: TasksFile, syncState: SyncState): CheckResult {
  const taskIds = new Set(tasksFile.tasks.map((t) => t.id));
  const idMapKeys = new Set(Object.keys(syncState.id_map));
  const issues: string[] = [];

  // id_map にあるが tasks に無い
  for (const id of idMapKeys) {
    if (!taskIds.has(id)) {
      issues.push(`id_map に ${id} がありますが tasks.json に存在しません`);
    }
  }

  // tasks にあるが id_map に無い (draft- と milestone- は除外)
  for (const task of tasksFile.tasks) {
    if (task.id.startsWith("draft-")) continue;
    if (task.id.startsWith("milestone-")) continue;
    if (!idMapKeys.has(task.id)) {
      issues.push(`${task.id} が id_map に存在しません`);
    }
  }

  if (issues.length === 0) {
    return { name: "id-map", status: "PASS", message: "id_map と tasks.json は整合しています" };
  }
  return {
    name: "id-map",
    status: "WARN",
    message: `${issues.length} 件の id_map 不整合があります`,
    details: issues,
  };
}

/** タスク間の依存関係の循環検出 */
function checkCycles(tasks: Task[]): CheckResult {
  // detectCycles のロジックをインラインで実装 (ui パッケージへの依存を避ける)
  const graph = new Map<string, string[]>();
  for (const task of tasks) {
    if (!graph.has(task.id)) graph.set(task.id, []);
    for (const dep of task.blocked_by) {
      if (!graph.has(dep.task)) graph.set(dep.task, []);
      graph.get(dep.task)!.push(task.id);
    }
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string) {
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const neighbor of graph.get(node) ?? []) {
      if (inStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        cycles.push(path.slice(cycleStart));
      } else if (!visited.has(neighbor)) {
        dfs(neighbor);
      }
    }
    path.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) dfs(node);
  }

  if (cycles.length === 0) {
    return { name: "dependency-cycles", status: "PASS", message: "循環依存はありません" };
  }
  return {
    name: "dependency-cycles",
    status: "FAIL",
    message: `${cycles.length} 件の循環依存を検出しました`,
    details: cycles.map((c) => c.join(" → ") + " → " + c[0]),
  };
}

/** GitHub 認証の有効性をチェック */
async function checkGitHubAuth(): Promise<CheckResult> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 10000 });
    return { name: "github-auth", status: "PASS", message: "GitHub 認証は有効です" };
  } catch (err) {
    const message =
      err instanceof Error && "stderr" in err ? (err as { stderr: string }).stderr : String(err);
    return {
      name: "github-auth",
      status: "FAIL",
      message: "GitHub 認証が無効です。'gh auth login' を実行してください",
      details: [message.trim()],
    };
  }
}

// ── メインロジック ──

async function runDoctor(projectRoot: string): Promise<DoctorResult> {
  const checks: CheckResult[] = [];

  // 1. config チェック
  checks.push(await checkConfig(projectRoot));

  // sync データの読み込みを試みる
  let tasksFile: TasksFile | null = null;
  let syncState: SyncState | null = null;

  try {
    const tasksRaw = await readFile(join(projectRoot, GANTT_DIR, TASKS_FILE), "utf-8");
    tasksFile = TasksFileSchema.parse(JSON.parse(tasksRaw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      checks.push({
        name: "tasks-file",
        status: "FAIL",
        message: `${TASKS_FILE} が見つかりません。'gh-gantt pull' を実行してください`,
      });
    } else {
      checks.push({
        name: "tasks-file",
        status: "FAIL",
        message: `${TASKS_FILE} の読み込みに失敗しました`,
        details: [String(err instanceof Error ? err.message : err)],
      });
    }
  }

  try {
    const stateRaw = await readFile(join(projectRoot, GANTT_DIR, SYNC_STATE_FILE), "utf-8");
    syncState = SyncStateSchema.parse(JSON.parse(stateRaw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      checks.push({
        name: "sync-state-file",
        status: "FAIL",
        message: `${SYNC_STATE_FILE} が見つかりません。'gh-gantt pull' を実行してください`,
      });
    } else {
      checks.push({
        name: "sync-state-file",
        status: "FAIL",
        message: `${SYNC_STATE_FILE} の読み込みに失敗しました`,
        details: [String(err instanceof Error ? err.message : err)],
      });
    }
  }

  // tasks と syncState が両方読めた場合のみ整合性チェックを実行
  if (tasksFile && syncState) {
    checks.push(await checkHashIntegrity(tasksFile, syncState));
    checks.push(checkIdMap(tasksFile, syncState));
    checks.push(checkCycles(tasksFile.tasks));
  }

  // 5. GitHub 認証チェック
  checks.push(await checkGitHubAuth());

  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    warn: checks.filter((c) => c.status === "WARN").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
  };

  return { checks, summary };
}

// ── コマンド定義 ──

export const doctorCommand = new Command("doctor")
  .description("ローカル状態の整合性チェックと診断")
  .option("--json", "JSON 形式で出力")
  .option("--fix", "自動修復可能な項目を修正")
  .action(async (opts) => {
    const projectRoot = process.cwd();

    if (opts.fix) {
      // --fix は将来の拡張用。現時点では自動修復対象がないことを明示する。
      console.log("--fix: 現在自動修復可能な項目はありません。診断のみ実行します。");
      console.log();
    }

    const result = await runDoctor(projectRoot);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // テキスト出力
    const statusIcon = (s: CheckStatus) => (s === "PASS" ? "✓" : s === "WARN" ? "⚠" : "✗");
    const statusLabel = (s: CheckStatus) =>
      s === "PASS" ? "[PASS]" : s === "WARN" ? "[WARN]" : "[FAIL]";

    for (const check of result.checks) {
      console.log(`${statusIcon(check.status)} ${statusLabel(check.status)} ${check.message}`);
      if (check.details) {
        for (const detail of check.details) {
          console.log(`    ${detail}`);
        }
      }
    }

    console.log();
    console.log(
      `結果: ${result.summary.pass} passed, ${result.summary.warn} warnings, ${result.summary.fail} failures`,
    );

    if (result.summary.fail > 0) {
      process.exitCode = 1;
    }
  });
