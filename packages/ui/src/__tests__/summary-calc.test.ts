import { describe, it, expect } from "vitest";
import { calculateSummaryDates } from "../lib/summary-calc.js";
import type { Task } from "../types/index.js";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t0", type: "task", github_issue: null, github_repo: "o/r",
  parent: null, sub_tasks: [], title: "Test", body: null,
  state: "open", state_reason: null, assignees: [], labels: [],
  milestone: null, linked_prs: [], created_at: "", updated_at: "",
  closed_at: null, custom_fields: {}, start_date: null, end_date: null,
  date: null, blocked_by: [],
  ...overrides,
});

describe("calculateSummaryDates", () => {
  it("returns min start and max end of children", () => {
    const parent = makeTask({ id: "p", sub_tasks: ["c1", "c2"] });
    const children = [
      makeTask({ id: "c1", start_date: "2026-02-01", end_date: "2026-02-15" }),
      makeTask({ id: "c2", start_date: "2026-01-15", end_date: "2026-03-01" }),
    ];
    const result = calculateSummaryDates(parent, children);
    expect(result?.start).toBe("2026-01-15");
    expect(result?.end).toBe("2026-03-01");
  });

  it("returns null when no children have dates", () => {
    const parent = makeTask({ id: "p", sub_tasks: ["c1"] });
    const children = [makeTask({ id: "c1" })];
    const result = calculateSummaryDates(parent, children);
    expect(result).toBeNull();
  });

  it("handles mixed: some children with dates, some without", () => {
    const parent = makeTask({ id: "p", sub_tasks: ["c1", "c2"] });
    const children = [
      makeTask({ id: "c1", start_date: "2026-03-01", end_date: "2026-03-10" }),
      makeTask({ id: "c2" }),
    ];
    const result = calculateSummaryDates(parent, children);
    expect(result?.start).toBe("2026-03-01");
    expect(result?.end).toBe("2026-03-10");
  });
});
