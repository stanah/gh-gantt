import type { LoopIterationOutcome, LoopState } from "./loop-state.js";

// ---------------------------------------------------------------------------
// 外側ループのジャーナルメトリクス（ADR-016 案D）
// loop-state.json の記録だけから停滞・改善反復を可視化する（純粋関数・ネットワーク不要）
// ---------------------------------------------------------------------------

/** 停滞シグナルとみなす連続失敗（verify_failed / abandoned）数の閾値。 */
export const STAGNATION_FAILURE_STREAK_THRESHOLD = 2;

/** 停滞シグナルとみなす同一タスクの再選定回数の閾値。 */
export const STAGNATION_RESELECTION_THRESHOLD = 2;

/** 複数回選定されたが完了に至っていないタスク（停滞候補）。 */
export interface LoopRepeatedTask {
  taskId: string;
  /** 直近の completed 以降に選定されたイテレーション数。 */
  selections: number;
}

export interface LoopMetrics {
  /** 記録済みイテレーション総数（停止のみの記録を含む）。 */
  totalIterations: number;
  /** outcome 別の件数。outcome 未記録（進行中）のイテレーションは含まない。 */
  outcomeCounts: Partial<Record<LoopIterationOutcome, number>>;
  /**
   * 改善反復ヒストグラム: そのイテレーションで要した verify の最大 attempt 数 → 件数。
   * 例 { "1": 3, "2": 1 } は「1 回で合格 3 件、リトライ 1 回を要したもの 1 件」。
   */
  verifyAttemptHistogram: Record<number, number>;
  /** verify 失敗を経て completed に至ったイテレーション数（自己修正の成立）。 */
  recoveredCount: number;
  /** 直近から遡った連続 verify_failed / abandoned 数（進行中のイテレーションは無視）。 */
  currentFailureStreak: number;
  /**
   * 直近の completed 以降に複数回（閾値以上）選定されたが completed に至っていないタスク。
   * 選定回数の降順。完了するとカウントはリセットされ、reopen 後の再停滞も検出できる。
   */
  repeatedTasks: LoopRepeatedTask[];
}

function isFailureOutcome(outcome: LoopIterationOutcome | undefined): boolean {
  return outcome === "verify_failed" || outcome === "abandoned";
}

/** ジャーナルからループメトリクスを算出する。state 未初期化（null）は空メトリクス。 */
export function computeLoopMetrics(state: LoopState | null): LoopMetrics {
  const iterations = state?.iterations ?? [];

  const outcomeCounts: Partial<Record<LoopIterationOutcome, number>> = {};
  const verifyAttemptHistogram: Record<number, number> = {};
  let recoveredCount = 0;

  // タスクごとの「直近の completed 以降」の選定回数。完了でリセットすることで、
  // 過去に一度完了したタスクが reopen されて失敗を繰り返すケースも停滞として検出する
  const selectionsSinceCompletion = new Map<string, number>();

  for (const it of iterations) {
    if (it.outcome) {
      outcomeCounts[it.outcome] = (outcomeCounts[it.outcome] ?? 0) + 1;
    }
    if (it.verifyResults && it.verifyResults.length > 0) {
      const maxAttempt = Math.max(...it.verifyResults.map((v) => v.attempt));
      verifyAttemptHistogram[maxAttempt] = (verifyAttemptHistogram[maxAttempt] ?? 0) + 1;
      if (it.outcome === "completed" && it.verifyResults.some((v) => !v.passed)) {
        recoveredCount += 1;
      }
    }
    if (it.selectedTask !== null) {
      if (it.outcome === "completed") {
        selectionsSinceCompletion.delete(it.selectedTask);
      } else {
        selectionsSinceCompletion.set(
          it.selectedTask,
          (selectionsSinceCompletion.get(it.selectedTask) ?? 0) + 1,
        );
      }
    }
  }

  // 直近から遡る。outcome 未記録（進行中）は判定材料にせずスキップする
  let currentFailureStreak = 0;
  for (let i = iterations.length - 1; i >= 0; i--) {
    const outcome = iterations[i].outcome;
    if (outcome === undefined) continue;
    if (!isFailureOutcome(outcome)) break;
    currentFailureStreak += 1;
  }

  const repeatedTasks = [...selectionsSinceCompletion.entries()]
    .filter(([, selections]) => selections >= STAGNATION_RESELECTION_THRESHOLD)
    .map(([taskId, selections]) => ({ taskId, selections }))
    .sort((a, b) => b.selections - a.selections);

  return {
    totalIterations: iterations.length,
    outcomeCounts,
    verifyAttemptHistogram,
    recoveredCount,
    currentFailureStreak,
    repeatedTasks,
  };
}
