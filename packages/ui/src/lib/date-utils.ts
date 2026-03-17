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
  const [year, month, day] = dateStr.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function getDaysUntilDue(task: Task, today: Date = new Date()): number | null {
  if (!task.end_date) return null;
  const due = parseDate(task.end_date);
  const diffMs = startOfDay(due).getTime() - startOfDay(today).getTime();
  return Math.floor(diffMs / ONE_DAY_MS);
}

export function isOverdue(task: Task, today: Date = new Date()): boolean {
  if (task.state === "closed") return false;
  const daysUntilDue = getDaysUntilDue(task, today);
  if (daysUntilDue == null) return false;
  return daysUntilDue < 0;
}

export function getOverdueDays(task: Task, today: Date = new Date()): number {
  const daysUntilDue = getDaysUntilDue(task, today);
  if (daysUntilDue == null || daysUntilDue >= 0) return 0;
  return Math.abs(daysUntilDue);
}

export function isAtRisk(task: Task, thresholdDays: number, today: Date = new Date()): boolean {
  if (task.state === "closed") return false;
  const daysUntilDue = getDaysUntilDue(task, today);
  if (daysUntilDue == null) return false;
  if (daysUntilDue < 0) return false;
  return daysUntilDue <= Math.max(0, thresholdDays);
}

export function getDateRange(tasks: Task[]): [Date, Date] {
  const dates: Date[] = [];
  for (const task of tasks) {
    if (task.start_date) dates.push(parseDate(task.start_date));
    if (task.end_date) dates.push(parseDate(task.end_date));
    if (task.date) dates.push(parseDate(task.date));
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

  // Add padding: align to month boundaries for cleaner timeline display
  minDate.setDate(1);
  maxDate.setMonth(maxDate.getMonth() + 1, 7);

  return [minDate, maxDate];
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
