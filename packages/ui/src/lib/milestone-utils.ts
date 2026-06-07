import type { Config, Task } from "../types/index.js";

/**
 * 設定からマイルストーン扱いとする task type 名の集合を返す。
 *
 * `task_types[*].display === "milestone"` の type を抽出する。
 *
 * @param config - gantt 設定
 * @returns マイルストーン扱いの type 名の集合
 */
export function getMilestoneTypeNames(config: Config): Set<string> {
  const names = new Set<string>();
  for (const [name, def] of Object.entries(config.task_types)) {
    if (def?.display === "milestone") names.add(name);
  }
  return names;
}

/**
 * 指定タスクがマイルストーン（`display === "milestone"`）かどうかを判定する。
 *
 * @param task - 判定対象のタスク
 * @param config - gantt 設定
 * @returns マイルストーンなら true
 */
export function isMilestoneTask(task: Task, config: Config): boolean {
  return config.task_types[task.type]?.display === "milestone";
}

/**
 * マイルストーンのレーン上配置に使う日付を返す。
 *
 * `task.date` を正規の期日とし、無ければ `end_date` にフォールバックする。
 * マイルストーンは「点」概念のため `start_date` は使用しない (FR-VIS-023)。
 *
 * @param task - 対象のマイルストーンタスク
 * @returns 配置基準となる日付文字列。いずれも未設定なら null
 */
export function getMilestoneDate(task: Task): string | null {
  return task.date ?? task.end_date ?? null;
}

/**
 * 専用レーンに描画する 1 マイルストーン分の情報。
 */
export interface MilestoneInfo {
  /** 対象のマイルストーンタスク */
  task: Task;
  /** レーン上の配置基準となる日付文字列（{@link getMilestoneDate} で解決済み） */
  date: string;
}

/**
 * タスク配列からマイルストーンを抽出し、日付昇順でソートして返す。
 *
 * `display === "milestone"` の type のみを対象とし、配置基準の日付
 * （{@link getMilestoneDate}）が無いものは除外する。
 *
 * @param tasks - 全タスク
 * @param config - gantt 設定
 * @returns 日付昇順にソートされたマイルストーン情報の配列
 */
export function extractMilestones(tasks: Task[], config: Config): MilestoneInfo[] {
  const milestoneTypes = getMilestoneTypeNames(config);
  const result: MilestoneInfo[] = [];
  for (const task of tasks) {
    if (!milestoneTypes.has(task.type)) continue;
    const date = getMilestoneDate(task);
    if (date) result.push({ task, date });
  }
  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}
