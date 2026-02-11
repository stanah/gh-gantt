import type { StatusValue } from "./types.js";

/**
 * Compute date updates triggered by a status transition.
 * - Transition to a `starts_work` status → sets `start_date` to today
 * - Transition to a `done` status → sets `end_date` to today
 * - If the resulting start_date > end_date, the other date is corrected to prevent inconsistency
 * - Same status or unrecognised status → no updates
 */
export function computeStatusDateUpdates(
  oldStatus: string | undefined,
  newStatus: string,
  statusValues: Record<string, StatusValue>,
  currentDates?: { start_date: string | null; end_date: string | null },
): { start_date?: string; end_date?: string } {
  if (oldStatus === newStatus) return {};

  const sv = statusValues[newStatus];
  if (!sv) return {};

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const updates: { start_date?: string; end_date?: string } = {};

  if (sv.starts_work) {
    updates.start_date = today;
  }
  if (sv.done) {
    updates.end_date = today;
  }

  // Correct start > end inconsistency
  if (currentDates) {
    const effectiveStart = updates.start_date ?? currentDates.start_date;
    const effectiveEnd = updates.end_date ?? currentDates.end_date;
    if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
      if (updates.start_date) {
        updates.end_date = updates.start_date;
      } else if (updates.end_date) {
        updates.start_date = updates.end_date;
      }
    }
  }

  return updates;
}
