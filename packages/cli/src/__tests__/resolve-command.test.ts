import { describe, it, expect } from "vitest";
import { resolveAll } from "../commands/resolve.js";

describe("resolveAll", () => {
  it("resolves all markers with --ours", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8",
        title: "Fix login bug",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
        title_current: "Fix login bug",
        title_incoming: "Fix login bug v2",
      },
    ];

    const theirsResolutions = resolveAll(tasks, "ours");

    expect(tasks[0].state).toBe("open");
    expect(tasks[0].title).toBe("Fix login bug");
    expect(tasks[0]).not.toHaveProperty("state_current");
    expect(tasks[0]).not.toHaveProperty("state_incoming");
    expect(tasks[0]).not.toHaveProperty("title_current");
    expect(tasks[0]).not.toHaveProperty("title_incoming");
    // --ours なので theirsResolutions は空
    expect(theirsResolutions.size).toBe(0);
  });

  it("resolves all markers with --theirs", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8",
        title: "Fix login bug",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
        title_current: "Fix login bug",
        title_incoming: "Fix login bug v2",
      },
    ];

    const theirsResolutions = resolveAll(tasks, "theirs");

    expect(tasks[0].state).toBe("closed");
    expect(tasks[0].title).toBe("Fix login bug v2");
    expect(tasks[0]).not.toHaveProperty("state_current");
    expect(tasks[0]).not.toHaveProperty("state_incoming");
    expect(tasks[0]).not.toHaveProperty("title_current");
    expect(tasks[0]).not.toHaveProperty("title_incoming");
    // --theirs なので theirsResolutions に記録される
    expect(theirsResolutions.size).toBe(1);
    expect(theirsResolutions.get("owner/repo#8")).toEqual(new Set(["state", "title"]));
  });

  it("resolves specific task only (by issue number)", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8",
        title: "Task 8",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
      },
      {
        id: "owner/repo#9",
        title: "Task 9",
        title_current: "Task 9",
        title_incoming: "Task 9 updated",
      },
    ];

    const theirsResolutions = resolveAll(tasks, "ours", 8);

    // Task 8 should be resolved
    expect(tasks[0]).not.toHaveProperty("state_current");
    expect(tasks[0]).not.toHaveProperty("state_incoming");
    expect(tasks[0].state).toBe("open");

    // Task 9 should still have conflicts
    expect(tasks[1]).toHaveProperty("title_current");
    expect(tasks[1]).toHaveProperty("title_incoming");

    // --ours なので theirsResolutions は空
    expect(theirsResolutions.size).toBe(0);
  });

  it("resolves specific field only", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8",
        title: "Fix login bug",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
        title_current: "Fix login bug",
        title_incoming: "Fix login bug v2",
      },
    ];

    const theirsResolutions = resolveAll(tasks, "theirs", undefined, "state");

    // state should be resolved with incoming value
    expect(tasks[0].state).toBe("closed");
    expect(tasks[0]).not.toHaveProperty("state_current");
    expect(tasks[0]).not.toHaveProperty("state_incoming");

    // title should still have conflicts
    expect(tasks[0]).toHaveProperty("title_current");
    expect(tasks[0]).toHaveProperty("title_incoming");

    // state のみ --theirs で解決
    expect(theirsResolutions.size).toBe(1);
    expect(theirsResolutions.get("owner/repo#8")).toEqual(new Set(["state"]));
  });
});
