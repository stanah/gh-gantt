import { describe, it, expect, vi, afterEach } from "vitest";
import { computeStatusDateUpdates } from "../status-dates.js";
import type { StatusValue } from "../types.js";

const statusValues: Record<string, StatusValue> = {
  "Todo": { color: "#ccc", done: false },
  "In Progress": { color: "#36f", done: false, starts_work: true },
  "In Review": { color: "#f90", done: false, starts_work: true },
  "Done": { color: "#0c0", done: true },
  "Blocked": { color: "#c00", done: false },
};

describe("computeStatusDateUpdates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns start_date when transitioning to a starts_work status", () => {
    vi.useFakeTimers({ now: new Date("2026-03-15T12:00:00Z") });
    const result = computeStatusDateUpdates("Todo", "In Progress", statusValues);
    expect(result).toEqual({ start_date: "2026-03-15" });
    vi.useRealTimers();
  });

  it("returns end_date when transitioning to a done status", () => {
    vi.useFakeTimers({ now: new Date("2026-04-20T08:30:00Z") });
    const result = computeStatusDateUpdates("In Progress", "Done", statusValues);
    expect(result).toEqual({ end_date: "2026-04-20" });
    vi.useRealTimers();
  });

  it("returns nothing when status does not change", () => {
    const result = computeStatusDateUpdates("In Progress", "In Progress", statusValues);
    expect(result).toEqual({});
  });

  it("returns nothing for a status that is neither starts_work nor done", () => {
    const result = computeStatusDateUpdates("Todo", "Blocked", statusValues);
    expect(result).toEqual({});
  });

  it("returns nothing for an unknown status", () => {
    const result = computeStatusDateUpdates("Todo", "NonExistent", statusValues);
    expect(result).toEqual({});
  });

  it("returns start_date for another starts_work status (In Review)", () => {
    vi.useFakeTimers({ now: new Date("2026-05-01T00:00:00Z") });
    const result = computeStatusDateUpdates("Todo", "In Review", statusValues);
    expect(result).toEqual({ start_date: "2026-05-01" });
    vi.useRealTimers();
  });

  it("handles oldStatus being undefined", () => {
    vi.useFakeTimers({ now: new Date("2026-06-10T15:00:00Z") });
    const result = computeStatusDateUpdates(undefined, "In Progress", statusValues);
    expect(result).toEqual({ start_date: "2026-06-10" });
    vi.useRealTimers();
  });

  // --- start > end inconsistency correction ---

  it("corrects end_date when starts_work would cause start > end", () => {
    vi.useFakeTimers({ now: new Date("2026-03-20T12:00:00Z") });
    const result = computeStatusDateUpdates("Todo", "In Progress", statusValues, {
      start_date: null,
      end_date: "2026-03-10",
    });
    expect(result).toEqual({ start_date: "2026-03-20", end_date: "2026-03-20" });
    vi.useRealTimers();
  });

  it("corrects start_date when done would cause start > end", () => {
    vi.useFakeTimers({ now: new Date("2026-02-15T12:00:00Z") });
    const result = computeStatusDateUpdates("In Progress", "Done", statusValues, {
      start_date: "2026-03-01",
      end_date: null,
    });
    expect(result).toEqual({ start_date: "2026-02-15", end_date: "2026-02-15" });
    vi.useRealTimers();
  });

  it("does not correct when no inconsistency exists", () => {
    vi.useFakeTimers({ now: new Date("2026-03-05T12:00:00Z") });
    const result = computeStatusDateUpdates("Todo", "In Progress", statusValues, {
      start_date: null,
      end_date: "2026-03-15",
    });
    expect(result).toEqual({ start_date: "2026-03-05" });
    vi.useRealTimers();
  });

  it("does not correct when currentDates is not provided", () => {
    vi.useFakeTimers({ now: new Date("2026-03-20T12:00:00Z") });
    const result = computeStatusDateUpdates("Todo", "In Progress", statusValues);
    expect(result).toEqual({ start_date: "2026-03-20" });
    vi.useRealTimers();
  });
});
