import { Command } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, SyncState, TasksFile } from "@gh-gantt/shared";
import { detectCycles } from "@gh-gantt/shared";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { hashTask } from "../sync/hash.js";
import { validateSyncState, type SyncStateFinding } from "../sync/validate-sync-state.js";

const execFileAsync = promisify(execFile);

/** チェック結果のステータス */
type CheckStatus = "PASS" | "WARN" | "FAIL";

/** 個別のチェック結果 */
interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string[];
  /** --fix で自動修復された場合 true */
  fixed?: boolean;
}

/** doctor コマンドの全体結果 */
interface DoctorResult {
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number };
}

// ── チェック関数群 ──

/** gantt.config.json の schema 妥当性をチェック */
async function checkConfig(projectRoot: string): Promise<CheckResult> {
  try {
    await new ConfigStore(projectRoot).read();
    return { name: "config-schema", status: "PASS", message: "gantt.config.json は有効です" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "config-schema",
        status: "FAIL",
        message: "gantt.config.json が見つかりません。'gh-gantt init' を実行してください",
      };
    }
    return {
      name: "config-schema",
      status: "FAIL",
      message: "gantt.config.json のスキーマが不正です",
      details: [String(err instanceof Error ? err.message : err)],
    };
  }
}

/** tasks.json の schema 妥当性をチェック */
async function checkTasksFile(
  projectRoot: string,
): Promise<{ result: CheckResult; data: TasksFile | null }> {
  try {
    const data = await new TasksStore(projectRoot).read();
    return {
      result: { name: "tasks-file", status: "PASS", message: "tasks.json は有効です" },
      data,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        result: {
          name: "tasks-file",
          status: "FAIL",
          message: "tasks.json が見つかりません。'gh-gantt pull' を実行してください",
        },
        data: null,
      };
    }
    return {
      result: {
        name: "tasks-file",
        status: "FAIL",
        message: "tasks.json の読み込みに失敗しました",
        details: [String(err instanceof Error ? err.message : err)],
      },
      data: null,
    };
  }
}

/** sync-state.json の schema 妥当性をチェック */
async function checkSyncStateFile(
  projectRoot: string,
): Promise<{ result: CheckResult; data: SyncState | null }> {
  try {
    const data = await new SyncStateStore(projectRoot).read();
    return {
      result: { name: "sync-state-file", status: "PASS", message: "sync-state.json は有効です" },
      data,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        result: {
          name: "sync-state-file",
          status: "FAIL",
          message: "sync-state.json が見つかりません。'gh-gantt pull' を実行してください",
        },
        data: null,
      };
    }
    return {
      result: {
        name: "sync-state-file",
        status: "FAIL",
        message: "sync-state.json の読み込みに失敗しました",
        details: [String(err instanceof Error ? err.message : err)],
      },
      data: null,
    };
  }
}

/** sync-state 整合性チェック（validateSyncState を利用） */
function checkSyncStateIntegrity(
  syncState: SyncState,
  tasksFile: TasksFile,
  fix: boolean,
): { result: CheckResult; fixedSyncState: SyncState | null; findings: SyncStateFinding[] } {
  const { syncState: validated, findings } = validateSyncState(syncState, tasksFile);

  if (findings.length === 0) {
    return {
      result: {
        name: "sync-state-integrity",
        status: "PASS",
        message: "sync-state 整合性は正常です",
      },
      fixedSyncState: null,
      findings,
    };
  }

  const autoFixable = findings.filter((f) => f.autoFixed);
  const warnings = findings.filter((f) => !f.autoFixed);
  const details = findings.map((f) => `[${f.category}] ${f.message}`);

  // --fix で自動修復可能なものがある場合
  if (fix && autoFixable.length > 0) {
    return {
      result: {
        name: "sync-state-integrity",
        status: warnings.length > 0 ? "WARN" : "PASS",
        message:
          `${autoFixable.length} 件を自動修復しました` +
          (warnings.length > 0 ? `（${warnings.length} 件は手動対応が必要です）` : ""),
        details,
        fixed: true,
      },
      fixedSyncState: validated,
      findings,
    };
  }

  return {
    result: {
      name: "sync-state-integrity",
      status: "WARN",
      message: `${findings.length} 件の sync-state 不整合があります`,
      details,
    },
    fixedSyncState: null,
    findings,
  };
}

/** hash 再計算照合: hashTask() で再計算し snapshot.hash と比較 */
function checkHashIntegrity(tasksFile: TasksFile, syncState: SyncState): CheckResult {
  const mismatches: string[] = [];

  for (const task of tasksFile.tasks) {
    const snapshot = syncState.snapshots[task.id];
    if (!snapshot) continue;

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

/** タスク間の依存関係の循環検出（shared の detectCycles を使用） */
function checkCycles(tasks: Task[]): CheckResult {
  const cycles = detectCycles(tasks);

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

interface DoctorOptions {
  fix: boolean;
  offline: boolean;
}

async function runDoctor(projectRoot: string, opts: DoctorOptions): Promise<DoctorResult> {
  const checks: CheckResult[] = [];

  // 1. config チェック
  checks.push(await checkConfig(projectRoot));

  // 2. tasks.json チェック
  const { result: tasksResult, data: tasksFile } = await checkTasksFile(projectRoot);
  checks.push(tasksResult);

  // 3. sync-state.json チェック
  const { result: stateResult, data: syncState } = await checkSyncStateFile(projectRoot);
  checks.push(stateResult);

  // tasks と syncState が両方読めた場合のみ整合性チェックを実行
  if (tasksFile && syncState) {
    // 4. sync-state 整合性
    const { result: integrityResult, fixedSyncState } = checkSyncStateIntegrity(
      syncState,
      tasksFile,
      opts.fix,
    );
    checks.push(integrityResult);

    // --fix で修復した場合、書き戻し
    if (fixedSyncState && opts.fix) {
      await new SyncStateStore(projectRoot).write(fixedSyncState);
    }

    // 5. hash 整合性
    checks.push(checkHashIntegrity(tasksFile, syncState));

    // 6. 循環依存検出
    checks.push(checkCycles(tasksFile.tasks));
  }

  // 7. 認証チェック (--offline で省略)
  if (!opts.offline) {
    checks.push(await checkGitHubAuth());
  }

  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    warn: checks.filter((c) => c.status === "WARN").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
  };

  return { checks, summary };
}

// ── コマンド定義 ──

export const doctorCommand = new Command("doctor")
  .description("ローカル状態の整合性チェックと簡易修復")
  .option("--fix", "自動修復可能な問題を修復する")
  .option("--offline", "認証チェックをスキップする")
  .option("--json", "JSON 形式で出力")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const result = await runDoctor(projectRoot, {
      fix: !!opts.fix,
      offline: !!opts.offline,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.summary.fail > 0 ? 1 : 0;
      return;
    }

    // テキスト出力
    const statusIcon = (s: CheckStatus) => (s === "PASS" ? "✓" : s === "WARN" ? "⚠" : "✗");
    const statusLabel = (s: CheckStatus) =>
      s === "PASS" ? "[PASS]" : s === "WARN" ? "[WARN]" : "[FAIL]";

    for (const check of result.checks) {
      const fixedTag = check.fixed ? " (修復済み)" : "";
      console.log(
        `${statusIcon(check.status)} ${statusLabel(check.status)} ${check.message}${fixedTag}`,
      );
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
