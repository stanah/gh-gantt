import { describe, it, expect } from "vitest";
import { calcDurationDays, formatDateLabel } from "../components/GanttTooltip.js";

describe("calcDurationDays", () => {
  it("returns 1 for same-day range", () => {
    expect(calcDurationDays("2026-03-01", "2026-03-01")).toBe(1);
  });

  it("returns correct duration for multi-day range", () => {
    expect(calcDurationDays("2026-03-01", "2026-03-10")).toBe(10);
  });

  it("handles month boundary", () => {
    expect(calcDurationDays("2026-01-30", "2026-02-02")).toBe(4);
  });

  it("handles DST boundary (spring forward)", () => {
    // US DST spring forward: 2026-03-08
    expect(calcDurationDays("2026-03-07", "2026-03-09")).toBe(3);
  });

  it("handles DST boundary (fall back)", () => {
    // US DST fall back: 2026-11-01
    expect(calcDurationDays("2026-10-31", "2026-11-02")).toBe(3);
  });
});

describe("formatDateLabel", () => {
  it("formats date as YYYY/MM/DD with zero-padded months and days", () => {
    expect(formatDateLabel("2026-03-05")).toBe("2026/03/05");
  });

  it("pads single-digit month and day", () => {
    expect(formatDateLabel("2026-01-09")).toBe("2026/01/09");
  });

  it("does not pad double-digit month and day", () => {
    expect(formatDateLabel("2026-12-25")).toBe("2026/12/25");
  });
});
