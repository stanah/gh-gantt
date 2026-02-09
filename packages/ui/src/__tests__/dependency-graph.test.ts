import { describe, it, expect } from "vitest";
import { detectCycles, buildDependencyEdges } from "../lib/dependency-graph.js";
import type { Task } from "../types/index.js";

const makeTask = (id: string, blockedBy: Task["blocked_by"] = []): Task => ({
  id, type: "task", github_issue: null, github_repo: "o/r",
  parent: null, sub_tasks: [], title: id, body: null,
  state: "open", state_reason: null, assignees: [], labels: [],
  milestone: null, linked_prs: [], created_at: "", updated_at: "",
  closed_at: null, custom_fields: {}, start_date: "2026-01-01",
  end_date: "2026-01-10", date: null, blocked_by: blockedBy,
});

describe("detectCycles", () => {
  it("returns empty for acyclic graph", () => {
    const tasks = [
      makeTask("a"),
      makeTask("b", [{ task: "a", type: "finish-to-start", lag: 0 }]),
    ];
    expect(detectCycles(tasks)).toEqual([]);
  });

  it("detects a simple cycle", () => {
    const tasks = [
      makeTask("a", [{ task: "b", type: "finish-to-start", lag: 0 }]),
      makeTask("b", [{ task: "a", type: "finish-to-start", lag: 0 }]),
    ];
    const cycles = detectCycles(tasks);
    expect(cycles.length).toBeGreaterThan(0);
  });
});

describe("buildDependencyEdges", () => {
  it("builds edges from blocked_by", () => {
    const tasks = [
      makeTask("a"),
      makeTask("b", [{ task: "a", type: "finish-to-start", lag: 0 }]),
    ];
    const edges = buildDependencyEdges(tasks);
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe("a");
    expect(edges[0].to).toBe("b");
    expect(edges[0].type).toBe("finish-to-start");
  });
});
