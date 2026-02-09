import { describe, it, expect } from "vitest";
import { calculateProgress } from "../lib/progress.js";
import type { Task, StatusValue } from "../types/index.js";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t0",
  type: "task",
  github_issue: null,
  github_repo: "o/r",
  parent: null,
  sub_tasks: [],
  title: "Test",
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "",
  updated_at: "",
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
  ...overrides,
});

describe("calculateProgress", () => {
  it("returns 100 for closed task", () => {
    expect(calculateProgress(makeTask({ state: "closed" }), [], {}, "Status")).toBe(100);
  });

  it("returns 100 for open task with done status", () => {
    const statuses: Record<string, StatusValue> = { Done: { color: "#0f0", done: true } };
    const task = makeTask({ custom_fields: { Status: "Done" } });
    expect(calculateProgress(task, [], statuses, "Status")).toBe(100);
  });

  it("returns 0 for open task without done status", () => {
    expect(calculateProgress(makeTask(), [], {}, "Status")).toBe(0);
  });

  it("calculates parent progress from children", () => {
    const t1 = makeTask({ id: "t1", state: "closed" });
    const t2 = makeTask({ id: "t2", state: "open" });
    const parent = makeTask({ sub_tasks: ["t1", "t2"] });
    expect(calculateProgress(parent, [t1, t2], {}, "Status")).toBe(50);
  });

  it("handles nested children recursively", () => {
    const grandchild1 = makeTask({ id: "gc1", state: "closed" });
    const grandchild2 = makeTask({ id: "gc2", state: "closed" });
    const child = makeTask({ id: "c1", sub_tasks: ["gc1", "gc2"] });
    const parent = makeTask({ sub_tasks: ["c1"] });
    expect(calculateProgress(parent, [child, grandchild1, grandchild2], {}, "Status")).toBe(100);
  });
});
