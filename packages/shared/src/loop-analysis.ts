import type { Config, Task } from "./types.js";
import type { TaskReadiness } from "./project-map.js";
import { isTaskDone } from "./project-map.js";

// ---------------------------------------------------------------------------
// 外側ループの decide を支える決定論的分析 — ADR-017
//   1. ready 枯渇の 3 分類（no_ready_tasks の置き換え）
//   2. スリップ検出（期日超過 / at-risk / 完了遅延）
// ---------------------------------------------------------------------------

/** ready 枯渇の分類結果。ready 候補が存在する場合は null。 */
export type ReadyExhaustion =
  | { reason: "all_done" }
  | {
      reason: "all_blocked";
      /** ブロックまたは待ち状態の open タスクと、そのブロッカー。 */
      blocked: Array<{ taskId: string; blockingTaskIds: string[] }>;
    }
  | {
      reason: "backlog_needs_decomposition";
      /** gh-gantt-decompose による分解候補（分解可能な type の open タスク）。 */
      decomposeCandidates: string[];
    };

/** type_hierarchy 上で子を持てる（分解可能な）type か。 */
function isDecomposableType(task: Task, config: Config): boolean {
  return (config.type_hierarchy[task.type] ?? []).length > 0;
}

/**
 * 外側ループの decide が直接着手できる「作業粒度」のタスクか。
 * 子を持つコンテナ、および子がなくても分解可能な type（epic / feature 等）は
 * 実装対象ではなく分解対象なので除外する（ADR-017）。
 */
export function isWorkableTask(task: Task, config: Config): boolean {
  return task.sub_tasks.length === 0 && !isDecomposableType(task, config);
}

/**
 * ready 枯渇を 3 状態に分類する（ADR-017 Decision 3）。
 *
 * - `all_done`: open タスクが 0 → 正常終了
 * - `backlog_needs_decomposition`: 分解可能な type の open のみ残存 → decompose へ
 * - `all_blocked`: open はあるが ready 0 で全て依存・レビュー等の待ち → ブロッカー提示
 *
 * ready な作業粒度の候補（decide の候補集合と同一基準）が存在する場合は null を返す。
 */
export function classifyReadyExhaustion(
  tasks: Task[],
  config: Config,
  readinessById: Record<string, TaskReadiness>,
): ReadyExhaustion | null {
  const open = tasks.filter((t) => !(readinessById[t.id]?.isDone ?? isTaskDone(t, config)));
  if (open.length === 0) return { reason: "all_done" };

  // decide の候補集合と同じ基準（isWorkableTask）で ready を判定する
  const workable = open.filter((t) => isWorkableTask(t, config));
  if (workable.some((t) => readinessById[t.id]?.isReady === true)) return null;

  // 作業粒度の open が一つもない → バックログが粗い
  if (workable.length === 0) {
    return {
      reason: "backlog_needs_decomposition",
      decomposeCandidates: open.filter((t) => isDecomposableType(t, config)).map((t) => t.id),
    };
  }

  return {
    reason: "all_blocked",
    blocked: workable.map((t) => ({
      taskId: t.id,
      blockingTaskIds: readinessById[t.id]?.blockingTaskIds ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// スリップ検出（ADR-017 Decision 2）
// ---------------------------------------------------------------------------

/** at_risk_threshold_days 未指定時のデフォルト（UI の遅延ハイライトと同値）。 */
export const DEFAULT_AT_RISK_THRESHOLD_DAYS = 3;

export interface ScheduleSlip {
  taskId: string;
  title: string;
  /** overdue: 期日超過の open / at_risk: 期日が閾値以内の open / done_late: 期日後に完了 */
  kind: "overdue" | "at_risk" | "done_late";
  /** overdue・done_late は超過日数、at_risk は期日までの残日数。 */
  days: number;
}

/** YYYY-MM-DD 同士の日数差（a - b）。不正な日付は null。 */
function diffDays(a: string, b: string): number | null {
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((ta - tb) / 86_400_000);
}

/**
 * 予定日に対するスリップを検出する（日付の自動更新はしない — 検出と提示のみ）。
 *
 * 閾値は既存の `gantt.at_risk_threshold_days`（FR-VIS-018）を再利用する。
 * `today` は YYYY-MM-DD。呼び出し側が与えることで純粋関数に保つ。
 */
export function detectScheduleSlips(tasks: Task[], config: Config, today: string): ScheduleSlip[] {
  const threshold = config.gantt.at_risk_threshold_days ?? DEFAULT_AT_RISK_THRESHOLD_DAYS;
  const slips: ScheduleSlip[] = [];

  for (const task of tasks) {
    if (!task.end_date) continue;
    const done = isTaskDone(task, config);

    if (done) {
      // 完了済みの期日超過: 実完了日（closed_at）が end_date より後
      if (task.closed_at) {
        const late = diffDays(task.closed_at, task.end_date);
        if (late != null && late > 0) {
          slips.push({ taskId: task.id, title: task.title, kind: "done_late", days: late });
        }
      }
      continue;
    }

    const untilDue = diffDays(task.end_date, today);
    if (untilDue == null) continue;
    if (untilDue < 0) {
      slips.push({ taskId: task.id, title: task.title, kind: "overdue", days: -untilDue });
    } else if (untilDue <= threshold) {
      slips.push({ taskId: task.id, title: task.title, kind: "at_risk", days: untilDue });
    }
  }

  // 深刻な順: 期日超過（超過日数の大きい順）→ 完了遅延 → at-risk（残日数の少ない順）
  const kindOrder = { overdue: 0, done_late: 1, at_risk: 2 } as const;
  slips.sort((a, b) => {
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.kind === "at_risk" ? a.days - b.days : b.days - a.days;
  });
  return slips;
}
