import type { Config, Task } from "../types/index.js";

export function getMilestoneTypeNames(config: Config): Set<string> {
  const names = new Set<string>();
  for (const [name, def] of Object.entries(config.task_types)) {
    if (def?.display === "milestone") names.add(name);
  }
  return names;
}

export function isMilestoneTask(task: Task, config: Config): boolean {
  return config.task_types[task.type]?.display === "milestone";
}

// マイルストーンの日付は task.date を正規 due_date とし、無ければ end_date にフォールバックする。
// start_date はマイルストーンが「点」概念のため使用しない (FR-VIS-023)。
export function getMilestoneDate(task: Task): string | null {
  return task.date ?? task.end_date ?? null;
}

export interface MilestoneInfo {
  task: Task;
  date: string;
}

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
