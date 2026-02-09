import type { Task } from "../types/index.js";

export function calculateSummaryDates(
  parent: Task,
  allTasks: Task[],
): { start: string; end: string } | null {
  const childIds = new Set(parent.sub_tasks);
  const children = allTasks.filter((t) => childIds.has(t.id));

  const starts: string[] = [];
  const ends: string[] = [];

  for (const child of children) {
    if (child.start_date) starts.push(child.start_date);
    if (child.end_date) ends.push(child.end_date);
  }

  if (starts.length === 0 && ends.length === 0) return null;

  const start = starts.length > 0 ? starts.sort()[0] : ends.sort()[0];
  const end = ends.length > 0 ? ends.sort().reverse()[0] : starts.sort().reverse()[0];

  return { start, end };
}
