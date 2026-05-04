import { useCallback, useState } from "react";
import type { CalendarHoliday } from "../types/index.js";

export const CUSTOM_NON_WORKING_DAYS_STORAGE_KEY = "gh-gantt:custom-non-working-days";

function isHolidayLike(value: unknown): value is CalendarHoliday {
  if (typeof value !== "object" || value == null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
    (record.name == null || typeof record.name === "string")
  );
}

function normalizeDays(days: readonly CalendarHoliday[]): CalendarHoliday[] {
  const byDate = new Map<string, CalendarHoliday>();
  for (const day of days) {
    const date = day.date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const name = day.name?.trim();
    byDate.set(date, name ? { date, name } : { date });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function readStoredDays(): CalendarHoliday[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(CUSTOM_NON_WORKING_DAYS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeDays(parsed.filter(isHolidayLike));
  } catch {
    return [];
  }
}

function writeStoredDays(days: readonly CalendarHoliday[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CUSTOM_NON_WORKING_DAYS_STORAGE_KEY, JSON.stringify(days));
}

export function useCustomNonWorkingDays() {
  const [customDaysOff, setCustomDaysOff] = useState<CalendarHoliday[]>(() => readStoredDays());

  const update = useCallback((buildNextDays: (prev: CalendarHoliday[]) => CalendarHoliday[]) => {
    setCustomDaysOff((prev) => {
      const normalized = normalizeDays(buildNextDays(prev));
      writeStoredDays(normalized);
      return normalized;
    });
  }, []);

  const addCustomDayOff = useCallback(
    (day: CalendarHoliday) => {
      update((prev) => [...prev, day]);
    },
    [update],
  );

  const removeCustomDayOff = useCallback(
    (date: string) => {
      update((prev) => prev.filter((day) => day.date !== date));
    },
    [update],
  );

  return { customDaysOff, addCustomDayOff, removeCustomDayOff };
}
