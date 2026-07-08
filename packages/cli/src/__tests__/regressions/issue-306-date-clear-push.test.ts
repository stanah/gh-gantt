/**
 * Issue #306: push が start_date / end_date のクリア (none 指定) を ProjectV2 に反映しない
 *
 * push-executor の日付フィールド送信は `if (task.start_date && ...)` の truthy 判定で
 * ガードされており、`gh-gantt update <id> --start-date none` でローカルの日付を null に
 * しても ProjectV2 側のフィールドをクリアする経路が存在しなかった。
 * その結果、ローカルで消した日付が GitHub に残り続け、次の pull で復活していた。
 *
 * 修正: estimate_hours の既存クリアパターンに従い、「ローカルが null かつ
 * snapshot (syncFields) に以前の値がある」場合のみ clearProjectV2ItemFieldValue を呼ぶ。
 */
import { describe, expect, it, vi } from "vitest";
import type { Config, Task, TasksFile, SyncState } from "@gh-gantt/shared";
import { computeLocalDiff } from "../../sync/diff.js";
import { extractSyncFields, hashTask } from "../../sync/hash.js";
import { executePush } from "../../sync/push-executor.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "o/r",
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
    created_at: "",
    updated_at: "",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeConfig(): Config {
  return {
    version: "1",
    project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
    sync: {
      auto_create_issues: true,
      field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
    },
    task_types: {},
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "", on_track: "", at_risk: "", overdue: "" },
    },
  } as Config;
}

function makeBatchIssueResponse(query: string): any {
  const matches = [...query.matchAll(/issue\(number:\s*(\d+)\)/g)];
  const repository: Record<string, any> = {};
  matches.forEach((match, index) => {
    repository[`i${index}`] = {
      number: Number(match[1]),
      updatedAt: "2026-01-01T00:00:00Z",
      stateReason: null,
      closedAt: null,
    };
  });
  return { repository };
}

/** clearProjectV2ItemFieldValue / updateProjectV2ItemFieldValue の呼び出しを記録する mock gql */
function makeMockGql(recorded: { cleared: any[]; updated: any[] }) {
  return vi.fn().mockImplementation(async (query: string, vars?: any) => {
    if (query.includes("issue(number:") && !query.includes("mutation")) {
      return makeBatchIssueResponse(query);
    }
    if (query.includes("updateIssue")) {
      return { updateIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("closeIssue")) {
      return { closeIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("reopenIssue")) {
      return { reopenIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      recorded.updated.push(vars);
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
    }
    if (query.includes("clearProjectV2ItemFieldValue")) {
      recorded.cleared.push(vars);
      return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
    }
    return {};
  });
}

function makeSyncState(previousTask: Task): SyncState {
  return {
    last_synced_at: "",
    project_node_id: "PVT_1",
    id_map: {
      "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
    },
    field_ids: { "Start Date": "FIELD_START", "End Date": "FIELD_END" },
    snapshots: {
      "o/r#1": {
        hash: hashTask(previousTask),
        synced_at: "",
        syncFields: extractSyncFields(previousTask),
        updated_at: "2026-01-01T00:00:00Z",
      },
    },
  };
}

describe("[NFR-STABILITY-002-AC3] [Issue #306] 日付クリアが push で ProjectV2 に反映されないリグレッション", () => {
  it("日付の null 化が diff で modified として検出される", () => {
    // 前回同期時は日付あり、ローカルで none 指定により null 化
    const previousTask = makeTask("o/r#1", {
      github_issue: 1,
      start_date: "2026-07-01",
      end_date: "2026-07-31",
    });
    const task = makeTask("o/r#1", { github_issue: 1 });

    const diffs = computeLocalDiff([task], makeSyncState(previousTask));

    expect(diffs).toContainEqual(expect.objectContaining({ id: "o/r#1", type: "modified" }));
  });

  it("start_date / end_date の null 化が push で ProjectV2 フィールドクリアとして反映される", async () => {
    const recorded = { cleared: [] as any[], updated: [] as any[] };
    const previousTask = makeTask("o/r#1", {
      github_issue: 1,
      start_date: "2026-07-01",
      end_date: "2026-07-31",
    });
    // `gh-gantt update <id> --start-date none --end-date none` 相当の状態
    const task = makeTask("o/r#1", { github_issue: 1 });
    const tasksFile: TasksFile = {
      tasks: [task],
      cache: { comments: {}, reactions: {} },
    };

    const mockGql = makeMockGql(recorded);
    await executePush(mockGql as any, makeConfig(), tasksFile, makeSyncState(previousTask));

    // 期待: 両方の日付フィールドが clearProjectV2ItemFieldValue でクリアされる
    expect(recorded.cleared).toContainEqual(expect.objectContaining({ fieldId: "FIELD_START" }));
    expect(recorded.cleared).toContainEqual(expect.objectContaining({ fieldId: "FIELD_END" }));
  });

  it("片方の日付だけ null 化した場合、null 化した側だけ clear し残りは update する", async () => {
    const recorded = { cleared: [] as any[], updated: [] as any[] };
    const previousTask = makeTask("o/r#1", {
      github_issue: 1,
      start_date: "2026-07-01",
      end_date: "2026-07-31",
    });
    const task = makeTask("o/r#1", {
      github_issue: 1,
      start_date: null,
      end_date: "2026-07-31",
    });
    const tasksFile: TasksFile = {
      tasks: [task],
      cache: { comments: {}, reactions: {} },
    };

    const mockGql = makeMockGql(recorded);
    await executePush(mockGql as any, makeConfig(), tasksFile, makeSyncState(previousTask));

    expect(recorded.cleared).toContainEqual(expect.objectContaining({ fieldId: "FIELD_START" }));
    expect(recorded.cleared).not.toContainEqual(expect.objectContaining({ fieldId: "FIELD_END" }));
    expect(recorded.updated).toContainEqual(
      expect.objectContaining({ fieldId: "FIELD_END", value: { date: "2026-07-31" } }),
    );
  });

  it("以前から null の日付には clear を呼ばない (不要な API コールを避ける)", async () => {
    const recorded = { cleared: [] as any[], updated: [] as any[] };
    // 日付は以前も現在も null。タイトル変更のみで modified になる
    const previousTask = makeTask("o/r#1", { github_issue: 1 });
    const task = makeTask("o/r#1", { github_issue: 1, title: "更新後のタイトル" });
    const tasksFile: TasksFile = {
      tasks: [task],
      cache: { comments: {}, reactions: {} },
    };

    const mockGql = makeMockGql(recorded);
    await executePush(mockGql as any, makeConfig(), tasksFile, makeSyncState(previousTask));

    expect(recorded.cleared).toEqual([]);
  });
});
