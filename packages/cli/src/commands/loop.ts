import { Command } from "commander";
import {
  buildNextActions,
  buildProjectMapViewModel,
  classifyReadyExhaustion,
  computeStatusDateUpdates,
  createEmptyLoopState,
  detectScheduleSlips,
  getEstimateHours,
  isWorkableTask,
  resolveLoopConfig,
} from "@gh-gantt/shared";
import type {
  Config,
  LoopIteration,
  LoopIterationOutcome,
  LoopState,
  LoopStopReason,
  LoopVerifyResult,
  NextActionCategory,
  ReadyExhaustion,
  ResolvedLoopConfig,
  ScheduleSlip,
  Task,
  TasksFile,
} from "@gh-gantt/shared";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { LoopStateStore } from "../store/loop-state.js";

/** ready 候補として表示する件数。 */
const READY_CANDIDATE_LIMIT = 3;

export interface LoopReadyCandidate {
  taskId: string;
  title: string;
  score: number;
  category: NextActionCategory;
  reason: string;
}

/** decide の候補集合（ADR-017: 作業粒度 かつ ready に限定 + Next Actions スコア再利用）。 */
function selectReadyCandidates(config: Config, tasks: Task[]) {
  const vm = buildProjectMapViewModel(tasks, config);
  // ADR-017: decide が再利用するのはスコアリング関数であって候補集合ではない。
  // 作業粒度（isWorkableTask: コンテナと分解可能 type を除外）かつ ready に
  // 限定した readiness マップを渡すことで、blocked や epic の高スコア候補を排除する。
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const readyOnly = Object.fromEntries(
    Object.entries(vm.readinessById).filter(([id, r]) => {
      const task = taskById.get(id);
      return r.isReady && task !== undefined && isWorkableTask(task, config);
    }),
  );
  const readyActions = buildNextActions(tasks, config, readyOnly, READY_CANDIDATE_LIMIT);
  return { vm, readyOnly, readyActions };
}

function toCandidate(action: {
  task: Task;
  score: number;
  category: NextActionCategory;
  reason: string;
}): LoopReadyCandidate {
  return {
    taskId: action.task.id,
    title: action.task.title,
    score: action.score,
    category: action.category,
    reason: action.reason,
  };
}

/** stale とみなす同期経過時間（時間）。 */
const SYNC_STALE_THRESHOLD_HOURS = 24;

/**
 * 同期の鮮度を判定する（observe の一部）。
 * never（初回同期がまだ）の場合、ローカルの空状態を all_done と誤判定し得るため
 * loop next は選定に進まず pull を要求する。
 */
export function assessSyncFreshness(
  lastSyncedAt: string,
  now: string,
  thresholdHours: number = SYNC_STALE_THRESHOLD_HOURS,
): "never" | "stale" | "fresh" {
  if (!lastSyncedAt) return "never";
  const synced = Date.parse(lastSyncedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(synced) || !Number.isFinite(current)) return "stale";
  return current - synced > thresholdHours * 3_600_000 ? "stale" : "fresh";
}

/**
 * ローカルタイムゾーンの今日 (YYYY-MM-DD)。
 * UI の遅延判定（date-utils）とタイムゾーン基準を揃える。
 */
function localToday(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** イテレーション所要時間（時間単位・小数 1 桁）。日時が不正なら null。 */
function durationHours(startedAt: string, completedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round(((end - start) / 3_600_000) * 10) / 10;
}

// ---------------------------------------------------------------------------
// loop status
// ---------------------------------------------------------------------------

export interface LoopStatusReport {
  /** loop-state.json が存在するか。 */
  initialized: boolean;
  iterationCount: number;
  lastIteration: LoopIteration | null;
  /** 直近の完了イテレーションの予実（ADR-017）。 */
  lastActual: {
    iterationId: number;
    taskId: string | null;
    durationHours: number | null;
    estimateHours: number | null;
  } | null;
  stop: ResolvedLoopConfig;
  /** tasks.json に未解決コンフリクトがあるか（conflicts_present 相当）。 */
  hasConflicts: boolean;
  /** スリップ検出結果（期日超過 / at-risk / 完了遅延）。 */
  slips: ScheduleSlip[];
  /** ready 枯渇の分類（ready 候補がある場合は null）。 */
  exhaustion: ReadyExhaustion | null;
  readyCount: number;
  /**
   * 次の着手候補。ADR-017 に従い、候補集合を作業粒度かつ ready に限定した上で
   * Next Actions のスコアリングを適用した順で並ぶ。
   * コンフリクト検出中は HARD-GATE（解決まで他作業禁止）に従い空になる。
   */
  readyCandidates: LoopReadyCandidate[];
}

/** ループの現在地レポートを組み立てる（純粋関数・ネットワーク不要）。 */
export function buildLoopStatusReport(
  state: LoopState | null,
  config: Config,
  tasks: Task[],
  hasConflicts = false,
  today: string = localToday(),
): LoopStatusReport {
  const { vm, readyOnly, readyActions } = selectReadyCandidates(config, tasks);

  const iterations = state?.iterations ?? [];
  const lastCompleted = [...iterations]
    .reverse()
    .find((it) => it.completedAt !== undefined && it.selectedTask !== null);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const lastActual = lastCompleted
    ? {
        iterationId: lastCompleted.id,
        taskId: lastCompleted.selectedTask,
        durationHours: durationHours(lastCompleted.startedAt, lastCompleted.completedAt!),
        estimateHours: lastCompleted.selectedTask
          ? (() => {
              const task = taskById.get(lastCompleted.selectedTask);
              return task ? getEstimateHours(task, config) : null;
            })()
          : null,
      }
    : null;

  return {
    initialized: state !== null,
    iterationCount: iterations.length,
    lastIteration: iterations.length > 0 ? iterations[iterations.length - 1] : null,
    lastActual,
    stop: resolveLoopConfig(config.loop),
    hasConflicts,
    slips: detectScheduleSlips(tasks, config, today),
    exhaustion: classifyReadyExhaustion(tasks, config, vm.readinessById),
    readyCount: Object.keys(readyOnly).length,
    // コンフリクト解決が最優先（HARD-GATE）。解決まで次の着手候補は提示しない。
    readyCandidates: hasConflicts ? [] : readyActions.map(toCandidate),
  };
}

/** レポートを人間向けテキストに整形する。 */
export function formatLoopStatus(report: LoopStatusReport): string {
  const lines: string[] = [];

  if (!report.initialized) {
    lines.push("Loop state: 未初期化 (.gantt-sync/loop-state.json がありません)");
    lines.push("  外側ループのジャーナルは gh-gantt loop コマンドが作成・管理します。");
  } else if (report.lastIteration) {
    const it = report.lastIteration;
    lines.push(`Iterations: ${report.iterationCount}`);
    lines.push(`Last iteration: #${it.id} ${it.selectedTask ?? "(タスク選定なし)"}`);
    lines.push(`  decision: ${it.decision}`);
    const span = it.completedAt ? `${it.startedAt} -> ${it.completedAt}` : `${it.startedAt} ->`;
    lines.push(`  outcome: ${it.outcome ?? "(未記録)"} (${span})`);
    if (it.stopReason) lines.push(`  stopReason: ${it.stopReason}`);
    if (report.lastActual?.durationHours != null) {
      const est =
        report.lastActual.estimateHours != null ? `${report.lastActual.estimateHours}h` : "未設定";
      lines.push(
        `  actual: #${report.lastActual.iterationId} 所要 ${report.lastActual.durationHours}h / 見積 ${est}`,
      );
    }
  } else {
    lines.push("Iterations: 0 (ジャーナルは初期化済み)");
  }

  lines.push("");
  const max = report.stop.maxIterations === null ? "unlimited" : String(report.stop.maxIterations);
  lines.push(`Stop conditions: ${report.stop.stopWhen.join(", ")}`);
  lines.push(`  maxIterations: ${max} / onVerifyFailure: ${report.stop.onVerifyFailure}`);

  if (report.slips.length > 0) {
    lines.push("");
    lines.push(`Schedule slips (${report.slips.length}):`);
    for (const slip of report.slips) {
      const label =
        slip.kind === "overdue"
          ? `期日超過 ${slip.days}日`
          : slip.kind === "done_late"
            ? `完了遅延 ${slip.days}日`
            : `期日まで ${slip.days}日`;
      lines.push(`  ! [${slip.kind}] ${slip.taskId}: ${slip.title} (${label})`);
    }
    lines.push("  日付の変更は行いません。再計画する場合は gh-gantt update を使ってください。");
  }

  lines.push("");
  if (report.hasConflicts) {
    lines.push("!! Conflicts detected (conflicts_present)");
    lines.push(
      "   未解決コンフリクトがあります。gh-gantt conflicts / resolve で解決するまで次の着手候補は提示しません。",
    );
    return lines.join("\n");
  }
  lines.push(`Ready tasks: ${report.readyCount}`);
  if (report.readyCandidates.length > 0) {
    lines.push("Next candidates (作業粒度の ready のみ, Next Actions スコア順):");
    report.readyCandidates.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c.taskId}: ${c.title}`);
      lines.push(`     score=${c.score} [${c.category}] ${c.reason}`);
    });
  } else if (report.exhaustion) {
    lines.push(`Next candidates: なし (${report.exhaustion.reason})`);
    if (report.exhaustion.reason === "all_blocked") {
      for (const b of report.exhaustion.blocked) {
        lines.push(`  - ${b.taskId} <- blocked by: ${b.blockingTaskIds.join(", ") || "(待ち)"}`);
      }
    } else if (report.exhaustion.reason === "backlog_needs_decomposition") {
      lines.push(`  分解候補: ${report.exhaustion.decomposeCandidates.join(", ")}`);
      lines.push("  gh-gantt-decompose で作業粒度のタスクに分解してください。");
    }
  } else {
    lines.push("Next candidates: なし (ready なタスクがありません)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// loop next — 1 イテレーション分の observe + decide（ADR-016 案A / ADR-017）
// ---------------------------------------------------------------------------

export type LoopNextResult =
  | { kind: "sync_required" }
  | { kind: "open_iteration"; openIterationId: number }
  | {
      kind: "stopped";
      stopReason: LoopStopReason;
      exhaustion: ReadyExhaustion | null;
      /** 追記すべきイテレーション。直前と同一理由の停止なら null（重複記録を避ける）。 */
      iteration: LoopIteration | null;
    }
  | { kind: "selected"; iteration: LoopIteration; alternatives: LoopReadyCandidate[] };

function nextIterationId(state: LoopState): number {
  return state.iterations.reduce((max, it) => Math.max(max, it.id), 0) + 1;
}

/**
 * 次イテレーションを決定論的に決める（純粋関数）。
 *
 * 優先順位: 未完了イテレーションの拒否 → conflicts_present → budget_exhausted
 * → ready 枯渇 3 分類 → 選定（作業粒度の ready を Next Actions スコア順）。
 * 停止条件の検出は Config.loop.stopWhen に依らず常に行う（選定不能な状況で
 * 選定を続けることはできないため）。stopWhen は自律ループ側の終了判断に使う。
 */
export function decideNextIteration(params: {
  state: LoopState;
  config: Config;
  tasks: Task[];
  hasConflicts: boolean;
  now: string;
  /** sync-state の last_synced_at。空（未同期）なら選定せず pull を要求する。 */
  lastSyncedAt?: string;
  decision?: string;
}): LoopNextResult {
  const { state, config, tasks, hasConflicts, now, lastSyncedAt, decision } = params;

  // 一度も同期していないローカル状態は空であり、all_done と誤判定し得る
  if (lastSyncedAt !== undefined && assessSyncFreshness(lastSyncedAt, now) === "never") {
    return { kind: "sync_required" };
  }

  const last = state.iterations.length > 0 ? state.iterations[state.iterations.length - 1] : null;
  if (last && last.selectedTask !== null && last.completedAt === undefined && !last.outcome) {
    return { kind: "open_iteration", openIterationId: last.id };
  }

  const stopWith = (
    stopReason: LoopStopReason,
    exhaustion: ReadyExhaustion | null,
  ): LoopNextResult => {
    // 直前も同一理由の停止なら追記しない（連続実行でジャーナルが膨らむのを防ぐ）
    if (last?.outcome === "stopped" && last.stopReason === stopReason) {
      return { kind: "stopped", stopReason, exhaustion, iteration: null };
    }
    return {
      kind: "stopped",
      stopReason,
      exhaustion,
      iteration: {
        id: nextIterationId(state),
        startedAt: now,
        selectedTask: null,
        decision: `停止条件 ${stopReason} を検出`,
        outcome: "stopped",
        stopReason,
      },
    };
  };

  if (hasConflicts) return stopWith("conflicts_present", null);

  const resolved = resolveLoopConfig(config.loop);
  if (resolved.maxIterations !== null) {
    const consumed = state.iterations.filter((it) => it.selectedTask !== null).length;
    if (consumed >= resolved.maxIterations) return stopWith("budget_exhausted", null);
  }

  const { vm, readyActions } = selectReadyCandidates(config, tasks);
  const exhaustion = classifyReadyExhaustion(tasks, config, vm.readinessById);
  if (exhaustion) return stopWith(exhaustion.reason, exhaustion);

  const top = readyActions[0];
  const iteration: LoopIteration = {
    id: nextIterationId(state),
    startedAt: now,
    selectedTask: top.task.id,
    selection: {
      taskId: top.task.id,
      score: top.score,
      category: top.category,
      reason: top.reason,
    },
    decision: decision ?? `${top.task.title} (${top.task.id}) に着手する`,
  };
  return { kind: "selected", iteration, alternatives: readyActions.slice(1).map(toCandidate) };
}

export function formatLoopNext(result: LoopNextResult): string {
  if (result.kind === "sync_required") {
    return [
      "初回同期がまだです（sync-state が空）。",
      "gh-gantt pull を実行してから loop next を再実行してください。",
    ].join("\n");
  }
  if (result.kind === "open_iteration") {
    return [
      `イテレーション #${result.openIterationId} が未完了です。`,
      "gh-gantt loop complete で閉じてから次のイテレーションを開始してください。",
    ].join("\n");
  }
  if (result.kind === "stopped") {
    const lines = [`Stopped: ${result.stopReason}`];
    if (result.stopReason === "conflicts_present") {
      lines.push("  gh-gantt conflicts / resolve でコンフリクトを解決してください。");
    } else if (result.exhaustion?.reason === "all_blocked") {
      for (const b of result.exhaustion.blocked) {
        lines.push(`  - ${b.taskId} <- blocked by: ${b.blockingTaskIds.join(", ") || "(待ち)"}`);
      }
    } else if (result.exhaustion?.reason === "backlog_needs_decomposition") {
      lines.push(`  分解候補: ${result.exhaustion.decomposeCandidates.join(", ")}`);
      lines.push("  gh-gantt-decompose で作業粒度のタスクに分解してください。");
    } else if (result.stopReason === "all_done") {
      lines.push("  open タスクはありません。おつかれさまでした。");
    } else if (result.stopReason === "budget_exhausted") {
      lines.push(
        "  maxIterations に達しました。継続する場合は config の loop.maxIterations を見直してください。",
      );
    }
    if (result.iteration === null) {
      lines.push("  (直前と同一理由のためジャーナルには追記していません)");
    }
    return lines.join("\n");
  }
  const it = result.iteration;
  const lines = [
    `Iteration #${it.id} を開始しました`,
    `  selected: ${it.selectedTask}`,
    `  reason: score=${it.selection?.score} [${it.selection?.category}] ${it.selection?.reason}`,
    `  decision: ${it.decision}`,
  ];
  if (result.alternatives.length > 0) {
    lines.push("  alternatives:");
    for (const alt of result.alternatives) {
      lines.push(`    - ${alt.taskId}: ${alt.title} (score=${alt.score})`);
    }
  }
  lines.push("完了したら gh-gantt loop complete で実績を記録してください。");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// loop complete — 実績（予実）の記録（ADR-017）
// ---------------------------------------------------------------------------

const COMPLETE_OUTCOMES = ["completed", "verify_failed", "abandoned"] as const;

export type LoopCompleteResult =
  | { kind: "no_open_iteration" }
  | {
      kind: "completed";
      iteration: LoopIteration;
      durationHours: number | null;
      estimateHours: number | null;
    };

/** `--verify "<command>=pass|fail"` の繰り返し指定をパースする。attempt は指定順で採番。 */
export function parseVerifySpecs(specs: string[]): LoopVerifyResult[] {
  const attempts = new Map<string, number>();
  return specs.map((spec) => {
    const match = spec.match(/^(.+)=(pass|fail)$/);
    if (!match) {
      throw new UsageError(`--verify の形式が不正です: "${spec}" ("<command>=pass|fail" で指定)`);
    }
    const command = match[1];
    const attempt = (attempts.get(command) ?? 0) + 1;
    attempts.set(command, attempt);
    return { command, passed: match[2] === "pass", attempt };
  });
}

/**
 * タスクの status をローカルで更新する（tasksFile を直接更新する）。
 * status 遷移に伴う start/end date の自動更新（computeStatusDateUpdates）も適用する。
 * GitHub への反映は gh-gantt push が担う（sync 規律に従う）。
 */
export function applyTaskStatus(
  tasksFile: TasksFile,
  taskId: string,
  status: string,
  config: Config,
): Task {
  if (!config.statuses.values[status]) {
    throw new UsageError(
      `不明な status です: "${status}"。利用可能: ${Object.keys(config.statuses.values).join(", ")}`,
    );
  }
  const task = tasksFile.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new UsageError(`タスク ${taskId} が tasks.json に見つかりません`);
  }
  const statusField = config.statuses.field_name;
  const oldStatus = task.custom_fields[statusField] as string | undefined;
  task.custom_fields = { ...task.custom_fields, [statusField]: status };
  const dateUpdates = computeStatusDateUpdates(oldStatus, status, config.statuses.values, {
    start_date: task.start_date,
    end_date: task.end_date,
  });
  if (dateUpdates.start_date) task.start_date = dateUpdates.start_date;
  if (dateUpdates.end_date) task.end_date = dateUpdates.end_date;
  return task;
}

/**
 * 直近の開いたイテレーションに実績を記録する（state を直接更新する）。
 */
export function completeIteration(params: {
  state: LoopState;
  config: Config;
  tasks: Task[];
  now: string;
  outcome: LoopIterationOutcome;
  reviewOutcome?: string;
  verify?: LoopVerifyResult[];
}): LoopCompleteResult {
  const { state, config, tasks, now, outcome, reviewOutcome, verify } = params;
  const it = [...state.iterations]
    .reverse()
    .find((i) => i.selectedTask !== null && i.completedAt === undefined && !i.outcome);
  if (!it) return { kind: "no_open_iteration" };

  it.completedAt = now;
  it.outcome = outcome;
  if (reviewOutcome !== undefined) it.reviewOutcome = reviewOutcome;
  if (verify && verify.length > 0) it.verifyResults = verify;

  const task = tasks.find((t) => t.id === it.selectedTask);
  return {
    kind: "completed",
    iteration: it,
    durationHours: durationHours(it.startedAt, now),
    estimateHours: task ? getEstimateHours(task, config) : null,
  };
}

export function formatLoopComplete(result: LoopCompleteResult): string {
  if (result.kind === "no_open_iteration") {
    return "開いているイテレーションがありません。gh-gantt loop next で開始してください。";
  }
  const it = result.iteration;
  const lines = [
    `Iteration #${it.id} を記録しました (${it.outcome})`,
    `  task: ${it.selectedTask}`,
  ];
  const est = result.estimateHours != null ? `${result.estimateHours}h` : "未設定";
  if (result.durationHours != null) {
    lines.push(`  actual: 所要 ${result.durationHours}h / 見積 ${est}`);
  }
  if (it.verifyResults && it.verifyResults.length > 0) {
    const failed = it.verifyResults.filter((v) => !v.passed).length;
    lines.push(`  verify: ${it.verifyResults.length} 回実行 (失敗 ${failed} 回)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// commander 配線
// ---------------------------------------------------------------------------

/** ユーザー入力の誤りを示すエラー。データ破損の示唆を出さずに使い方を案内する。 */
class UsageError extends Error {}

function reportCommandError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${context} の実行に失敗しました: ${message}`);
  if (!(err instanceof UsageError)) {
    console.error(
      "  .gantt-sync/ の設定・同期データ、または loop-state.json が破損している可能性があります。",
    );
  }
  process.exitCode = 1;
}

async function loadStores(projectRoot: string) {
  const config = await new ConfigStore(projectRoot).read();
  const tasksStore = new TasksStore(projectRoot);
  // 新品クローン等で tasks.json 不在でも例外にせず空状態で開始する。
  // last_synced_at が空のままなので loop next は sync_required で pull を要求する
  const tasksFile = await tasksStore.readOrDefault();
  const syncState = await new SyncStateStore(projectRoot).readOrDefault();
  const loopStore = new LoopStateStore(projectRoot);
  const state = await loopStore.readOrNull();
  return { config, tasksStore, tasksFile, syncState, loopStore, state };
}

export const loopCommand = new Command("loop")
  .description("Outer-loop journal and status (ADR-016 / ADR-017)")
  .addCommand(
    new Command("status")
      .description(
        "Show outer-loop status: last iteration, stop conditions, slips, ready candidates",
      )
      .option("--json", "Output as JSON")
      .action(async (opts: { json?: boolean }) => {
        try {
          const { config, tasksFile, state } = await loadStores(process.cwd());
          const report = buildLoopStatusReport(
            state,
            config,
            tasksFile.tasks,
            tasksFile.has_conflicts === true,
          );
          console.log(opts.json ? JSON.stringify(report, null, 2) : formatLoopStatus(report));
        } catch (err) {
          reportCommandError("loop status", err);
        }
      }),
  )
  .addCommand(
    new Command("next")
      .description("Decide the next iteration: pick a ready task or record a stop reason")
      .option("--json", "Output as JSON")
      .option("--decision <text>", "このイテレーションでやることの要約を上書きする")
      .action(async (opts: { json?: boolean; decision?: string }) => {
        try {
          const { config, tasksFile, syncState, loopStore, state } = await loadStores(
            process.cwd(),
          );
          const now = new Date().toISOString();
          // observe: 同期の鮮度確認（stale なら警告して続行、never は選定を拒否）
          if (assessSyncFreshness(syncState.last_synced_at, now) === "stale") {
            console.warn(
              `⚠ 最終同期から ${SYNC_STALE_THRESHOLD_HOURS} 時間を超えて経過しています。gh-gantt pull の実行を推奨します。`,
            );
          }
          const current = state ?? createEmptyLoopState();
          const result = decideNextIteration({
            state: current,
            config,
            tasks: tasksFile.tasks,
            hasConflicts: tasksFile.has_conflicts === true,
            now,
            lastSyncedAt: syncState.last_synced_at,
            decision: opts.decision,
          });

          if (result.kind === "selected") {
            current.iterations.push(result.iteration);
            await loopStore.write(current);
          } else if (result.kind === "stopped" && result.iteration) {
            current.iterations.push(result.iteration);
            await loopStore.write(current);
          }

          console.log(opts.json ? JSON.stringify(result, null, 2) : formatLoopNext(result));
          if (result.kind === "open_iteration" || result.kind === "sync_required") {
            process.exitCode = 1;
          }
        } catch (err) {
          reportCommandError("loop next", err);
        }
      }),
  )
  .addCommand(
    new Command("complete")
      .description("Record actuals for the open iteration (completedAt, outcome, verify results)")
      .option("--json", "Output as JSON")
      .option(
        "--outcome <outcome>",
        `イテレーションの結末 (${COMPLETE_OUTCOMES.join(" | ")})`,
        "completed",
      )
      .option("--review <text>", "レビュー結果の要約")
      .option(
        "--task-status <status>",
        "選定タスクの status をローカル更新する（GitHub への反映は gh-gantt push）",
      )
      .option(
        "--verify <spec>",
        '検証結果 "<command>=pass|fail"（繰り返し指定可、attempt は指定順で採番）',
        (value: string, previous: string[]) => [...previous, value],
        [] as string[],
      )
      .action(
        async (opts: {
          json?: boolean;
          outcome: string;
          review?: string;
          taskStatus?: string;
          verify: string[];
        }) => {
          try {
            if (!(COMPLETE_OUTCOMES as readonly string[]).includes(opts.outcome)) {
              throw new UsageError(
                `--outcome は ${COMPLETE_OUTCOMES.join(" | ")} のいずれかで指定してください`,
              );
            }
            const { config, tasksStore, tasksFile, loopStore, state } = await loadStores(
              process.cwd(),
            );
            // state 未初期化でも --json の出力形式は state ありの場合と揃える
            const result: LoopCompleteResult = state
              ? completeIteration({
                  state,
                  config,
                  tasks: tasksFile.tasks,
                  now: new Date().toISOString(),
                  outcome: opts.outcome as LoopIterationOutcome,
                  reviewOutcome: opts.review,
                  verify: parseVerifySpecs(opts.verify),
                })
              : { kind: "no_open_iteration" };
            if (result.kind === "completed" && state) {
              await loopStore.write(state);
              // journal 記録と status 更新を 1 コマンドにまとめる（ADR-016 案A）。
              // 各ファイルは個別に atomic write されるが 2 ファイル間はトランザクションではなく、
              // 万一 tasks.json 側が失敗しても journal は残る（再実行で status のみ再適用可能）
              if (opts.taskStatus && result.iteration.selectedTask) {
                applyTaskStatus(tasksFile, result.iteration.selectedTask, opts.taskStatus, config);
                await tasksStore.write(tasksFile);
              }
            } else {
              process.exitCode = 1;
            }
            console.log(opts.json ? JSON.stringify(result, null, 2) : formatLoopComplete(result));
            if (result.kind === "completed" && opts.taskStatus) {
              console.log(
                `task status を "${opts.taskStatus}" に更新しました。gh-gantt push で GitHub に反映してください。`,
              );
            }
          } catch (err) {
            reportCommandError("loop complete", err);
          }
        },
      ),
  );
