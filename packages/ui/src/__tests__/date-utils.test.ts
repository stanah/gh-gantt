import { describe, it, expect } from "vitest";
import { isWorkingDay, addWorkingDays, parseDate, getDateRange } from "../lib/date-utils.js";

describe("isWorkingDay", () => {
  it("returns true for Monday (day 1)", () => {
    // 2026-01-05 is Monday
    expect(isWorkingDay(new Date(2026, 0, 5), [1, 2, 3, 4, 5])).toBe(true);
  });

  it("returns false for Saturday (day 6)", () => {
    // 2026-01-03 is Saturday
    expect(isWorkingDay(new Date(2026, 0, 3), [1, 2, 3, 4, 5])).toBe(false);
  });

  it("returns false for Sunday (day 0)", () => {
    // 2026-01-04 is Sunday
    expect(isWorkingDay(new Date(2026, 0, 4), [1, 2, 3, 4, 5])).toBe(false);
  });
});

describe("addWorkingDays", () => {
  it("adds working days skipping weekends", () => {
    // 2026-01-05 is Monday, add 5 working days → 2026-01-12 (next Monday)
    const result = addWorkingDays(new Date(2026, 0, 5), 5, [1, 2, 3, 4, 5]);
    expect(result.getDate()).toBe(12);
  });
});

describe("parseDate", () => {
  it("parses YYYY-MM-DD format", () => {
    const d = parseDate("2026-03-15");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // 0-indexed
    expect(d.getDate()).toBe(15);
  });

  it("parses ISO timestamp by extracting date portion", () => {
    const d = parseDate("2026-05-31T00:00:00Z");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // 0-indexed
    expect(d.getDate()).toBe(31);
  });
});

describe("getDateRange", () => {
  it("returns padded min/max dates from tasks", () => {
    const tasks = [
      { start_date: "2026-01-01", end_date: "2026-01-10" },
      { start_date: "2026-02-01", end_date: "2026-03-15" },
      { start_date: null, end_date: null },
    ] as any[];
    const [min, max] = getDateRange(tasks);
    // Min is aligned to month start, max extends past the last date
    expect(min <= new Date(2026, 0, 1)).toBe(true);
    expect(max > new Date(2026, 2, 15)).toBe(true);
  });

  it("returns default range when no dates", () => {
    const [min, max] = getDateRange([]);
    expect(max > min).toBe(true);
  });

  it("includes task.date in the range calculation", () => {
    const tasks = [
      { start_date: "2026-01-01", end_date: "2026-01-10", date: null },
      { start_date: null, end_date: null, date: "2026-06-15" },
    ] as any[];
    const [min, max] = getDateRange(tasks);
    expect(max > new Date(2026, 5, 15)).toBe(true);
  });
});
