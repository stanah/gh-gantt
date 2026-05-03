import type { Config, Task } from "./types.js";

export const DEFAULT_ESTIMATE_HOURS_FIELD = "estimate_hours";

/** タスク見積もりが max_task_size_hours を超えたときの実測値と閾値を表す。 */
export interface TaskSizeExcess {
  estimate_hours: number;
  max_task_size_hours: number;
}

/**
 * config の field_mapping から estimate_hours の custom_fields キーを解決する。
 *
 * @param config estimate_hours の field mapping を含む設定。
 * @returns 設定済みのフィールド名、未設定なら既定キー estimate_hours。
 */
export function getEstimateHoursField(config: Config): string {
  return config.sync.field_mapping.estimate_hours ?? DEFAULT_ESTIMATE_HOURS_FIELD;
}

/**
 * unknown 値を 0 以上の有限な見積もり工数へ変換する。
 *
 * @param value 数値または数値文字列として解釈したい値。
 * @returns 有効な工数なら number、空文字列・負数・無限大・非数値なら null。
 */
export function parseEstimateHours(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * タスクの custom_fields から設定に対応する見積もり工数を取得する。
 *
 * @param task 見積もり工数を読む対象タスク。
 * @param config estimate_hours の field mapping を解決する設定。
 * @returns custom_fields の値が有効な工数なら number、それ以外は null。
 */
export function getTaskEstimateHours(task: Task, config: Config): number | null {
  return parseEstimateHours(task.custom_fields[getEstimateHoursField(config)]);
}

/**
 * タスクの見積もり工数が設定上の最大タスクサイズを超えているか判定する。
 *
 * @param task 判定対象のタスク。
 * @param config max_task_size_hours と estimate_hours の field mapping を含む設定。
 * @returns 閾値超過時は TaskSizeExcess、最大値未設定・見積もり未設定・閾値以下なら null。
 */
export function getTaskSizeExcess(task: Task, config: Config): TaskSizeExcess | null {
  const maxTaskSizeHours = config.max_task_size_hours;
  if (maxTaskSizeHours === undefined) return null;

  const estimateHours = getTaskEstimateHours(task, config);
  if (estimateHours === null || estimateHours <= maxTaskSizeHours) return null;

  return {
    estimate_hours: estimateHours,
    max_task_size_hours: maxTaskSizeHours,
  };
}
