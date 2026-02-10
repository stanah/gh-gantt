import { describe, it, expect } from "vitest";
import { hashTask } from "../sync/hash.js";
import type { Task } from "@gh-gantt/shared";

const baseTask: Task = {
  id: "owner/repo#1",
  type: "task",
  github_issue: 1,
  github_repo: "owner/repo",
  parent: null,
  sub_tasks: [],
  title: "Test task",
  body: "Some body",
  state: "open",
  state_reason: null,
  assignees: ["alice"],
  labels: ["bug"],
  milestone: null,
  linked_prs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
  custom_fields: { Status: "Todo" },
  start_date: "2026-01-01",
  end_date: "2026-01-10",
  date: null,
  blocked_by: [],
};

describe("hashTask", () => {
  it("produces the same hash for the same data", () => {
    const h1 = hashTask(baseTask);
    const h2 = hashTask(baseTask);
    expect(h1).toBe(h2);
  });

  it("produces different hash when title changes", () => {
    const modified = { ...baseTask, title: "Modified title" };
    expect(hashTask(baseTask)).not.toBe(hashTask(modified));
  });

  it("produces different hash when state changes", () => {
    const modified = { ...baseTask, state: "closed" as const };
    expect(hashTask(baseTask)).not.toBe(hashTask(modified));
  });

  it("ignores non-sync fields like created_at", () => {
    const modified = { ...baseTask, created_at: "2026-06-01T00:00:00Z" };
    expect(hashTask(baseTask)).toBe(hashTask(modified));
  });

  it("ignores linked_prs (read-only field)", () => {
    const modified = { ...baseTask, linked_prs: [42] };
    expect(hashTask(baseTask)).toBe(hashTask(modified));
  });

  it("produces different hash when type changes", () => {
    const modified = { ...baseTask, type: "epic" };
    expect(hashTask(baseTask)).not.toBe(hashTask(modified));
  });
});
