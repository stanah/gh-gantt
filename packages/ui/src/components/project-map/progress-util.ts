import type { Task as SharedTask } from "@gh-gantt/shared";

/**
 * タスクの進捗値（0-100）を返す。useApi が付与する `_progress` を読み取り、
 * 未設定なら null を返す。ViewModel 由来の shared Task でも UI 由来の `_progress`
 * を保持しているため安全に参照できる。
 */
export function getTaskProgress(task: SharedTask): number | null {
  const value = (task as { _progress?: number })._progress;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}
