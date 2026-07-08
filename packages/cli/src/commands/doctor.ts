import { Command } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config, Task, SyncState, TasksFile } from "@gh-gantt/shared";
import { detectCycles, getTaskSizeExcess } from "@gh-gantt/shared";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { hashTask } from "../sync/hash.js";
import { validateSyncState, type SyncStateFinding } from "../sync/validate-sync-state.js";
import { isInProgressTask } from "../utils/status.js";

const execFileAsync = promisify(execFile);
const DEFAULT_STALE_IN_PROGRESS_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
async function checkConfig(
  projectRoot: string,
): Promise<{ result: CheckResult; data: Config | null }> {
  try {
    const data = await new ConfigStore(projectRoot).read();
    return {
      result: { name: "config-schema", status: "PASS", message: "gantt.config.json は有効です" },
      data,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        result: {
          name: "config-schema",
          status: "FAIL",
          message: "gantt.config.json が見つかりません。'gh-gantt init' を実行してください",
        },
        data: null,
      };
    }
    return {
      result: {
        name: "config-schema",
        status: "FAIL",
        message: "gantt.config.json のスキーマが不正です",
        details: [String(err instanceof Error ? err.message : err)],
      },
      data: null,
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
      continue;
    }

    // hashTask() で再計算し、snapshot.hash と比較
    const recalculated = hashTask(task);
    if (recalculated !== snapshot.hash) {
      mismatches.push(
        `${task.id}: ハッシュ不一致 (snapshot: ${snapshot.hash.slice(0, 8)}... / 再計算: ${recalculated.slice(0, 8)}...)`,
      );
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

/**
 * 宙ぶらりん参照の検出 [Issue #302]
 *
 * parent / blocked_by / sub_tasks がタスク一覧に存在しない ID を指すケースを検出する。
 * 過去の create --parent が生の "draft-1" / "293" を保存していたバグ (#302) の残骸や、
 * 手動編集による破損が対象。正規形でない参照は push の関係同期で解決できないため、
 * link コマンドでの再設定 (正規形へ解決される) を案内する。
 */
function checkDanglingReferences(tasks: Task[]): CheckResult {
  const taskIds = new Set(tasks.map((t) => t.id));
  const details: string[] = [];

  for (const task of tasks) {
    if (task.parent && !taskIds.has(task.parent)) {
      details.push(
        `${task.id}: parent "${task.parent}" がタスク一覧に存在しません。'gh-gantt link ${task.id} --set-parent <id>' で再設定してください`,
      );
    }
    for (const dep of task.blocked_by) {
      if (!taskIds.has(dep.task)) {
        details.push(
          `${task.id}: blocked_by "${dep.task}" がタスク一覧に存在しません。'gh-gantt link ${task.id} --unblock ${dep.task}' で削除するか正しい ID で再設定してください`,
        );
      }
    }
    for (const subTaskId of task.sub_tasks) {
      if (!taskIds.has(subTaskId)) {
        details.push(`${task.id}: sub_tasks "${subTaskId}" がタスク一覧に存在しません`);
      }
    }
  }

  if (details.length === 0) {
    return {
      name: "project-dangling-references",
      status: "PASS",
      message: "宙ぶらりんのタスク参照はありません",
    };
  }

  return {
    name: "project-dangling-references",
    status: "WARN",
    message: `${details.length} 件の宙ぶらりんなタスク参照があります`,
    details,
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

function checkProjectStaleState(tasks: Task[], config: Config, now = new Date()): CheckResult[] {
  return [
    checkInvalidInProgressUpdatedAt(tasks, config),
    checkStaleInProgressTasks(tasks, config, now),
    checkInProgressTasksWithoutPullRequest(tasks, config),
    checkOpenTasksWithClosedBlockers(tasks),
    checkOrphanInProgressTasks(tasks, config),
    checkOversizedTasks(tasks, config),
  ];
}

function checkStaleInProgressTasks(tasks: Task[], config: Config, now: Date): CheckResult {
  const thresholdDays = config.doctor?.stale_in_progress_days ?? DEFAULT_STALE_IN_PROGRESS_DAYS;
  const staleTasks = tasks
    .filter((task) => task.state === "open" && isInProgressTask(task, config))
    .flatMap((task) => {
      const ageDays = calculateAgeDays(task.updated_at, now);
      if (ageDays === null) return [];
      if (ageDays < thresholdDays) return [];
      return [
        `${task.id}: ${ageDays} 日更新がありません (updated_at: ${task.updated_at}, threshold: ${thresholdDays} 日)`,
      ];
    });

  if (staleTasks.length === 0) {
    return {
      name: "project-stale-in-progress",
      status: "PASS",
      message: "stale な in-progress タスクはありません",
    };
  }

  return {
    name: "project-stale-in-progress",
    status: "WARN",
    message: `${staleTasks.length} 件の stale な in-progress タスクがあります`,
    details: staleTasks,
  };
}

function checkInvalidInProgressUpdatedAt(tasks: Task[], config: Config): CheckResult {
  const invalidTasks = tasks
    .filter((task) => task.state === "open" && isInProgressTask(task, config))
    .filter((task) => calculateAgeDays(task.updated_at, new Date()) === null)
    .map((task) => `${task.id}: updated_at が不正です (${task.updated_at})`);

  if (invalidTasks.length === 0) {
    return {
      name: "project-invalid-updated-at",
      status: "PASS",
      message: "updated_at が不正な in-progress タスクはありません",
    };
  }

  return {
    name: "project-invalid-updated-at",
    status: "WARN",
    message: `${invalidTasks.length} 件の in-progress タスクで updated_at が不正です`,
    details: invalidTasks,
  };
}

function checkInProgressTasksWithoutPullRequest(tasks: Task[], config: Config): CheckResult {
  const missingPullRequests = tasks
    .filter((task) => task.state === "open" && isInProgressTask(task, config))
    .filter((task) => task.linked_prs.length === 0)
    .map((task) => `${task.id}: in-progress ですが linked PR がありません`);

  if (missingPullRequests.length === 0) {
    return {
      name: "project-in-progress-pr",
      status: "PASS",
      message: "in-progress タスクには linked PR があります",
    };
  }

  return {
    name: "project-in-progress-pr",
    status: "WARN",
    message: `${missingPullRequests.length} 件の in-progress タスクに linked PR がありません`,
    details: missingPullRequests,
  };
}

function checkOpenTasksWithClosedBlockers(tasks: Task[]): CheckResult {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const details = tasks
    .filter((task) => task.state === "open")
    .flatMap((task) =>
      task.blocked_by.flatMap((dependency) => {
        const blocker = taskMap.get(dependency.task);
        if (!blocker || blocker.state !== "closed") return [];
        return [`${task.id}: closed タスク ${blocker.id} を blocker に持っています`];
      }),
    );

  if (details.length === 0) {
    return {
      name: "project-closed-blockers",
      status: "PASS",
      message: "closed タスクを blocker に持つ open タスクはありません",
    };
  }

  return {
    name: "project-closed-blockers",
    status: "WARN",
    message: `${details.length} 件の open タスクが closed タスクを blocker に持っています`,
    details,
  };
}

function checkOrphanInProgressTasks(tasks: Task[], config: Config): CheckResult {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const details = tasks
    .filter((task) => task.state === "open" && isInProgressTask(task, config))
    .filter((task) => !hasEpicAncestorOrSelf(task, taskMap))
    .map((task) => `${task.id}: in-progress ですが Epic に属していません`);

  if (details.length === 0) {
    return {
      name: "project-orphan-in-progress",
      status: "PASS",
      message: "孤立した in-progress タスクはありません",
    };
  }

  return {
    name: "project-orphan-in-progress",
    status: "WARN",
    message: `${details.length} 件の孤立した in-progress タスクがあります`,
    details,
  };
}

function checkOversizedTasks(tasks: Task[], config: Config): CheckResult {
  if (config.max_task_size_hours === undefined) {
    return {
      name: "project-task-size",
      status: "PASS",
      message: "タスクサイズ閾値は未設定です",
    };
  }

  const details = tasks
    .filter((task) => task.state === "open")
    .flatMap((task) => {
      const excess = getTaskSizeExcess(task, config);
      if (!excess) return [];
      return [
        `${task.id}: 見積もり ${excess.estimate_hours}h が閾値 ${excess.max_task_size_hours}h を超えています。gh-gantt-decompose で分解してください`,
      ];
    });

  if (details.length === 0) {
    return {
      name: "project-task-size",
      status: "PASS",
      message: "閾値を超過した open タスクはありません",
    };
  }

  return {
    name: "project-task-size",
    status: "WARN",
    message: `${details.length} 件の task size 閾値超過があります`,
    details,
  };
}

function hasEpicAncestorOrSelf(task: Task, taskMap: Map<string, Task>): boolean {
  let current: Task | undefined = task;
  const visited = new Set<string>();

  while (current) {
    if (isEpicLikeTask(current)) return true;
    if (!current.parent) return false;
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    current = taskMap.get(current.parent);
  }

  return false;
}

function isEpicLikeTask(task: Task): boolean {
  return (
    task.type.toLowerCase() === "epic" ||
    task.labels.some((label) => label.trim().toLowerCase() === "epic")
  );
}

function calculateAgeDays(updatedAt: string, now: Date): number | null {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return null;
  return Math.max(0, Math.floor((now.getTime() - updatedMs) / MS_PER_DAY));
}

/** GitHub 認証の有効性をチェック */
async function checkGitHubAuth(): Promise<CheckResult> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 10000 });
    return { name: "github-auth", status: "PASS", message: "GitHub 認証は有効です" };
  } catch (err) {
    // gh CLI が未インストールの場合
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        name: "github-auth",
        status: "WARN",
        message: "gh CLI が見つかりません。インストールしてください",
      };
    }
    // タイムアウト
    if (
      (err as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
      (err as { killed?: boolean }).killed
    ) {
      return {
        name: "github-auth",
        status: "WARN",
        message: "gh auth status がタイムアウトしました。ネットワーク接続を確認してください",
      };
    }
    // 認証エラー
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
  const { result: configResult, data: config } = await checkConfig(projectRoot);
  checks.push(configResult);

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

    // 5. hash 整合性 (修復後の syncState があればそちらを使用)
    checks.push(checkHashIntegrity(tasksFile, fixedSyncState ?? syncState));

    // 6. 循環依存検出
    checks.push(checkCycles(tasksFile.tasks));
  }

  // 6.5. 宙ぶらりん参照検出 [Issue #302] (tasksFile のみで判定可能)
  if (tasksFile) {
    checks.push(checkDanglingReferences(tasksFile.tasks));
  }

  // 7. プロジェクトレベルの stale 検出
  if (tasksFile && config) {
    checks.push(...checkProjectStaleState(tasksFile.tasks, config));
  }

  // 8. 認証チェック (--offline で省略)
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
