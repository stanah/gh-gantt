import { describe, expect, it } from "vitest";
import { calculateCriticalPath, dependencyEdgeKey } from "../dependency-graph.js";
import type { Task } from "../types.js";

function makeTask(id: string, options: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: id,
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
    start_date: "2026-01-01",
    end_date: "2026-01-01",
    date: null,
    blocked_by: [],
    ...options,
  };
}

describe("[FR-VIS-014-AC1] CPM でクリティカルパスと total float を算出する", () => {
  it("最長依存経路のタスクと edge を critical として返す", () => {
    const tasks = [
      makeTask("owner/repo#1", { start_date: "2026-01-01", end_date: "2026-01-02" }),
      makeTask("owner/repo#2", {
        start_date: "2026-01-03",
        end_date: "2026-01-05",
        blocked_by: [{ task: "owner/repo#1", type: "finish-to-start", lag: 0 }],
      }),
      makeTask("owner/repo#3", { start_date: "2026-01-01", end_date: "2026-01-01" }),
    ];

    const result = calculateCriticalPath(tasks);

    expect(result.projectDurationDays).toBe(5);
    expect(result.criticalTaskIds).toEqual(["owner/repo#1", "owner/repo#2"]);
    expect(result.criticalEdgeKeys).toEqual([dependencyEdgeKey("owner/repo#1", "owner/repo#2")]);
    expect(result.taskTimings["owner/repo#1"]?.totalFloat).toBe(0);
    expect(result.taskTimings["owner/repo#2"]?.totalFloat).toBe(0);
    expect(result.taskTimings["owner/repo#3"]?.totalFloat).toBe(4);
  });

  it("日付未設定タスクは計算対象から除外する", () => {
    const result = calculateCriticalPath([
      makeTask("owner/repo#1", { start_date: null, end_date: null }),
      makeTask("owner/repo#2", { start_date: "2026-01-01", end_date: "2026-01-01" }),
    ]);

    expect(Object.keys(result.taskTimings)).toEqual(["owner/repo#2"]);
    expect(result.criticalTaskIds).toEqual(["owner/repo#2"]);
  });
});

describe("[FR-VIS-014-AC4] 循環依存がある場合はクリティカルパス計算を停止する", () => {
  it("cycle を返して critical task を空にする", () => {
    const result = calculateCriticalPath([
      makeTask("owner/repo#1", {
        blocked_by: [{ task: "owner/repo#2", type: "finish-to-start", lag: 0 }],
      }),
      makeTask("owner/repo#2", {
        blocked_by: [{ task: "owner/repo#1", type: "finish-to-start", lag: 0 }],
      }),
    ]);

    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.criticalTaskIds).toEqual([]);
    expect(result.criticalEdgeKeys).toEqual([]);
  });
});
