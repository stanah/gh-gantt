import type { Task } from "../types/index.js";

export function isWorkingDay(date: Date, workingDays: number[]): boolean {
  return workingDays.includes(date.getDay());
}

export function addWorkingDays(start: Date, days: number, workingDays: number[]): Date {
  const result = new Date(start);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (isWorkingDay(result, workingDays)) {
      added++;
    }
  }
  return result;
}

export function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function getDateRange(tasks: Task[]): [Date, Date] {
  const dates: Date[] = [];
  for (const task of tasks) {
    if (task.start_date) dates.push(parseDate(task.start_date));
    if (task.end_date) dates.push(parseDate(task.end_date));
  }

  if (dates.length === 0) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 3, 0);
    return [start, end];
  }

  const timestamps = dates.map((d) => d.getTime());
  const minDate = new Date(Math.min(...timestamps));
  const maxDate = new Date(Math.max(...timestamps));

  // Add padding
  minDate.setDate(minDate.getDate() - 7);
  maxDate.setDate(maxDate.getDate() + 7);

  return [minDate, maxDate];
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
