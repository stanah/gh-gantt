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

  it("produces same hash regardless of custom_fields key order", () => {
    const task1 = { ...baseTask, custom_fields: { Status: "Todo", Priority: "High", Sprint: "1" } };
    const task2 = { ...baseTask, custom_fields: { Sprint: "1", Status: "Todo", Priority: "High" } };
    expect(hashTask(task1)).toBe(hashTask(task2));
  });

  it("produces same hash regardless of blocked_by order", () => {
    const task1 = {
      ...baseTask,
      blocked_by: [
        { task: "owner/repo#2", type: "finish-to-start" as const, lag: 0 },
        { task: "owner/repo#3", type: "finish-to-start" as const, lag: 0 },
      ],
    };
    const task2 = {
      ...baseTask,
      blocked_by: [
        { task: "owner/repo#3", type: "finish-to-start" as const, lag: 0 },
        { task: "owner/repo#2", type: "finish-to-start" as const, lag: 0 },
      ],
    };
    expect(hashTask(task1)).toBe(hashTask(task2));
  });

  it("produces different hash when custom_fields values differ", () => {
    const task1 = { ...baseTask, custom_fields: { Status: "Todo" } };
    const task2 = { ...baseTask, custom_fields: { Status: "Done" } };
    expect(hashTask(task1)).not.toBe(hashTask(task2));
  });
});
