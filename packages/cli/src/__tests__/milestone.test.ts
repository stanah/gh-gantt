import { describe, it, expect } from "vitest";
import { milestoneToTask, isMilestoneSyntheticTask } from "../github/issues.js";
import type { RawMilestone } from "../github/projects.js";

describe("isMilestoneSyntheticTask", () => {
  it("returns true for synthetic milestone IDs", () => {
    expect(isMilestoneSyntheticTask("milestone:owner/repo#1")).toBe(true);
    expect(isMilestoneSyntheticTask("milestone:org/project#42")).toBe(true);
  });

  it("returns false for regular task IDs", () => {
    expect(isMilestoneSyntheticTask("owner/repo#1")).toBe(false);
    expect(isMilestoneSyntheticTask("owner/repo#draft-1")).toBe(false);
  });
});

describe("milestoneToTask", () => {
  const baseMilestone: RawMilestone = {
    id: "MDk6TWlsZXN0b25lMQ==",
    title: "v1.0",
    number: 1,
    dueOn: "2026-03-01",
    description: "First stable release",
    closedAt: null,
    state: "OPEN",
  };

  it("generates correct task ID with milestone: prefix", () => {
    const task = milestoneToTask(baseMilestone, "owner/repo");
    expect(task.id).toBe("milestone:owner/repo#1");
  });

  it("sets type to milestone", () => {
    const task = milestoneToTask(baseMilestone, "owner/repo");
    expect(task.type).toBe("milestone");
  });

  it("maps dueOn to date field", () => {
    const task = milestoneToTask(baseMilestone, "owner/repo");
    expect(task.date).toBe("2026-03-01");
  });

  it("normalizes ISO timestamp dueOn to YYYY-MM-DD", () => {
    const m: RawMilestone = {
      ...baseMilestone,
      dueOn: "2026-05-31T00:00:00Z",
    };
    const task = milestoneToTask(m, "owner/repo");
    expect(task.date).toBe("2026-05-31");
  });

  it("handles null dueOn", () => {
    const m: RawMilestone = { ...baseMilestone, dueOn: null };
    const task = milestoneToTask(m, "owner/repo");
    expect(task.date).toBeNull();
  });

  it("maps title and description", () => {
    const task = milestoneToTask(baseMilestone, "owner/repo");
    expect(task.title).toBe("v1.0");
    expect(task.body).toBe("First stable release");
  });

  it("maps open state correctly", () => {
    const task = milestoneToTask(baseMilestone, "owner/repo");
    expect(task.state).toBe("open");
  });

  it("maps closed state correctly", () => {
    const closedMilestone: RawMilestone = {
      ...baseMilestone,
      state: "CLOSED",
      closedAt: "2026-02-15T00:00:00Z",
    };
    const task = milestoneToTask(closedMilestone, "owner/repo");
    expect(task.state).toBe("closed");
    expect(task.closed_at).toBe("2026-02-15T00:00:00Z");
  });

  it("has null github_issue since milestones are not issues", () => {
    const task = milestoneToTask(baseMilestone, "owner/repo");
    expect(task.github_issue).toBeNull();
  });

  it("has no start_date or end_date", () => {
    const task = milestoneToTask(baseMilestone, "owner/repo");
    expect(task.start_date).toBeNull();
    expect(task.end_date).toBeNull();
  });

  it("handles null description", () => {
    const m: RawMilestone = { ...baseMilestone, description: null };
    const task = milestoneToTask(m, "owner/repo");
    expect(task.body).toBeNull();
  });
});
