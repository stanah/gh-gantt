import { describe, expect, it } from "vitest";
import type { SyncState, Task, TasksFile } from "@gh-gantt/shared";
import { applyTaskDeletion, executeTaskDeletion, planTaskDeletion } from "../commands/delete.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  const issueNumber = Number(id.split("#")[1]);
  return {
    id,
    type: "task",
    github_issue: Number.isFinite(issueNumber) ? issueNumber : null,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: `Task ${id}`,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    closed_at: null,
    acceptance_criteria: [],
    acceptance_criteria_slot: false,
    implementer: null,
    reviewer: null,
    require_review: false,
    review_approved_by: null,
    review_approved_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeTasksFile(tasks: Task[], overrides: Partial<TasksFile> = {}): TasksFile {
  return {
    tasks,
    cache: { comments: {}, reactions: {} },
    ...overrides,
  };
}

function makeSyncState(taskIds: string[]): SyncState {
  return {
    last_synced_at: "2026-01-01T00:00:00.000Z",
    project_node_id: "PROJECT",
    field_ids: {},
    option_ids: {},
    id_map: Object.fromEntries(
      taskIds.map((id, index) => [
        id,
        {
          issue_number: index + 1,
          issue_node_id: `ISSUE_${index + 1}`,
          project_item_id: `ITEM_${index + 1}`,
        },
      ]),
    ),
    snapshots: Object.fromEntries(
      taskIds.map((id) => [
        id,
        {
          hash: `hash-${id}`,
          synced_at: "2026-01-01T00:00:00.000Z",
          syncFields: {
            title: id,
            body: null,
            acceptance_criteria: [],
            acceptance_criteria_slot: false,
            implementer: null,
            reviewer: null,
            require_review: false,
            review_approved_by: null,
            review_approved_at: null,
            state: "open",
            type: "task",
            assignees: [],
            labels: [],
            milestone: null,
            custom_fields: {},
            parent: null,
            sub_tasks: [],
            start_date: null,
            end_date: null,
            date: null,
            blocked_by: [],
          },
        },
      ]),
    ),
  };
}

describe("[FR-CLI-017-AC1] delete command は誤作成 Issue と mirror 参照を transactional に取り消せる", () => {
  it("対象 task と sync-state を削除し、parent / sub_tasks / blocked_by 参照を掃除する", () => {
    const target = makeTask("owner/repo#2", {
      parent: "owner/repo#1",
      blocked_by: [{ task: "owner/repo#4", type: "finish-to-start", lag: 0 }],
    });
    const parent = makeTask("owner/repo#1", { sub_tasks: ["owner/repo#2", "owner/repo#3"] });
    const child = makeTask("owner/repo#3", { parent: "owner/repo#2" });
    const dependent = makeTask("owner/repo#4", {
      blocked_by: [
        { task: "owner/repo#2", type: "finish-to-start", lag: 0 },
        { task: "owner/repo#1", type: "finish-to-start", lag: 0 },
      ],
    });
    const tasksFile = makeTasksFile([parent, target, child, dependent]);
    const syncState = makeSyncState(tasksFile.tasks.map((task) => task.id));

    const plan = planTaskDeletion(tasksFile, syncState, "owner/repo#2");
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.error);

    expect(plan.repair.parentCleared).toEqual(["owner/repo#3"]);
    expect(plan.repair.subTaskRemoved).toEqual(["owner/repo#1"]);
    expect(plan.repair.blockedByRemoved).toEqual(["owner/repo#4"]);

    const result = applyTaskDeletion(tasksFile, syncState, plan, "2026-02-01T00:00:00.000Z");
    expect(result.tasksFile.tasks.map((task) => task.id)).toEqual([
      "owner/repo#1",
      "owner/repo#3",
      "owner/repo#4",
    ]);
    expect(result.tasksFile.tasks.find((task) => task.id === "owner/repo#1")!.sub_tasks).toEqual([
      "owner/repo#3",
    ]);
    expect(result.tasksFile.tasks.find((task) => task.id === "owner/repo#3")!.parent).toBeNull();
    expect(result.tasksFile.tasks.find((task) => task.id === "owner/repo#4")!.blocked_by).toEqual([
      { task: "owner/repo#1", type: "finish-to-start", lag: 0 },
    ]);
    expect(result.syncState.id_map["owner/repo#2"]).toBeUndefined();
    expect(result.syncState.snapshots["owner/repo#2"]).toBeUndefined();
  });

  it("未解決コンフリクトがある場合は削除計画を拒否する", () => {
    const tasksFile = makeTasksFile([makeTask("owner/repo#1")], { has_conflicts: true });
    const syncState = makeSyncState(["owner/repo#1"]);

    const plan = planTaskDeletion(tasksFile, syncState, "owner/repo#1");

    expect(plan).toEqual({
      ok: false,
      error: "未解決のコンフリクトがあります。先に resolve してください",
    });
  });

  it("draft task は delete ではなく discard を促して拒否する", () => {
    const tasksFile = makeTasksFile([makeTask("owner/repo#draft-1", { github_issue: null })]);
    const syncState = makeSyncState(["owner/repo#draft-1"]);

    const plan = planTaskDeletion(tasksFile, syncState, "owner/repo#draft-1");

    expect(plan).toEqual({
      ok: false,
      error: "draft task は delete できません。push 前の draft は discard を使ってください",
    });
  });

  it("GitHub Issue 削除、mirror cleanup、force pull 検証を一つの操作として実行する", async () => {
    const target = makeTask("owner/repo#2");
    const dependent = makeTask("owner/repo#3", {
      blocked_by: [{ task: "owner/repo#2", type: "finish-to-start", lag: 0 }],
    });
    const tasksFile = makeTasksFile([target, dependent]);
    const syncState = makeSyncState(tasksFile.tasks.map((task) => task.id));
    const deleteCalls: Array<{ owner: string; repo: string; issueNumber: number }> = [];

    const result = await executeTaskDeletion({
      owner: "owner",
      repo: "repo",
      tasksFile,
      syncState,
      taskId: "owner/repo#2",
      yes: true,
      now: "2026-02-01T00:00:00.000Z",
      deleteGithubIssue: async (input) => {
        deleteCalls.push(input);
      },
      forcePull: async ({ tasksFile: cleanedTasksFile, syncState: cleanedSyncState }) => ({
        tasksFile: cleanedTasksFile,
        syncState: cleanedSyncState,
      }),
    });

    expect(result.ok).toBe(true);
    expect(deleteCalls).toEqual([{ owner: "owner", repo: "repo", issueNumber: 2 }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.tasksFile.tasks.map((task) => task.id)).toEqual(["owner/repo#3"]);
    expect(result.tasksFile.tasks[0]!.blocked_by).toEqual([]);
    expect(result.syncState.id_map["owner/repo#2"]).toBeUndefined();
  });

  it("--yes がない場合は GitHub Issue を削除しない", async () => {
    let deleteCalled = false;
    const tasksFile = makeTasksFile([makeTask("owner/repo#1")]);
    const syncState = makeSyncState(["owner/repo#1"]);

    const result = await executeTaskDeletion({
      owner: "owner",
      repo: "repo",
      tasksFile,
      syncState,
      taskId: "owner/repo#1",
      yes: false,
      deleteGithubIssue: async () => {
        deleteCalled = true;
      },
      forcePull: async () => {
        throw new Error("forcePull should not be called");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "GitHub Issue を削除するには --yes を指定してください",
    });
    expect(deleteCalled).toBe(false);
  });

  it("force pull 後に対象が再出現した場合は明示エラーにする", async () => {
    const tasksFile = makeTasksFile([makeTask("owner/repo#1")]);
    const syncState = makeSyncState(["owner/repo#1"]);

    const result = await executeTaskDeletion({
      owner: "owner",
      repo: "repo",
      tasksFile,
      syncState,
      taskId: "owner/repo#1",
      yes: true,
      deleteGithubIssue: async () => {},
      forcePull: async () => ({ tasksFile, syncState }),
    });

    expect(result).toEqual({
      ok: false,
      error: "削除後の再同期で対象 task が再出現しました: owner/repo#1",
    });
  });
});
