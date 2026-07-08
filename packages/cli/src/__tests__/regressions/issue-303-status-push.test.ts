/**
 * Issue #303: push が ProjectV2 の Status フィールドを更新せず一方向 (pull-only) になっている
 *
 * push-executor の updateProjectItemField 呼び出しは start_date / end_date / type /
 * priority / estimate_hours のみを対象としており、ProjectV2 の Status フィールド
 * (task.custom_fields[config.statuses.field_name] に保持) を書き込む経路が存在しなかった。
 * その結果 `gh-gantt update <id> --status "In Progress"` でローカルの Status を変更しても
 * push で GitHub に反映されず、pull でリモート値に巻き戻されていた。
 *
 * 修正: config.statuses.field_name のフィールドについて、snapshot (syncFields) の
 * custom_fields と差分がある場合のみ updateProjectV2ItemFieldValue を
 * singleSelectOptionId で送信する。option 名 → ID の解決には pull 時に保存済みの
 * syncState.option_ids を使い、未解決名は #305 のパターン (警告 + フィールド単位スキップ +
 * snapshot 旧値維持) に従う。null 化は #306 のパターンでフィールドクリアとして送信する。
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

/** updateProjectV2ItemFieldValue / clearProjectV2ItemFieldValue の呼び出しを記録する mock gql */
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
    field_ids: { Status: "FIELD_STATUS" },
    option_ids: {
      Status: { Todo: "OPT_TODO", "In Progress": "OPT_IN_PROGRESS", Done: "OPT_DONE" },
    },
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

describe("[NFR-STABILITY-002-AC5] [Issue #303] Status 変更が push で ProjectV2 に反映されないリグレッション", () => {
  it("Status の変更が diff で modified として検出される", () => {
    // 前回同期時は Todo、ローカルで In Progress に変更
    const previousTask = makeTask("o/r#1", {
      github_issue: 1,
      custom_fields: { Status: "Todo" },
    });
    const task = makeTask("o/r#1", {
      github_issue: 1,
      custom_fields: { Status: "In Progress" },
    });

    const diffs = computeLocalDiff([task], makeSyncState(previousTask));

    expect(diffs).toContainEqual(expect.objectContaining({ id: "o/r#1", type: "modified" }));
  });

  it("Status の変更が push で ProjectV2 の Status フィールド更新として反映される", async () => {
    const recorded = { cleared: [] as any[], updated: [] as any[] };
    const previousTask = makeTask("o/r#1", {
      github_issue: 1,
      custom_fields: { Status: "Todo" },
    });
    // `gh-gantt update <id> --status "In Progress"` 相当の状態
    const task = makeTask("o/r#1", {
      github_issue: 1,
      custom_fields: { Status: "In Progress" },
    });
    const tasksFile: TasksFile = {
      tasks: [task],
      cache: { comments: {}, reactions: {} },
    };

    const mockGql = makeMockGql(recorded);
    await executePush(mockGql as any, makeConfig(), tasksFile, makeSyncState(previousTask));

    // 期待: Status フィールドが singleSelectOptionId で更新される
    expect(recorded.updated).toContainEqual(
      expect.objectContaining({
        fieldId: "FIELD_STATUS",
        value: { singleSelectOptionId: "OPT_IN_PROGRESS" },
      }),
    );
  });

  it("Status の null 化が push で ProjectV2 フィールドクリアとして反映される", async () => {
    const recorded = { cleared: [] as any[], updated: [] as any[] };
    const previousTask = makeTask("o/r#1", {
      github_issue: 1,
      custom_fields: { Status: "Todo" },
    });
    // 3-way merge 等でローカルの Status キーが失われた状態
    const task = makeTask("o/r#1", { github_issue: 1, custom_fields: {} });
    const tasksFile: TasksFile = {
      tasks: [task],
      cache: { comments: {}, reactions: {} },
    };

    const mockGql = makeMockGql(recorded);
    await executePush(mockGql as any, makeConfig(), tasksFile, makeSyncState(previousTask));

    expect(recorded.cleared).toContainEqual(expect.objectContaining({ fieldId: "FIELD_STATUS" }));
  });

  it("未解決の Status 値は silent drop せず警告付きでスキップし、次回 push で再試行される", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorded = { cleared: [] as any[], updated: [] as any[] };
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { Status: "Todo" },
      });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { Status: "no-such-status" },
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };

      const mockGql = makeMockGql(recorded);
      const { syncState: newSyncState } = await executePush(
        mockGql as any,
        makeConfig(),
        tasksFile,
        makeSyncState(previousTask),
      );

      // Status の update / clear は送信されず、警告が出る
      expect(recorded.updated).not.toContainEqual(
        expect.objectContaining({ fieldId: "FIELD_STATUS" }),
      );
      expect(recorded.cleared).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("option として解決できない"));

      // snapshot の Status は旧値に留まり、次回 push で差分として再検出される
      expect(newSyncState.snapshots["o/r#1"].syncFields?.custom_fields).toEqual({
        Status: "Todo",
      });
      const retryDiffs = computeLocalDiff([task], newSyncState);
      expect(retryDiffs).toContainEqual(expect.objectContaining({ id: "o/r#1", type: "modified" }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("draft 作成時に未解決の Status は snapshot をキーなしで確定し、次回 push で再試行される", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorded = { cleared: [] as any[], updated: [] as any[] };
      // draft タスクに ProjectV2 の option として存在しない Status が設定されている
      const task = makeTask("o/r#draft-1", {
        custom_fields: { Status: "no-such-status" },
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {},
        field_ids: { Status: "FIELD_STATUS" },
        option_ids: { Status: { Todo: "OPT_TODO" } },
        snapshots: {},
      };

      const mockGql = vi.fn().mockImplementation(async (query: string, vars?: any) => {
        if (query.includes("createIssue(input")) {
          return { createIssue: { issue: { id: "ISSUE_NEW", number: 99 } } };
        }
        if (query.includes("addProjectV2ItemById")) {
          return { addProjectV2ItemById: { item: { id: "ITEM_NEW" } } };
        }
        if (query.includes("updateProjectV2ItemFieldValue")) {
          recorded.updated.push(vars);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_NEW" } } };
        }
        if (query.includes("clearProjectV2ItemFieldValue")) {
          recorded.cleared.push(vars);
          return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_NEW" } } };
        }
        if (query.includes("labels(")) {
          return {
            repository: { labels: { nodes: [] }, milestones: { nodes: [] } },
          };
        }
        if (query.includes("repository(owner")) {
          return { repository: { id: "REPO_1" } };
        }
        return {};
      });

      const { syncState: newSyncState } = await executePush(
        mockGql as any,
        makeConfig(),
        tasksFile,
        syncState,
      );

      // Status は送信されず警告が出る
      expect(recorded.updated).not.toContainEqual(
        expect.objectContaining({ fieldId: "FIELD_STATUS" }),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("option として解決できない"));

      // snapshot は「リモートに Status がない」実態に合わせてキーなしで確定する
      // (ローカル値のまま確定すると差分が消えて再試行不能になるリグレッション)
      const snapshot = newSyncState.snapshots["o/r#99"];
      expect(snapshot.syncFields?.custom_fields).not.toHaveProperty("Status");

      // 次回 push でローカルの Status が差分として再検出される
      const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
      expect(retryDiffs).toContainEqual(
        expect.objectContaining({ id: "o/r#99", type: "modified" }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("Status に差分がなければ Status フィールドの API コールを行わない", async () => {
    const recorded = { cleared: [] as any[], updated: [] as any[] };
    // Status は同一のままタイトルだけ変更する
    const previousTask = makeTask("o/r#1", {
      github_issue: 1,
      custom_fields: { Status: "Todo" },
    });
    const task = makeTask("o/r#1", {
      github_issue: 1,
      title: "更新後のタイトル",
      custom_fields: { Status: "Todo" },
    });
    const tasksFile: TasksFile = {
      tasks: [task],
      cache: { comments: {}, reactions: {} },
    };

    const mockGql = makeMockGql(recorded);
    await executePush(mockGql as any, makeConfig(), tasksFile, makeSyncState(previousTask));

    expect(recorded.updated).not.toContainEqual(
      expect.objectContaining({ fieldId: "FIELD_STATUS" }),
    );
    expect(recorded.cleared).toEqual([]);
  });
});
