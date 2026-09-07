/**
 * [Issue #351] 過去に作られた閉じた Issue の階層違反（type_hierarchy で許可されない親子）が
 * Work Graph に残っていると、その親子に触れない create / update / link まで
 * 「task は epic を子にできません」で拒否されていた。
 *
 * 修正: 階層検査は今回の変更で生じた親子だけを対象にし、変更前から同じ型の組で
 * 存在していた親子は既存データとして免除する。新たに違反を生む変更は従来どおり拒否する。
 */
import { describe, expect, it } from "vitest";
import type { Config, Task } from "@gh-gantt/shared";
import { WorkGraphCommandEngine } from "../../work-graph/command-engine.js";

const config: Config = {
  version: "1",
  project: { name: "公開fixture", github: { owner: "example", repo: "public", project_number: 1 } },
  sync: { auto_create_issues: true, field_mapping: { start_date: "Start", end_date: "End" } },
  task_types: {
    epic: { label: "Epic", display: "summary", color: "#000", github_label: "epic" },
    task: { label: "Task", display: "bar", color: "#111", github_label: "task" },
  },
  type_hierarchy: { epic: ["epic", "task"], task: [] },
  statuses: {
    field_name: "Status",
    values: { Todo: { color: "#000", done: false }, Done: { color: "#0f0", done: true } },
  },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: Number(id.split("#")[1]),
    github_repo: "example/public",
    parent: null,
    sub_tasks: [],
    title: id,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: ["task"],
    milestone: null,
    linked_prs: [],
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    closed_at: null,
    custom_fields: { Status: "Todo" },
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

/** closed の task #183 の子に epic #43 が残っている、実データと同じ形の違反 */
function legacyViolation(): Task[] {
  return [
    task("example/public#183", { state: "closed", sub_tasks: ["example/public#43"] }),
    task("example/public#43", { type: "epic", state: "closed", parent: "example/public#183" }),
    task("example/public#344"),
  ];
}

describe("[FR-HIER-001-AC4] [Issue #351] 既存の階層違反は無関係な変更を拒否しない", () => {
  const engine = new WorkGraphCommandEngine(config, { now: () => "2026-08-02T01:00:00.000Z" });

  it("違反に触れない update は成功する", () => {
    const result = engine.executeCommand({
      type: "update",
      tasks: legacyViolation(),
      taskId: "example/public#344",
      updates: { title: "renamed" },
    });

    expect(result.ok).toBe(true);
  });

  it("違反に触れない create は成功する", () => {
    const result = engine.executeCommand({
      type: "create",
      tasks: legacyViolation(),
      task: task("example/public#350"),
    });

    expect(result.ok).toBe(true);
  });

  it("違反に触れない proposal も成功する", () => {
    const result = engine.planMutation(legacyViolation(), {
      kind: "dependency",
      operation: "add",
      taskId: "example/public#344",
      blockerTaskId: "example/public#183",
    });

    expect(result.ok).toBe(true);
  });

  it("新たに違反を生む create は親と子の ID を含むメッセージで拒否する", () => {
    const result = engine.executeCommand({
      type: "create",
      tasks: legacyViolation(),
      task: task("example/public#350", { type: "epic", parent: "example/public#344" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_hierarchy");
      expect(result.error).toContain("example/public#344");
      expect(result.error).toContain("example/public#350");
    }
  });

  it("新たに違反を生む link は拒否する", () => {
    const result = engine.executeCommand({
      type: "link",
      tasks: [...legacyViolation(), task("example/public#360", { type: "epic" })],
      taskId: "example/public#360",
      operations: [{ kind: "set_parent", parentTaskId: "example/public#344" }],
    });

    expect(result).toMatchObject({ ok: false, code: "invalid_hierarchy" });
  });

  it("既存の親子でも型が変わって違反になる update は拒否する", () => {
    const tasks = [
      task("example/public#1", { type: "epic", sub_tasks: ["example/public#2"] }),
      task("example/public#2", { parent: "example/public#1" }),
    ];
    const result = engine.executeCommand({
      type: "update",
      tasks,
      taskId: "example/public#1",
      updates: { type: "task" },
    });

    expect(result).toMatchObject({ ok: false, code: "invalid_hierarchy" });
  });
});
