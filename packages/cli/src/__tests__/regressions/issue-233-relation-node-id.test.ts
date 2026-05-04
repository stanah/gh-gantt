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

function makeMockGql(
  handlers: {
    addSubIssue?: () => unknown;
    addBlockedBy?: () => unknown;
  } = {},
) {
  return vi.fn().mockImplementation(async (query: string, vars?: any) => {
    if (query.includes("issue(number:") && !query.includes("mutation")) {
      return makeBatchIssueResponse(query);
    }
    if (query.includes("updateIssue")) {
      return { updateIssue: { issue: { id: vars?.id ?? "ISSUE_1" } } };
    }
    if (query.includes("closeIssue")) {
      return { closeIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("reopenIssue")) {
      return { reopenIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("addSubIssue")) {
      handlers.addSubIssue?.();
      return { addSubIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("addBlockedBy")) {
      handlers.addBlockedBy?.();
      return { addIssueRelation: { issue: { id: "ISSUE_1" } } };
    }
    return {};
  });
}

describe("[NFR-STABILITY-002-AC1] [NFR-STABILITY-002-AC2] [Issue #233] 関係同期の issue_node_id 欠損リグレッション", () => {
  it("parent の issue_node_id 欠損時に sub-issue を silent skip せず警告し、次回 push で再試行できる", async () => {
    const parent = makeTask("o/r#20", { github_issue: 20 });
    const task = makeTask("o/r#1", {
      github_issue: 1,
      parent: "o/r#20",
    });
    const oldSyncFields = extractSyncFields(makeTask("o/r#1", { github_issue: 1 }));
    const tasksFile: TasksFile = {
      tasks: [parent, task],
      cache: { comments: {}, reactions: {} },
    };
    const syncState: SyncState = {
      last_synced_at: "",
      project_node_id: "PVT_1",
      id_map: {
        "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        "o/r#20": { issue_number: 20 } as any,
      },
      field_ids: {},
      snapshots: {
        "o/r#1": {
          hash: hashTask(makeTask("o/r#1", { github_issue: 1 })),
          synced_at: "",
          syncFields: oldSyncFields,
          updated_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let addSubIssueCalled = false;
    try {
      const { syncState: pushedSyncState } = await executePush(
        makeMockGql({ addSubIssue: () => (addSubIssueCalled = true) }) as any,
        makeConfig(),
        tasksFile,
        syncState,
      );

      expect(addSubIssueCalled).toBe(false);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes("issue_node_id が取得できないため sub-issue 関係をスキップ"),
        ),
      ).toBe(true);
      expect(pushedSyncState.snapshots["o/r#1"]?.syncFields?.parent).toBeNull();
      expect(
        computeLocalDiff(tasksFile.tasks, pushedSyncState).some((diff) => diff.id === "o/r#1"),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("blocker の issue_node_id 欠損時に blocked-by を silent skip せず警告し、次回 push で再試行できる", async () => {
    const blocker = makeTask("o/r#5", { github_issue: 5 });
    const task = makeTask("o/r#1", {
      github_issue: 1,
      blocked_by: [{ task: "o/r#5", type: "finish-to-start", lag: 0 }],
    });
    const oldSyncFields = extractSyncFields(makeTask("o/r#1", { github_issue: 1 }));
    const tasksFile: TasksFile = {
      tasks: [blocker, task],
      cache: { comments: {}, reactions: {} },
    };
    const syncState: SyncState = {
      last_synced_at: "",
      project_node_id: "PVT_1",
      id_map: {
        "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        "o/r#5": { issue_number: 5 } as any,
      },
      field_ids: {},
      snapshots: {
        "o/r#1": {
          hash: hashTask(makeTask("o/r#1", { github_issue: 1 })),
          synced_at: "",
          syncFields: oldSyncFields,
          updated_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let addBlockedByCalled = false;
    try {
      const { syncState: pushedSyncState } = await executePush(
        makeMockGql({ addBlockedBy: () => (addBlockedByCalled = true) }) as any,
        makeConfig(),
        tasksFile,
        syncState,
      );

      expect(addBlockedByCalled).toBe(false);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes("issue_node_id が取得できないため blocked-by 関係をスキップ"),
        ),
      ).toBe(true);
      expect(pushedSyncState.snapshots["o/r#1"]?.syncFields?.blocked_by).toEqual([]);
      expect(
        computeLocalDiff(tasksFile.tasks, pushedSyncState).some((diff) => diff.id === "o/r#1"),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
