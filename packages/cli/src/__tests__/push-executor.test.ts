/**
 * Tests for executePush covering bug fixes:
 * - Fix 1-1: updated_at refresh after push
 * - Fix 1-2: state update without snapshot
 * - Fix 1-3: project_item_id guard
 * - Fix 1-4: syncFields fallback for relationships
 * - Fix 1-5: relationship warnings
 */
import { describe, it, expect, vi } from "vitest";
import { executePush } from "../sync/push-executor.js";
import { extractSyncFields, hashTask } from "../sync/hash.js";
import { computeLocalDiff } from "../sync/diff.js";
import type { Task, TasksFile, SyncState, Config } from "@gh-gantt/shared";

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

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    ...overrides,
  } as Config;
}

function makeBatchIssueResponse(
  issueNumbers: number[],
  handler?: (query: string, vars?: any) => any,
): any {
  if (handler) return handler("batch", undefined);
  const repo: Record<string, any> = {};
  issueNumbers.forEach((n, i) => {
    repo[`i${i}`] = {
      number: n,
      updatedAt: "2026-01-01T00:00:00Z",
      stateReason: null,
      closedAt: null,
    };
  });
  return { repository: repo };
}

function extractBatchIssueNumbers(query: string): number[] {
  const matches = [...query.matchAll(/issue\(number:\s*(\d+)\)/g)];
  return matches.map((m) => Number(m[1]));
}

function makeMockGql(handlers?: Partial<Record<string, (query: string, vars?: any) => any>>) {
  return vi.fn().mockImplementation(async (query: string, vars?: any) => {
    // Route by query content
    // Batch updatedAt query (alias pattern: i0: issue(number: N) ...)
    if (
      query.includes("issue(number:") &&
      !query.includes("mutation") &&
      !query.includes("$number")
    ) {
      const numbers = extractBatchIssueNumbers(query);
      if (handlers?.["batchUpdatedAt"]) return handlers["batchUpdatedAt"](query, vars);
      if (handlers?.["issue(number"])
        return makeBatchIssueResponse(numbers, handlers["issue(number"]);
      return makeBatchIssueResponse(numbers);
    }
    // Single issue query (parameterized)
    if (query.includes("issue(number") && !query.includes("mutation")) {
      if (handlers?.["issue(number"]) return handlers["issue(number"](query, vars);
      return { repository: { issue: { updatedAt: "2026-01-01T00:00:00Z" } } };
    }
    if (query.includes("updateIssue")) {
      if (handlers?.["updateIssue"]) return handlers["updateIssue"](query, vars);
      return { updateIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("closeIssue")) {
      if (handlers?.["closeIssue"]) return handlers["closeIssue"](query, vars);
      return { closeIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("reopenIssue")) {
      if (handlers?.["reopenIssue"]) return handlers["reopenIssue"](query, vars);
      return { reopenIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      if (handlers?.["updateProjectV2ItemFieldValue"])
        return handlers["updateProjectV2ItemFieldValue"](query, vars);
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
    }
    if (query.includes("clearProjectV2ItemFieldValue")) {
      if (handlers?.["clearProjectV2ItemFieldValue"])
        return handlers["clearProjectV2ItemFieldValue"](query, vars);
      return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
    }
    if (query.includes("addSubIssue")) {
      if (handlers?.["addSubIssue"]) return handlers["addSubIssue"](query, vars);
      return { addSubIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("removeSubIssue")) {
      if (handlers?.["removeSubIssue"]) return handlers["removeSubIssue"](query, vars);
      return { removeSubIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("addBlockedBy")) {
      if (handlers?.["addBlockedBy"]) return handlers["addBlockedBy"](query, vars);
      return { addIssueRelation: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("removeBlockedBy")) {
      if (handlers?.["removeBlockedBy"]) return handlers["removeBlockedBy"](query, vars);
      return { removeIssueRelation: { issue: { id: "ISSUE_1" } } };
    }
    // repository metadata クエリ (labelMap / milestoneMap)
    if (query.includes("labels(first")) {
      if (handlers?.["repositoryMetadata"]) return handlers["repositoryMetadata"](query, vars);
      return { repository: { labels: { nodes: [] }, milestones: { nodes: [] } } };
    }
    // fetchUserIds クエリ (u0: user(login: "x") { id login })
    if (query.includes("user(login:")) {
      if (handlers?.["userIds"]) return handlers["userIds"](query, vars);
      return {};
    }
    return {};
  });
}

describe("executePush", () => {
  describe("[FR-SYNC-003-AC1] ローカルの変更を GitHub に反映できる", () => {
    it("returns empty result when no changes", async () => {
      const task = makeTask("o/r#1", { github_issue: 1 });
      const hash = hashTask(task);
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash,
            synced_at: "",
            syncFields: extractSyncFields(task),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql();
      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
      // No GQL calls should have been made
      expect(mockGql).not.toHaveBeenCalled();
    });

    it("state is updated even without snapshot (Fix 1-2)", async () => {
      // Task exists in id_map but NOT in snapshots
      const task = makeTask("o/r#1", { github_issue: 1, state: "closed" });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {}, // No snapshot — task appears as "added" in diff
      };

      const mockGql = makeMockGql();
      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.updated).toBe(1);

      // Verify updateIssue was called
      const updateIssueCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("updateIssue"),
      );
      expect(updateIssueCalls.length).toBe(1);

      // Verify closeIssue was called (state is "closed")
      const closeIssueCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("closeIssue"),
      );
      expect(closeIssueCalls.length).toBe(1);
    });

    it("[FR-CLI-013-AC3] 既存 task の implementer/reviewer を Issue body に同期する", async () => {
      const baseTask = makeTask("o/r#1", { github_issue: 1, body: "説明文" });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        body: "説明文",
        implementer: "alice",
        reviewer: "bob",
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: hashTask(baseTask),
            synced_at: "",
            syncFields: extractSyncFields(baseTask),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };
      let updateIssueVars: any;
      const mockGql = makeMockGql({
        updateIssue: (_query, vars) => {
          updateIssueVars = vars;
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.updated).toBe(1);
      expect(updateIssueVars.body).toContain("<!-- gh-gantt:roles:start -->");
      expect(updateIssueVars.body).toContain("Implementer: @alice");
      expect(updateIssueVars.body).toContain("Reviewer: @bob");
    });

    it("[FR-CLI-014-AC3] 既存 task の review requirement と approval を Issue body に同期する", async () => {
      const baseTask = makeTask("o/r#1", { github_issue: 1, body: "説明文" });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        body: "説明文",
        require_review: true,
        review_approved_by: "alice",
        review_approved_at: "2026-05-03T21:00:00.000Z",
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: hashTask(baseTask),
            synced_at: "",
            syncFields: extractSyncFields(baseTask),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };
      let updateIssueVars: any;
      const mockGql = makeMockGql({
        updateIssue: (_query, vars) => {
          updateIssueVars = vars;
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.updated).toBe(1);
      expect(updateIssueVars.body).toContain("<!-- gh-gantt:review:start -->");
      expect(updateIssueVars.body).toContain("Require-Review: true");
      expect(updateIssueVars.body).toContain("Review-Approved-By: @alice");
      expect(updateIssueVars.body).toContain("Review-Approved-At: 2026-05-03T21:00:00.000Z");
    });

    it("Organization Issue Type が設定された draft task は createIssue に issueTypeId を渡す", async () => {
      const draft = makeTask("o/r#draft-1", {
        type: "feature",
        title: "Feature task",
      });
      const tasksFile: TasksFile = {
        tasks: [draft],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {},
        field_ids: {},
        snapshots: {},
      };
      const config = makeConfig({
        task_types: {
          task: { label: "Task", display: "bar", color: "#000", github_label: null },
          feature: {
            label: "Feature",
            display: "bar",
            color: "#00f",
            github_label: null,
            github_issue_type: "Feature",
          },
        },
      });

      let createIssueVars: any;
      const mockGql = vi.fn().mockImplementation(async (query: string, vars?: any) => {
        if (query.includes("issueTypes")) {
          return {
            organization: {
              issueTypes: {
                nodes: [
                  {
                    id: "IT_FEATURE",
                    name: "Feature",
                    description: null,
                    isEnabled: true,
                  },
                ],
              },
            },
          };
        }
        if (query.includes("createIssue")) {
          createIssueVars = vars;
          return { createIssue: { issue: { id: "ISSUE_99", number: 99 } } };
        }
        if (query.includes("addProjectV2ItemById")) {
          return { addProjectV2ItemById: { item: { id: "ITEM_99" } } };
        }
        if (query.includes("labels") || query.includes("milestones")) {
          return {
            repository: { labels: { nodes: [] }, milestones: { nodes: [] } },
          };
        }
        if (query.includes("repository(")) {
          return { repository: { id: "REPO_1" } };
        }
        if (query.includes("issue(number:")) {
          return makeBatchIssueResponse(extractBatchIssueNumbers(query));
        }
        return {};
      });

      const { result } = await executePush(mockGql as any, config, tasksFile, syncState);

      expect(result.created).toBe(1);
      expect(createIssueVars.issueTypeId).toBe("IT_FEATURE");
    });

    it("既存 task の type 変更は Organization Issue Type を updateIssueIssueType で更新する", async () => {
      const before = makeTask("o/r#1", {
        github_issue: 1,
        type: "task",
        title: "Before",
      });
      const after = makeTask("o/r#1", {
        github_issue: 1,
        type: "feature",
        title: "Before",
      });
      const tasksFile: TasksFile = {
        tasks: [after],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: hashTask(before),
            synced_at: "",
            syncFields: extractSyncFields(before),
          },
        },
      };
      const config = makeConfig({
        task_types: {
          task: { label: "Task", display: "bar", color: "#000", github_label: null },
          feature: {
            label: "Feature",
            display: "bar",
            color: "#00f",
            github_label: null,
            github_issue_type: "Feature",
          },
        },
      });

      let updateIssueTypeVars: any;
      const fallbackGql = makeMockGql();
      const mockGql = vi.fn().mockImplementation(async (query: string, vars?: any) => {
        if (query.includes("issueTypes")) {
          return {
            organization: {
              issueTypes: {
                nodes: [
                  {
                    id: "IT_FEATURE",
                    name: "Feature",
                    description: null,
                    isEnabled: true,
                  },
                ],
              },
            },
          };
        }
        if (query.includes("updateIssueIssueType")) {
          updateIssueTypeVars = vars;
          return { updateIssueIssueType: { issue: { id: "ISSUE_1" } } };
        }
        return fallbackGql(query, vars);
      });

      const { result } = await executePush(mockGql as any, config, tasksFile, syncState);

      expect(result.updated).toBe(1);
      expect(updateIssueTypeVars.issueTypeId).toBe("IT_FEATURE");
    });

    it("Organization Issue Type が見つからない type 変更は snapshot を進めず次回 push で再試行できる", async () => {
      const before = makeTask("o/r#1", {
        github_issue: 1,
        type: "task",
        title: "Before",
      });
      const after = makeTask("o/r#1", {
        github_issue: 1,
        type: "feature",
        title: "Before",
      });
      const oldSyncFields = extractSyncFields(before);
      const tasksFile: TasksFile = {
        tasks: [after],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: hashTask(before),
            synced_at: "",
            syncFields: oldSyncFields,
          },
        },
      };
      const config = makeConfig({
        task_types: {
          task: { label: "Task", display: "bar", color: "#000", github_label: null },
          feature: {
            label: "Feature",
            display: "bar",
            color: "#00f",
            github_label: null,
            github_issue_type: "Feature",
          },
        },
      });

      let updateIssueTypeVars: any;
      const fallbackGql = makeMockGql();
      const mockGql = vi.fn().mockImplementation(async (query: string, vars?: any) => {
        if (query.includes("issueTypes")) {
          return {
            organization: {
              issueTypes: {
                nodes: [
                  {
                    id: "IT_BUG",
                    name: "Bug",
                    description: null,
                    isEnabled: true,
                  },
                ],
              },
            },
          };
        }
        if (query.includes("updateIssueIssueType")) {
          updateIssueTypeVars = vars;
          return { updateIssueIssueType: { issue: { id: "ISSUE_1" } } };
        }
        return fallbackGql(query, vars);
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          config,
          tasksFile,
          syncState,
        );

        const snap = newSyncState.snapshots["o/r#1"];
        expect(updateIssueTypeVars).toBeUndefined();
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.type).toBe(oldSyncFields.type);
        expect(snap!.hash).not.toBe(hashTask(after));

        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#1")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("snapshot updated_at is refreshed after push (Fix 1-1)", async () => {
      const task = makeTask("o/r#1", { github_issue: 1, title: "Modified" });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(
              makeTask("o/r#1", { github_issue: 1, title: "Original" }),
            ),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      // The stale check query returns matching updated_at, but post-push refresh returns new value
      let batchCallCount = 0;
      const mockGql = makeMockGql({
        batchUpdatedAt: () => {
          batchCallCount++;
          if (batchCallCount === 1) {
            // Stale check — matches snapshot so push proceeds
            return { repository: { i0: { number: 1, updatedAt: "2026-01-01T00:00:00Z" } } };
          }
          // Post-push refresh — new updated_at
          return { repository: { i0: { number: 1, updatedAt: "2026-04-01T00:00:00Z" } } };
        },
      });

      const { syncState: newSyncState } = await executePush(
        mockGql as any,
        makeConfig(),
        tasksFile,
        syncState,
      );

      expect(newSyncState.snapshots["o/r#1"]?.updated_at).toBe("2026-04-01T00:00:00Z");
    });

    it("[Issue #213] close push 後に state_reason と closed_at をローカルへ反映する", async () => {
      const oldUpdatedAt = "2026-01-01T00:00:00Z";
      const freshUpdatedAt = "2026-05-03T17:48:29Z";
      const closedAt = "2026-05-03T17:48:29Z";
      const task = makeTask("o/r#1", {
        github_issue: 1,
        state: "closed",
        state_reason: null,
        closed_at: null,
        updated_at: oldUpdatedAt,
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: hashTask(makeTask("o/r#1", { github_issue: 1, updated_at: oldUpdatedAt })),
            synced_at: "",
            syncFields: extractSyncFields(
              makeTask("o/r#1", { github_issue: 1, updated_at: oldUpdatedAt }),
            ),
            updated_at: oldUpdatedAt,
          },
        },
      };

      let batchCallCount = 0;
      const mockGql = makeMockGql({
        batchUpdatedAt: () => {
          batchCallCount++;
          if (batchCallCount === 1) {
            return {
              repository: {
                i0: { number: 1, updatedAt: oldUpdatedAt, stateReason: null, closedAt: null },
              },
            };
          }
          return {
            repository: {
              i0: {
                number: 1,
                updatedAt: freshUpdatedAt,
                stateReason: "COMPLETED",
                closedAt,
              },
            },
          };
        },
      });

      const { tasksFile: newTasksFile, syncState: newSyncState } = await executePush(
        mockGql as any,
        makeConfig(),
        tasksFile,
        syncState,
      );

      expect(newTasksFile.tasks[0]?.state_reason).toBe("COMPLETED");
      expect(newTasksFile.tasks[0]?.closed_at).toBe(closedAt);
      expect(newTasksFile.tasks[0]?.updated_at).toBe(freshUpdatedAt);
      expect(newSyncState.snapshots["o/r#1"]?.updated_at).toBe(freshUpdatedAt);
      expect(newSyncState.snapshots["o/r#1"]?.syncFields?.state).toBe("closed");
      expect(computeLocalDiff(newTasksFile.tasks, newSyncState)).toEqual([]);
    });

    it("field updates skipped when project_item_id is missing (Fix 1-3)", async () => {
      const task = makeTask("o/r#1", {
        github_issue: 1,
        start_date: "2026-04-01",
        end_date: "2026-04-10",
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          // Has issue_node_id but NO project_item_id
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1" } as any,
        },
        field_ids: { "Start Date": "FIELD_START", "End Date": "FIELD_END" },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql();
      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.updated).toBe(1);

      // Verify updateProjectV2ItemFieldValue was NOT called
      const fieldUpdateCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("updateProjectV2ItemFieldValue"),
      );
      expect(fieldUpdateCalls.length).toBe(0);

      // But updateIssue and state change WERE called
      const updateIssueCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("updateIssue"),
      );
      expect(updateIssueCalls.length).toBe(1);
    });

    it("relationships synced when syncFields is missing (Fix 1-4)", async () => {
      const parentTask = makeTask("o/r#10", { github_issue: 10 });
      const blockerTask = makeTask("o/r#20", { github_issue: 20 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#10",
        blocked_by: [{ task: "o/r#20", type: "finish-to-start", lag: 0 }],
      });
      const tasksFile: TasksFile = {
        tasks: [parentTask, blockerTask, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#10": { issue_number: 10, issue_node_id: "ISSUE_10", project_item_id: "ITEM_10" },
          "o/r#20": { issue_number: 20, issue_node_id: "ISSUE_20", project_item_id: "ITEM_20" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            // syncFields exists but has NO parent or blocked_by keys (simulating missing syncFields)
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#10": {
            hash: hashTask(parentTask),
            synced_at: "",
            syncFields: extractSyncFields(parentTask),
          },
          "o/r#20": {
            hash: hashTask(blockerTask),
            synced_at: "",
            syncFields: extractSyncFields(blockerTask),
          },
        },
      };

      const mockGql = makeMockGql();
      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.updated).toBe(1);

      // Verify addSubIssue was called
      const addSubIssueCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("addSubIssue"),
      );
      expect(addSubIssueCalls.length).toBe(1);

      // Verify addBlockedBy was called
      const addBlockedByCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("addBlockedBy"),
      );
      expect(addBlockedByCalls.length).toBe(1);
    });

    it("warns on relationship mutation failure (Fix 1-5)", async () => {
      const parentTask = makeTask("o/r#10", { github_issue: 10 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#10",
      });
      const tasksFile: TasksFile = {
        tasks: [parentTask, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#10": { issue_number: 10, issue_node_id: "ISSUE_10", project_item_id: "ITEM_10" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#10": {
            hash: hashTask(parentTask),
            synced_at: "",
            syncFields: extractSyncFields(parentTask),
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const mockGql = makeMockGql({
          addSubIssue: () => {
            throw new Error("sub-issue API error");
          },
        });

        const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

        expect(result.updated).toBe(1);
        expect(warnSpy).toHaveBeenCalled();
        const warnMessage = warnSpy.mock.calls.find((c) => (c[0] as string).includes("sub-issue"));
        expect(warnMessage).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("force flag bypasses stale check", async () => {
      const task = makeTask("o/r#1", { github_issue: 1, title: "Modified" });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(
              makeTask("o/r#1", { github_issue: 1, title: "Original" }),
            ),
            // Remote has a DIFFERENT updated_at than what GitHub would return
            updated_at: "2025-12-01T00:00:00Z",
          },
        },
      };

      // Mock GQL returns a different updatedAt than snapshot — would normally fail stale check
      const mockGql = makeMockGql({
        batchUpdatedAt: () => ({
          repository: { i0: { number: 1, updatedAt: "2026-03-01T00:00:00Z" } },
        }),
      });

      // With force: true, push should succeed
      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState, {
        force: true,
      });

      expect(result.updated).toBe(1);

      // Verify no stale-check query was made (the only batch query should be post-push refresh)
      const batchQueries = mockGql.mock.calls.filter(
        (c: any[]) =>
          (c[0] as string).includes("issue(number:") && !(c[0] as string).includes("mutation"),
      );
      // Only post-push refresh query, no stale check
      expect(batchQueries.length).toBe(1);
    });

    it("multiple field updates work correctly", async () => {
      const task = makeTask("o/r#1", {
        github_issue: 1,
        start_date: "2026-04-01",
        end_date: "2026-04-15",
        type: "feature",
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };

      const config = makeConfig({
        sync: {
          auto_create_issues: true,
          field_mapping: {
            start_date: "Start Date",
            end_date: "End Date",
            status: "Status",
            type: "Type",
          },
        },
        task_types: {
          feature: {
            label: "feature",
            github_field_value: "Feature",
          },
        },
      } as any);

      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {
          "Start Date": "FIELD_START",
          "End Date": "FIELD_END",
          Type: "FIELD_TYPE",
        },
        option_ids: {
          Type: { Feature: "OPT_FEATURE" },
        },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql();
      const { result } = await executePush(mockGql as any, config, tasksFile, syncState);

      expect(result.updated).toBe(1);

      // Verify updateProjectV2ItemFieldValue was called for start_date, end_date, and type
      const fieldUpdateCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("updateProjectV2ItemFieldValue"),
      );
      expect(fieldUpdateCalls.length).toBe(3);

      // Verify the field IDs used
      const fieldIds = fieldUpdateCalls.map((c: any[]) => c[1]?.fieldId);
      expect(fieldIds).toContain("FIELD_START");
      expect(fieldIds).toContain("FIELD_END");
      expect(fieldIds).toContain("FIELD_TYPE");
    });

    it("push is rejected when remote updated_at differs (stale check)", async () => {
      const task = makeTask("o/r#1", { github_issue: 1, title: "Modified" });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(
              makeTask("o/r#1", { github_issue: 1, title: "Original" }),
            ),
            updated_at: "2025-12-01T00:00:00Z",
          },
        },
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const mockGql = makeMockGql({
          batchUpdatedAt: () => ({
            repository: { i0: { number: 1, updatedAt: "2026-03-01T00:00:00Z" } },
          }),
        });

        const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

        expect(result.updated).toBe(0);
        expect(result.created).toBe(0);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("リモートが更新されています"),
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("deleted tasks are skipped", async () => {
      const task = makeTask("o/r#1", { github_issue: 1 });
      const hash = hashTask(task);
      const tasksFile: TasksFile = {
        tasks: [], // task removed locally
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": { hash, synced_at: "", syncFields: extractSyncFields(task) },
        },
      };

      const mockGql = makeMockGql();
      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);
      expect(mockGql).not.toHaveBeenCalled();
    });

    it("parent change triggers removeSubIssue then addSubIssue", async () => {
      const oldParent = makeTask("o/r#10", { github_issue: 10 });
      const newParent = makeTask("o/r#20", { github_issue: 20 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#20", // changed from o/r#10 to o/r#20
      });
      const tasksFile: TasksFile = {
        tasks: [oldParent, newParent, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#10": { issue_number: 10, issue_node_id: "ISSUE_10", project_item_id: "ITEM_10" },
          "o/r#20": { issue_number: 20, issue_node_id: "ISSUE_20", project_item_id: "ITEM_20" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1, parent: "o/r#10" })),
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#10": {
            hash: hashTask(oldParent),
            synced_at: "",
            syncFields: extractSyncFields(oldParent),
          },
          "o/r#20": {
            hash: hashTask(newParent),
            synced_at: "",
            syncFields: extractSyncFields(newParent),
          },
        },
      };

      const mockGql = makeMockGql();
      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      const removeCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("removeSubIssue"),
      );
      const addCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("addSubIssue"),
      );
      expect(removeCalls.length).toBe(1);
      expect(addCalls.length).toBe(1);

      // Verify correct parent node IDs: remove from old parent (ISSUE_10), add to new parent (ISSUE_20)
      expect(removeCalls[0][1]?.issueId).toBe("ISSUE_10");
      expect(addCalls[0][1]?.issueId).toBe("ISSUE_20");
    });

    it("blocked_by removal triggers removeBlockedByIssue", async () => {
      const blocker = makeTask("o/r#5", { github_issue: 5 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        blocked_by: [], // removed blocker
      });
      const tasksFile: TasksFile = {
        tasks: [blocker, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#5": { issue_number: 5, issue_node_id: "ISSUE_5", project_item_id: "ITEM_5" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(
              makeTask("o/r#1", {
                github_issue: 1,
                blocked_by: [{ task: "o/r#5", type: "finish-to-start", lag: 0 }],
              }),
            ),
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#5": {
            hash: hashTask(blocker),
            synced_at: "",
            syncFields: extractSyncFields(blocker),
          },
        },
      };

      const mockGql = makeMockGql();
      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      const removeCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("removeBlockedBy"),
      );
      expect(removeCalls.length).toBe(1);
    });

    it("priority field is synced via syncPriorityField", async () => {
      const task = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { Priority: "High" },
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const config = makeConfig({
        sync: {
          auto_create_issues: true,
          field_mapping: {
            start_date: "Start Date",
            end_date: "End Date",
            status: "Status",
            priority: "Priority",
          },
        },
      } as any);
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: { Priority: "FIELD_PRIORITY" },
        option_ids: { Priority: { High: "OPT_HIGH" } },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql();
      await executePush(mockGql as any, config, tasksFile, syncState);

      const fieldUpdateCalls = mockGql.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes("updateProjectV2ItemFieldValue"),
      );
      // Priority should be one of the field updates
      const priorityCall = fieldUpdateCalls.find((c: any[]) => c[1]?.fieldId === "FIELD_PRIORITY");
      expect(priorityCall).toBeDefined();
    });

    it("updateIssue and setIssueState run in parallel", async () => {
      const concurrency: string[] = [];
      const task = makeTask("o/r#1", { github_issue: 1, title: "Modified", state: "closed" });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(
              makeTask("o/r#1", { github_issue: 1, title: "Original" }),
            ),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql({
        updateIssue: async () => {
          concurrency.push("updateIssue:start");
          await new Promise((r) => setTimeout(r, 10));
          concurrency.push("updateIssue:end");
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
        closeIssue: async () => {
          concurrency.push("closeIssue:start");
          await new Promise((r) => setTimeout(r, 10));
          concurrency.push("closeIssue:end");
          return { closeIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      // Both should start before either ends (parallel execution)
      const updateStart = concurrency.indexOf("updateIssue:start");
      const closeStart = concurrency.indexOf("closeIssue:start");
      const updateEnd = concurrency.indexOf("updateIssue:end");
      const closeEnd = concurrency.indexOf("closeIssue:end");
      expect(updateStart).toBeLessThan(updateEnd);
      expect(closeStart).toBeLessThan(closeEnd);
      // Both start before either finishes
      expect(Math.max(updateStart, closeStart)).toBeLessThan(Math.min(updateEnd, closeEnd));
    });

    it("field updates run in parallel", async () => {
      const concurrency: string[] = [];
      const task = makeTask("o/r#1", {
        github_issue: 1,
        start_date: "2026-04-01",
        end_date: "2026-04-15",
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: { "Start Date": "FIELD_START", "End Date": "FIELD_END" },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql({
        updateProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          const fieldId = vars?.fieldId ?? "unknown";
          concurrency.push(`field:${fieldId}:start`);
          await new Promise((r) => setTimeout(r, 10));
          concurrency.push(`field:${fieldId}:end`);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      const startIdx = concurrency.indexOf("field:FIELD_START:start");
      const endStartIdx = concurrency.indexOf("field:FIELD_END:start");
      const startEndIdx = concurrency.indexOf("field:FIELD_START:end");
      const endEndIdx = concurrency.indexOf("field:FIELD_END:end");
      expect(Math.max(startIdx, endStartIdx)).toBeLessThan(Math.min(startEndIdx, endEndIdx));
    });

    it("[FR-CLI-015-AC3] estimate_hours は既定 field key でも number custom field を同期する", async () => {
      const fieldUpdates: any[] = [];
      const task = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { estimate_hours: 13 },
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: { estimate_hours: "FIELD_ESTIMATE" },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };
      const config = makeConfig();

      const mockGql = makeMockGql({
        updateProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          fieldUpdates.push(vars);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      });

      await executePush(mockGql as any, config, tasksFile, syncState);

      expect(fieldUpdates).toContainEqual(
        expect.objectContaining({
          fieldId: "FIELD_ESTIMATE",
          value: { number: 13 },
        }),
      );
    });

    it("[FR-CLI-015-AC3] estimate_hours が削除された場合は number custom field を clear する", async () => {
      const clearedFields: any[] = [];
      const task = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: {},
      });
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { estimate_hours: 13 },
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: { estimate_hours: "FIELD_ESTIMATE" },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(previousTask),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql({
        clearProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          clearedFields.push(vars);
          return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(clearedFields).toContainEqual(
        expect.objectContaining({
          fieldId: "FIELD_ESTIMATE",
        }),
      );
    });

    it("[FR-SYNC-003-AC4] start_date / end_date が null 化された場合は date フィールドを clear する", async () => {
      const clearedFields: any[] = [];
      const updatedFields: any[] = [];
      // ローカルでは両方の日付が none 指定で null 化されている
      const task = makeTask("o/r#1", {
        github_issue: 1,
        start_date: null,
        end_date: null,
      });
      // snapshot (前回同期時) には日付が設定されていた
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        start_date: "2026-07-01",
        end_date: "2026-07-31",
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
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

      const mockGql = makeMockGql({
        updateProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          updatedFields.push(vars);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
        clearProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          clearedFields.push(vars);
          return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      // 両方の日付フィールドがクリアされる
      expect(clearedFields).toContainEqual(expect.objectContaining({ fieldId: "FIELD_START" }));
      expect(clearedFields).toContainEqual(expect.objectContaining({ fieldId: "FIELD_END" }));
      // updateProjectV2ItemFieldValue で日付が送信されることはない
      expect(updatedFields).not.toContainEqual(expect.objectContaining({ fieldId: "FIELD_START" }));
      expect(updatedFields).not.toContainEqual(expect.objectContaining({ fieldId: "FIELD_END" }));
    });

    it("[FR-SYNC-003-AC4] 空文字の日付はクリア意図として扱い、GraphQL に日付として送らない", async () => {
      const clearedFields: any[] = [];
      const updatedFields: any[] = [];
      // 空文字は Zod 検証を通らない不正値だが、防御的にクリア意図へ正規化する契約を固定する
      const task = makeTask("o/r#1", {
        github_issue: 1,
        start_date: "" as unknown as string,
        end_date: null,
      });
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        start_date: "2026-07-01",
        end_date: null,
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
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

      const mockGql = makeMockGql({
        updateProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          updatedFields.push(vars);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
        clearProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          clearedFields.push(vars);
          return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      // 空文字はクリアとして送信され、update で "" が日付として送られることはない
      expect(clearedFields).toContainEqual(expect.objectContaining({ fieldId: "FIELD_START" }));
      expect(updatedFields).not.toContainEqual(expect.objectContaining({ fieldId: "FIELD_START" }));
    });

    it("[FR-SYNC-003-AC4] 以前から null の日付フィールドには clear を呼ばない", async () => {
      const clearedFields: any[] = [];
      // タイトルだけ変更し、日付は以前も現在も null のまま
      const task = makeTask("o/r#1", {
        github_issue: 1,
        title: "更新後のタイトル",
      });
      const previousTask = makeTask("o/r#1", { github_issue: 1 });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: { "Start Date": "FIELD_START", "End Date": "FIELD_END" },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(previousTask),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql({
        clearProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          clearedFields.push(vars);
          return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      // 以前から null → クリアは不要 (無駄な API コールを増やさない)
      expect(clearedFields).toEqual([]);
    });

    it("[FR-SYNC-003-AC4] 日付に値がある場合は従来どおり update で送信する", async () => {
      const fieldUpdates: any[] = [];
      const task = makeTask("o/r#1", {
        github_issue: 1,
        start_date: "2026-07-01",
        end_date: "2026-07-31",
      });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: { "Start Date": "FIELD_START", "End Date": "FIELD_END" },
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const mockGql = makeMockGql({
        updateProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          fieldUpdates.push(vars);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(fieldUpdates).toContainEqual(
        expect.objectContaining({ fieldId: "FIELD_START", value: { date: "2026-07-01" } }),
      );
      expect(fieldUpdates).toContainEqual(
        expect.objectContaining({ fieldId: "FIELD_END", value: { date: "2026-07-31" } }),
      );
    });

    it("blocker mutations run in parallel", async () => {
      const concurrency: string[] = [];
      const blocker1 = makeTask("o/r#5", { github_issue: 5 });
      const blocker2 = makeTask("o/r#6", { github_issue: 6 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        blocked_by: [
          { task: "o/r#5", type: "finish-to-start" as const, lag: 0 },
          { task: "o/r#6", type: "finish-to-start" as const, lag: 0 },
        ],
      });
      const tasksFile: TasksFile = {
        tasks: [blocker1, blocker2, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#5": { issue_number: 5, issue_node_id: "ISSUE_5", project_item_id: "ITEM_5" },
          "o/r#6": { issue_number: 6, issue_node_id: "ISSUE_6", project_item_id: "ITEM_6" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#5": {
            hash: hashTask(blocker1),
            synced_at: "",
            syncFields: extractSyncFields(blocker1),
          },
          "o/r#6": {
            hash: hashTask(blocker2),
            synced_at: "",
            syncFields: extractSyncFields(blocker2),
          },
        },
      };

      const mockGql = makeMockGql({
        addBlockedBy: async (_q: string, vars: any) => {
          const id = vars?.blockingIssueId ?? "unknown";
          concurrency.push(`addBlockedBy:${id}:start`);
          await new Promise((r) => setTimeout(r, 10));
          concurrency.push(`addBlockedBy:${id}:end`);
          return { addIssueRelation: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      const start5 = concurrency.indexOf("addBlockedBy:ISSUE_5:start");
      const start6 = concurrency.indexOf("addBlockedBy:ISSUE_6:start");
      const end5 = concurrency.indexOf("addBlockedBy:ISSUE_5:end");
      const end6 = concurrency.indexOf("addBlockedBy:ISSUE_6:end");
      expect(Math.max(start5, start6)).toBeLessThan(Math.min(end5, end6));
    });
  });

  describe("[FR-SYNC-003-AC5] 既存 Issue の assignees / labels / milestone の変更を push で反映できる", () => {
    /** 既存 Issue 1 件 (o/r#1) の snapshot を previousTask の状態で構築する */
    function makeUpdateSyncState(previousTask: Task): SyncState {
      return {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
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

    function makeTasksFile(task: Task): TasksFile {
      return { tasks: [task], cache: { comments: {}, reactions: {} } };
    }

    /** labelMap: bug/feature, milestoneMap: v1.0 を返す repository metadata handler */
    const repositoryMetadataHandler = async () => ({
      repository: {
        labels: {
          nodes: [
            { id: "LABEL_BUG", name: "bug" },
            { id: "LABEL_FEATURE", name: "feature" },
          ],
        },
        milestones: { nodes: [{ id: "MS_1", title: "v1.0", number: 1 }] },
      },
    });

    it("labels の変更は labelIds に解決して updateIssue で送信する", async () => {
      const updateIssueVars: any[] = [];
      const previousTask = makeTask("o/r#1", { github_issue: 1, labels: ["bug"] });
      const task = makeTask("o/r#1", { github_issue: 1, labels: ["bug", "feature"] });

      const mockGql = makeMockGql({
        repositoryMetadata: repositoryMetadataHandler,
        updateIssue: async (_q: string, vars: any) => {
          updateIssueVars.push(vars);
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(
        mockGql as any,
        makeConfig(),
        makeTasksFile(task),
        makeUpdateSyncState(previousTask),
      );

      // 置換セマンティクス: ローカルの labels 全体が labelIds として送信される
      expect(updateIssueVars).toHaveLength(1);
      expect(updateIssueVars[0].labelIds).toEqual(["LABEL_BUG", "LABEL_FEATURE"]);
    });

    it("assignees の変更は assigneeIds に解決して updateIssue で送信する", async () => {
      const updateIssueVars: any[] = [];
      const previousTask = makeTask("o/r#1", { github_issue: 1, assignees: [] });
      const task = makeTask("o/r#1", { github_issue: 1, assignees: ["alice"] });

      const mockGql = makeMockGql({
        userIds: async () => ({ u0: { id: "USER_ALICE", login: "alice" } }),
        updateIssue: async (_q: string, vars: any) => {
          updateIssueVars.push(vars);
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(
        mockGql as any,
        makeConfig(),
        makeTasksFile(task),
        makeUpdateSyncState(previousTask),
      );

      expect(updateIssueVars).toHaveLength(1);
      expect(updateIssueVars[0].assigneeIds).toEqual(["USER_ALICE"]);
    });

    it("labels / assignees の空配列化は全削除として空の ID 配列を送信する", async () => {
      const updateIssueVars: any[] = [];
      let metadataFetchCount = 0;
      // 以前は labels / assignees が設定されていた
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        labels: ["bug"],
        assignees: ["alice"],
      });
      // ローカルで両方とも空にした = 全削除の意図
      const task = makeTask("o/r#1", { github_issue: 1, labels: [], assignees: [] });

      const mockGql = makeMockGql({
        repositoryMetadata: async () => {
          metadataFetchCount++;
          return repositoryMetadataHandler();
        },
        updateIssue: async (_q: string, vars: any) => {
          updateIssueVars.push(vars);
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(
        mockGql as any,
        makeConfig(),
        makeTasksFile(task),
        makeUpdateSyncState(previousTask),
      );

      // 空配列が silent no-op に退行せず、全削除として明示送信されることを固定する
      expect(updateIssueVars).toHaveLength(1);
      expect(updateIssueVars[0].labelIds).toEqual([]);
      expect(updateIssueVars[0].assigneeIds).toEqual([]);
      // 全削除は ID 解決が不要であり、metadata fetch の失敗に巻き込まれない
      expect(metadataFetchCount).toBe(0);
    });

    it("milestone の変更は milestoneId に解決して updateIssue で送信する", async () => {
      const updateIssueVars: any[] = [];
      const previousTask = makeTask("o/r#1", { github_issue: 1, milestone: null });
      const task = makeTask("o/r#1", { github_issue: 1, milestone: "v1.0" });

      const mockGql = makeMockGql({
        repositoryMetadata: repositoryMetadataHandler,
        updateIssue: async (_q: string, vars: any) => {
          updateIssueVars.push(vars);
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(
        mockGql as any,
        makeConfig(),
        makeTasksFile(task),
        makeUpdateSyncState(previousTask),
      );

      expect(updateIssueVars).toHaveLength(1);
      expect(updateIssueVars[0].milestoneId).toBe("MS_1");
    });

    it("milestone のローカル null 化は milestoneId: null で解除として送信する", async () => {
      const updateIssueVars: any[] = [];
      const previousTask = makeTask("o/r#1", { github_issue: 1, milestone: "v1.0" });
      const task = makeTask("o/r#1", { github_issue: 1, milestone: null });

      const mockGql = makeMockGql({
        repositoryMetadata: repositoryMetadataHandler,
        updateIssue: async (_q: string, vars: any) => {
          updateIssueVars.push(vars);
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(
        mockGql as any,
        makeConfig(),
        makeTasksFile(task),
        makeUpdateSyncState(previousTask),
      );

      // null は「未指定」ではなく「解除」として明示的に送信される
      expect(updateIssueVars).toHaveLength(1);
      expect(updateIssueVars[0]).toHaveProperty("milestoneId", null);
    });

    it("metadata に差分がない場合はフィールドを送信せず metadata の fetch も行わない", async () => {
      const updateIssueVars: any[] = [];
      let metadataFetchCount = 0;
      let userIdsFetchCount = 0;
      // assignees / labels / milestone は同一のままタイトルだけ変更する
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        assignees: ["alice"],
        labels: ["bug"],
        milestone: "v1.0",
      });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        title: "更新後のタイトル",
        assignees: ["alice"],
        labels: ["bug"],
        milestone: "v1.0",
      });

      const mockGql = makeMockGql({
        repositoryMetadata: async () => {
          metadataFetchCount++;
          return repositoryMetadataHandler();
        },
        userIds: async () => {
          userIdsFetchCount++;
          return {};
        },
        updateIssue: async (_q: string, vars: any) => {
          updateIssueVars.push(vars);
          return { updateIssue: { issue: { id: "ISSUE_1" } } };
        },
      });

      await executePush(
        mockGql as any,
        makeConfig(),
        makeTasksFile(task),
        makeUpdateSyncState(previousTask),
      );

      // 差分がないフィールドは UpdateIssueInput に含めない (不要な置換を避ける)
      expect(updateIssueVars).toHaveLength(1);
      expect(updateIssueVars[0]).not.toHaveProperty("assigneeIds");
      expect(updateIssueVars[0]).not.toHaveProperty("labelIds");
      expect(updateIssueVars[0]).not.toHaveProperty("milestoneId");
      // metadata 変更がない push では fetch 自体を行わない (NFR-SYNC-002)
      expect(metadataFetchCount).toBe(0);
      expect(userIdsFetchCount).toBe(0);
    });

    it("未解決の label 名があるフィールドは送信をスキップして警告し、snapshot を旧値に留めて再試行できる", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const updateIssueVars: any[] = [];
        const previousTask = makeTask("o/r#1", { github_issue: 1, labels: ["bug"] });
        const task = makeTask("o/r#1", {
          github_issue: 1,
          labels: ["bug", "unknown-label"],
        });
        const tasksFile = makeTasksFile(task);

        const mockGql = makeMockGql({
          repositoryMetadata: repositoryMetadataHandler,
          updateIssue: async (_q: string, vars: any) => {
            updateIssueVars.push(vars);
            return { updateIssue: { issue: { id: "ISSUE_1" } } };
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          makeUpdateSyncState(previousTask),
        );

        // labelIds は送信されない (silent drop で unknown-label 以外まで剥がさない)
        expect(updateIssueVars).toHaveLength(1);
        expect(updateIssueVars[0]).not.toHaveProperty("labelIds");
        // 警告が出る
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("label が解決できない"));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown-label"));
        // snapshot は旧値に留まり、次回 push で再試行される
        expect(newSyncState.snapshots["o/r#1"].syncFields?.labels).toEqual(["bug"]);
        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs).toContainEqual(
          expect.objectContaining({ id: "o/r#1", type: "modified" }),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("未解決の assignee があっても labels など解決できたフィールドは送信される", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const updateIssueVars: any[] = [];
        const previousTask = makeTask("o/r#1", { github_issue: 1 });
        const task = makeTask("o/r#1", {
          github_issue: 1,
          assignees: ["ghost"],
          labels: ["bug"],
        });

        const mockGql = makeMockGql({
          repositoryMetadata: repositoryMetadataHandler,
          userIds: async () => ({}),
          updateIssue: async (_q: string, vars: any) => {
            updateIssueVars.push(vars);
            return { updateIssue: { issue: { id: "ISSUE_1" } } };
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          makeTasksFile(task),
          makeUpdateSyncState(previousTask),
        );

        expect(updateIssueVars).toHaveLength(1);
        // 未解決の assignees だけスキップされ、labels は送信される
        expect(updateIssueVars[0]).not.toHaveProperty("assigneeIds");
        expect(updateIssueVars[0].labelIds).toEqual(["LABEL_BUG"]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("assignee が解決できない"));
        // snapshot は assignees だけ旧値に留まり、labels は新値へ進む
        expect(newSyncState.snapshots["o/r#1"].syncFields?.assignees).toEqual([]);
        expect(newSyncState.snapshots["o/r#1"].syncFields?.labels).toEqual(["bug"]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("未解決の milestone 名は milestone の更新をスキップして警告する", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const updateIssueVars: any[] = [];
        const previousTask = makeTask("o/r#1", { github_issue: 1, milestone: null });
        const task = makeTask("o/r#1", { github_issue: 1, milestone: "no-such-milestone" });

        const mockGql = makeMockGql({
          repositoryMetadata: repositoryMetadataHandler,
          updateIssue: async (_q: string, vars: any) => {
            updateIssueVars.push(vars);
            return { updateIssue: { issue: { id: "ISSUE_1" } } };
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          makeTasksFile(task),
          makeUpdateSyncState(previousTask),
        );

        expect(updateIssueVars).toHaveLength(1);
        expect(updateIssueVars[0]).not.toHaveProperty("milestoneId");
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("milestone が解決できない"));
        // snapshot の milestone は旧値 (null) に留まる
        expect(newSyncState.snapshots["o/r#1"].syncFields?.milestone).toBeNull();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("[FR-SYNC-003-AC6] Status フィールドの変更を push で ProjectV2 に反映できる", () => {
    /** Status フィールドの field_ids / option_ids を持つ既存 Issue 1 件の syncState を構築する */
    function makeStatusSyncState(previousTask: Task): SyncState {
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

    function makeStatusTasksFile(task: Task): TasksFile {
      return { tasks: [task], cache: { comments: {}, reactions: {} } };
    }

    /** updateProjectV2ItemFieldValue / clearProjectV2ItemFieldValue の呼び出し変数を記録する handlers */
    function makeFieldRecorder(recorded: { updated: any[]; cleared: any[] }) {
      return {
        updateProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          recorded.updated.push(vars);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
        clearProjectV2ItemFieldValue: async (_q: string, vars: any) => {
          recorded.cleared.push(vars);
          return { clearProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        },
      };
    }

    it("Status の変更は singleSelectOptionId に解決して updateProjectV2ItemFieldValue で送信する", async () => {
      const recorded = { updated: [] as any[], cleared: [] as any[] };
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { Status: "Todo" },
      });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { Status: "In Progress" },
      });

      const mockGql = makeMockGql(makeFieldRecorder(recorded));
      await executePush(
        mockGql as any,
        makeConfig(),
        makeStatusTasksFile(task),
        makeStatusSyncState(previousTask),
      );

      expect(recorded.updated).toContainEqual(
        expect.objectContaining({
          fieldId: "FIELD_STATUS",
          value: { singleSelectOptionId: "OPT_IN_PROGRESS" },
        }),
      );
    });

    it("Status に差分がなければ Status フィールドの update を送信しない (偽 push の回避)", async () => {
      const recorded = { updated: [] as any[], cleared: [] as any[] };
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

      const mockGql = makeMockGql(makeFieldRecorder(recorded));
      await executePush(
        mockGql as any,
        makeConfig(),
        makeStatusTasksFile(task),
        makeStatusSyncState(previousTask),
      );

      expect(recorded.updated).not.toContainEqual(
        expect.objectContaining({ fieldId: "FIELD_STATUS" }),
      );
      expect(recorded.cleared).not.toContainEqual(
        expect.objectContaining({ fieldId: "FIELD_STATUS" }),
      );
    });

    it("Status の null 化 (以前の値あり) は clearProjectV2ItemFieldValue でクリアする", async () => {
      const recorded = { updated: [] as any[], cleared: [] as any[] };
      const previousTask = makeTask("o/r#1", {
        github_issue: 1,
        custom_fields: { Status: "Todo" },
      });
      // 3-way merge 等でローカルの Status キーが失われた状態
      const task = makeTask("o/r#1", { github_issue: 1, custom_fields: {} });

      const mockGql = makeMockGql(makeFieldRecorder(recorded));
      await executePush(
        mockGql as any,
        makeConfig(),
        makeStatusTasksFile(task),
        makeStatusSyncState(previousTask),
      );

      expect(recorded.cleared).toContainEqual(expect.objectContaining({ fieldId: "FIELD_STATUS" }));
    });

    it("未解決の Status 値は送信をスキップして警告し、snapshot の Status を旧値に留める", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const recorded = { updated: [] as any[], cleared: [] as any[] };
        const previousTask = makeTask("o/r#1", {
          github_issue: 1,
          custom_fields: { Status: "Todo" },
        });
        const task = makeTask("o/r#1", {
          github_issue: 1,
          custom_fields: { Status: "no-such-status" },
        });

        const mockGql = makeMockGql(makeFieldRecorder(recorded));
        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          makeStatusTasksFile(task),
          makeStatusSyncState(previousTask),
        );

        // Status の update / clear は送信されない
        expect(recorded.updated).not.toContainEqual(
          expect.objectContaining({ fieldId: "FIELD_STATUS" }),
        );
        expect(recorded.cleared).not.toContainEqual(
          expect.objectContaining({ fieldId: "FIELD_STATUS" }),
        );
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("option として解決できない"));
        // snapshot の Status は旧値に留まり、次回 push で差分として再検出される
        expect(newSyncState.snapshots["o/r#1"].syncFields?.custom_fields).toEqual({
          Status: "Todo",
        });
        const retryDiffs = computeLocalDiff([task], newSyncState);
        expect(retryDiffs).toContainEqual(
          expect.objectContaining({ id: "o/r#1", type: "modified" }),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("draft 新規作成経路でも Status が設定されていれば作成直後に送信する", async () => {
      const recorded: any[] = [];
      const draft = makeTask("o/r#draft-1", {
        custom_fields: { Status: "In Progress" },
      });
      const tasksFile: TasksFile = {
        tasks: [draft],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {},
        field_ids: { Status: "FIELD_STATUS" },
        option_ids: { Status: { "In Progress": "OPT_IN_PROGRESS" } },
        snapshots: {},
      };

      const mockGql = vi.fn().mockImplementation(async (query: string, vars?: any) => {
        if (query.includes("createIssue")) {
          return { createIssue: { issue: { id: "ISSUE_99", number: 99 } } };
        }
        if (query.includes("addProjectV2ItemById")) {
          return { addProjectV2ItemById: { item: { id: "ITEM_99" } } };
        }
        if (query.includes("updateProjectV2ItemFieldValue")) {
          recorded.push(vars);
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_99" } } };
        }
        if (query.includes("labels") || query.includes("milestones")) {
          return { repository: { labels: { nodes: [] }, milestones: { nodes: [] } } };
        }
        if (query.includes("repository(")) {
          return { repository: { id: "REPO_1" } };
        }
        if (query.includes("issue(number:")) {
          return makeBatchIssueResponse(extractBatchIssueNumbers(query));
        }
        return {};
      });

      const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

      expect(result.created).toBe(1);
      expect(recorded).toContainEqual(
        expect.objectContaining({
          itemId: "ITEM_99",
          fieldId: "FIELD_STATUS",
          value: { singleSelectOptionId: "OPT_IN_PROGRESS" },
        }),
      );
    });
  });

  describe("[NFR-SYNC-001-AC1] push 中に API エラーが発生しても snapshot が不整合にならない", () => {
    it("relation failure preserves old syncFields and enables retry via computeLocalDiff", async () => {
      const parentTask = makeTask("o/r#10", { github_issue: 10 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#10",
      });
      const oldSyncFields = extractSyncFields(makeTask("o/r#1", { github_issue: 1 }));
      const tasksFile: TasksFile = {
        tasks: [parentTask, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#10": { issue_number: 10, issue_node_id: "ISSUE_10", project_item_id: "ITEM_10" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: oldSyncFields,
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#10": {
            hash: hashTask(parentTask),
            synced_at: "",
            syncFields: extractSyncFields(parentTask),
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const mockGql = makeMockGql({
          addSubIssue: () => {
            throw new Error("sub-issue API error");
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
        );

        // Snapshot should preserve old parent (null) instead of new parent ("o/r#10")
        const snap = newSyncState.snapshots["o/r#1"];
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.parent).toBe(oldSyncFields.parent);

        // Hash must differ from hashTask(task) so computeLocalDiff detects the diff for retry
        expect(snap!.hash).not.toBe(hashTask(task));
        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#1")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("successful relation does not preserve old syncFields", async () => {
      const parentTask = makeTask("o/r#10", { github_issue: 10 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#10",
      });
      const tasksFile: TasksFile = {
        tasks: [parentTask, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#10": { issue_number: 10, issue_node_id: "ISSUE_10", project_item_id: "ITEM_10" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#10": {
            hash: hashTask(parentTask),
            synced_at: "",
            syncFields: extractSyncFields(parentTask),
          },
        },
      };

      const mockGql = makeMockGql();
      const { syncState: newSyncState } = await executePush(
        mockGql as any,
        makeConfig(),
        tasksFile,
        syncState,
      );

      // Snapshot should reflect new parent
      const snap = newSyncState.snapshots["o/r#1"];
      expect(snap).toBeDefined();
      expect(snap!.syncFields?.parent).toBe("o/r#10");

      // No diff should remain — relation was fully synced
      const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
      expect(retryDiffs.some((d) => d.id === "o/r#1")).toBe(false);
    });

    it("blocked_by failure preserves old syncFields.blocked_by and enables retry", async () => {
      const blocker = makeTask("o/r#5", { github_issue: 5 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        blocked_by: [{ task: "o/r#5", type: "finish-to-start" as const, lag: 0 }],
      });
      const tasksFile: TasksFile = {
        tasks: [blocker, task],
        cache: { comments: {}, reactions: {} },
      };
      const oldSyncFields = extractSyncFields(makeTask("o/r#1", { github_issue: 1 }));
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#5": { issue_number: 5, issue_node_id: "ISSUE_5", project_item_id: "ITEM_5" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: oldSyncFields,
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#5": {
            hash: hashTask(blocker),
            synced_at: "",
            syncFields: extractSyncFields(blocker),
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const mockGql = makeMockGql({
          addBlockedBy: () => {
            throw new Error("blocked-by API error");
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
        );

        // blocked_by should be preserved as old value (empty array)
        const snap = newSyncState.snapshots["o/r#1"];
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.blocked_by).toEqual(oldSyncFields.blocked_by);

        // Hash must enable retry
        expect(snap!.hash).not.toBe(hashTask(task));
        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#1")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("parent-only failure preserves parent but updates blocked_by (per-field tracking)", async () => {
      const parentTask = makeTask("o/r#10", { github_issue: 10 });
      const blocker = makeTask("o/r#5", { github_issue: 5 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#10",
        blocked_by: [{ task: "o/r#5", type: "finish-to-start" as const, lag: 0 }],
      });
      const tasksFile: TasksFile = {
        tasks: [parentTask, blocker, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          "o/r#5": { issue_number: 5, issue_node_id: "ISSUE_5", project_item_id: "ITEM_5" },
          "o/r#10": { issue_number: 10, issue_node_id: "ISSUE_10", project_item_id: "ITEM_10" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(makeTask("o/r#1", { github_issue: 1 })),
            updated_at: "2026-01-01T00:00:00Z",
          },
          "o/r#5": {
            hash: hashTask(blocker),
            synced_at: "",
            syncFields: extractSyncFields(blocker),
          },
          "o/r#10": {
            hash: hashTask(parentTask),
            synced_at: "",
            syncFields: extractSyncFields(parentTask),
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const mockGql = makeMockGql({
          addSubIssue: () => {
            throw new Error("sub-issue API error");
          },
          // addBlockedBy succeeds (default handler)
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
        );

        const snap = newSyncState.snapshots["o/r#1"];
        expect(snap).toBeDefined();
        // Parent should be rolled back to baseline (null)
        expect(snap!.syncFields?.parent).toBeNull();
        // blocked_by should reflect the successfully synced new value
        expect(snap!.syncFields?.blocked_by).toEqual(task.blocked_by);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("newly created task relation failure uses correct baseline (not saveProgress snapshot)", async () => {
      const parentTask = makeTask("o/r#10", { github_issue: 10 });
      const draftTask = makeTask("o/r#draft-1", {
        github_issue: null,
        parent: "o/r#10",
        title: "New task",
      });
      const tasksFile: TasksFile = {
        tasks: [parentTask, draftTask],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#10": { issue_number: 10, issue_node_id: "ISSUE_10", project_item_id: "ITEM_10" },
        },
        field_ids: {},
        snapshots: {
          "o/r#10": {
            hash: hashTask(parentTask),
            synced_at: "",
            syncFields: extractSyncFields(parentTask),
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const mockGql = vi.fn().mockImplementation(async (query: string, _vars?: any) => {
          // createIssue (mutation)
          if (query.includes("createIssue")) {
            return { createIssue: { issue: { id: "NEW_ISSUE_1", number: 99 } } };
          }
          // addProjectItem (mutation)
          if (query.includes("addProjectV2ItemById")) {
            return { addProjectV2ItemById: { item: { id: "NEW_ITEM_1" } } };
          }
          // addSubIssue — fail (mutation)
          if (query.includes("addSubIssue")) {
            throw new Error("sub-issue API error");
          }
          // updateProjectV2ItemFieldValue (mutation)
          if (query.includes("updateProjectV2ItemFieldValue")) {
            return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
          }
          // fetchRepositoryMetadata (labels + milestones) — must check before repositoryId
          if (query.includes("labels") || query.includes("milestones")) {
            return {
              repository: { id: "REPO_1", labels: { nodes: [] }, milestones: { nodes: [] } },
            };
          }
          // fetchRepositoryId
          if (query.includes("repository(")) {
            return { repository: { id: "REPO_1" } };
          }
          // batch updatedAt
          if (query.includes("issue(number:")) {
            const numbers = extractBatchIssueNumbers(query);
            return makeBatchIssueResponse(numbers);
          }
          return {};
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
          {
            saveProgress: async () => {},
          },
        );

        // The new task should have been converted to o/r#99
        const snap = newSyncState.snapshots["o/r#99"];
        expect(snap).toBeDefined();
        // Parent should be rolled back to null (pre-relation baseline for new tasks)
        expect(snap!.syncFields?.parent).toBeNull();

        // computeLocalDiff should detect the diff for retry
        const newTask = tasksFile.tasks.find((t) => t.id === "o/r#99");
        expect(newTask).toBeDefined();
        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#99")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("[Issue #146] 同一親への addSubIssue を逐次化し Priority 衝突時はリトライする", async () => {
      // 1 epic の下に 3 つの draft task を作成するケースを再現。
      // 並列実行されると "Priority has already been taken" が発生するため、
      // push-executor は (a) 同一親配下の addSubIssue を直列実行し、
      // (b) 同エラー時は exponential backoff でリトライする必要がある。
      const epic = makeTask("o/r#draft-epic", {
        type: "epic",
        github_issue: null,
        title: "Epic",
      });
      const child1 = makeTask("o/r#draft-1", {
        github_issue: null,
        parent: "o/r#draft-epic",
        title: "Child 1",
      });
      const child2 = makeTask("o/r#draft-2", {
        github_issue: null,
        parent: "o/r#draft-epic",
        title: "Child 2",
      });
      const child3 = makeTask("o/r#draft-3", {
        github_issue: null,
        parent: "o/r#draft-epic",
        title: "Child 3",
      });
      const tasksFile: TasksFile = {
        tasks: [epic, child1, child2, child3],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {},
        field_ids: {},
        snapshots: {},
      };

      // addSubIssue の並列実行検知 + priority 衝突のシミュレーション。
      let inFlightAddSubIssue = 0;
      let maxConcurrentAddSubIssue = 0;
      // 最初の 1 回は Priority エラーで失敗させ、リトライで成功することを検証する。
      let addSubIssueCallCount = 0;
      let firstAttemptFailed = false;

      let issueSeq = 100;
      const mockGql = vi.fn().mockImplementation(async (query: string, _vars?: any) => {
        if (query.includes("createIssue")) {
          const n = issueSeq++;
          return { createIssue: { issue: { id: `ISSUE_${n}`, number: n } } };
        }
        if (query.includes("addProjectV2ItemById")) {
          return { addProjectV2ItemById: { item: { id: "ITEM_NEW" } } };
        }
        if (query.includes("addSubIssue")) {
          addSubIssueCallCount++;
          inFlightAddSubIssue++;
          maxConcurrentAddSubIssue = Math.max(maxConcurrentAddSubIssue, inFlightAddSubIssue);
          try {
            // 同一親配下で 2 回目の呼び出しで一度だけ Priority エラーを返す
            if (!firstAttemptFailed && addSubIssueCallCount === 2) {
              firstAttemptFailed = true;
              throw new Error(
                "Request failed: An error occured while adding the sub-issue to the parent issue. Priority has already been taken",
              );
            }
            await new Promise((r) => setTimeout(r, 5));
            return { addSubIssue: { issue: { id: "X" } } };
          } finally {
            inFlightAddSubIssue--;
          }
        }
        if (query.includes("updateProjectV2ItemFieldValue")) {
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
        }
        if (query.includes("labels") || query.includes("milestones")) {
          return {
            repository: { id: "REPO_1", labels: { nodes: [] }, milestones: { nodes: [] } },
          };
        }
        if (query.includes("repository(")) {
          return { repository: { id: "REPO_1" } };
        }
        if (query.includes("issue(number:")) {
          const numbers = extractBatchIssueNumbers(query);
          return makeBatchIssueResponse(numbers);
        }
        return {};
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState, {
          saveProgress: async () => {},
        });

        // 全 4 件 (epic + 3 children) が created になること
        expect(result.created).toBe(4);
        // 同一親配下なので並列実行されていてはならない
        expect(maxConcurrentAddSubIssue).toBe(1);
        // 初回失敗 + 3 件成功 = 4 回の addSubIssue 呼び出し (リトライ含む)
        expect(addSubIssueCallCount).toBe(4);
        expect(firstAttemptFailed).toBe(true);
        // sub-issue 失敗ログが出ていないこと (リトライで救済されているため)
        const subIssueFailWarn = warnSpy.mock.calls.find((c: any[]) =>
          (c[0] as string).includes("sub-issue 関係の設定に失敗"),
        );
        expect(subIssueFailWarn).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("fetchBatchUpdatedAt logs warning on batch failure", async () => {
      const task = makeTask("o/r#1", { github_issue: 1, title: "Modified" });
      const tasksFile: TasksFile = {
        tasks: [task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: extractSyncFields(
              makeTask("o/r#1", { github_issue: 1, title: "Original" }),
            ),
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let batchCallCount = 0;
        const mockGql = makeMockGql({
          batchUpdatedAt: () => {
            batchCallCount++;
            if (batchCallCount === 1) {
              // Stale check — pass
              return { repository: { i0: { number: 1, updatedAt: "2026-01-01T00:00:00Z" } } };
            }
            // Post-push refresh — fail
            throw new Error("GraphQL batch error");
          },
        });

        await executePush(mockGql as any, makeConfig(), tasksFile, syncState);

        // Should have logged a warning about the batch failure
        const batchWarn = warnSpy.mock.calls.find(
          (c) => (c[0] as string).includes("updatedAt") && (c[0] as string).includes("失敗"),
        );
        expect(batchWarn).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("[Issue #151] issue_node_id 欠損時のサイレントスキップ修正", () => {
    it("新規作成タスク: parent の issue_node_id が欠損している場合 warning を出力し failedRelations に記録する", async () => {
      const parentTask = makeTask("o/r#10", { github_issue: 10 });
      const draftTask = makeTask("o/r#draft-1", {
        github_issue: null,
        parent: "o/r#10",
        title: "New task",
      });
      const tasksFile: TasksFile = {
        tasks: [parentTask, draftTask],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          // issue_node_id が意図的に欠損
          "o/r#10": { issue_number: 10 } as any,
        },
        field_ids: {},
        snapshots: {
          "o/r#10": {
            hash: hashTask(parentTask),
            synced_at: "",
            syncFields: extractSyncFields(parentTask),
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let addSubIssueCalled = false;
        const mockGql = vi.fn().mockImplementation(async (query: string) => {
          if (query.includes("createIssue")) {
            return { createIssue: { issue: { id: "NEW_ISSUE_1", number: 99 } } };
          }
          if (query.includes("addProjectV2ItemById")) {
            return { addProjectV2ItemById: { item: { id: "NEW_ITEM_1" } } };
          }
          if (query.includes("addSubIssue")) {
            addSubIssueCalled = true;
            return { addSubIssue: { issue: { id: "X" } } };
          }
          if (query.includes("updateProjectV2ItemFieldValue")) {
            return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
          }
          if (query.includes("labels") || query.includes("milestones")) {
            return {
              repository: { id: "REPO_1", labels: { nodes: [] }, milestones: { nodes: [] } },
            };
          }
          if (query.includes("repository(")) {
            return { repository: { id: "REPO_1" } };
          }
          if (query.includes("issue(number:")) {
            const numbers = extractBatchIssueNumbers(query);
            return makeBatchIssueResponse(numbers);
          }
          return {};
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
          { saveProgress: async () => {} },
        );

        // addSubIssue は呼び出されてはならない
        expect(addSubIssueCalled).toBe(false);

        // warning が出力されること
        const warnMsg = warnSpy.mock.calls.find((c) =>
          (c[0] as string).includes("issue_node_id が取得できないため sub-issue 関係をスキップ"),
        );
        expect(warnMsg).toBeDefined();

        // snapshot の parent が null に保持され、次回 push でリトライされること
        const snap = newSyncState.snapshots["o/r#99"];
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.parent).toBeNull();

        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#99")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("新規作成タスク: blocker の issue_node_id が欠損している場合 warning を出力し failedRelations に記録する", async () => {
      const blockerTask = makeTask("o/r#5", { github_issue: 5 });
      const draftTask = makeTask("o/r#draft-1", {
        github_issue: null,
        blocked_by: [{ task: "o/r#5", type: "finish-to-start" as const, lag: 0 }],
        title: "New task",
      });
      const tasksFile: TasksFile = {
        tasks: [blockerTask, draftTask],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          // blocker の issue_node_id が意図的に欠損
          "o/r#5": { issue_number: 5 } as any,
        },
        field_ids: {},
        snapshots: {
          "o/r#5": {
            hash: hashTask(blockerTask),
            synced_at: "",
            syncFields: extractSyncFields(blockerTask),
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let addBlockedByCalled = false;
        const mockGql = vi.fn().mockImplementation(async (query: string) => {
          if (query.includes("createIssue")) {
            return { createIssue: { issue: { id: "NEW_ISSUE_1", number: 99 } } };
          }
          if (query.includes("addProjectV2ItemById")) {
            return { addProjectV2ItemById: { item: { id: "NEW_ITEM_1" } } };
          }
          if (query.includes("addBlockedBy")) {
            addBlockedByCalled = true;
            return { addIssueRelation: { issue: { id: "ISSUE_1" } } };
          }
          if (query.includes("updateProjectV2ItemFieldValue")) {
            return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } };
          }
          if (query.includes("labels") || query.includes("milestones")) {
            return {
              repository: { id: "REPO_1", labels: { nodes: [] }, milestones: { nodes: [] } },
            };
          }
          if (query.includes("repository(")) {
            return { repository: { id: "REPO_1" } };
          }
          if (query.includes("issue(number:")) {
            const numbers = extractBatchIssueNumbers(query);
            return makeBatchIssueResponse(numbers);
          }
          return {};
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
          { saveProgress: async () => {} },
        );

        // addBlockedBy は呼び出されてはならない
        expect(addBlockedByCalled).toBe(false);

        // warning が出力されること
        const warnMsg = warnSpy.mock.calls.find((c) =>
          (c[0] as string).includes("issue_node_id が取得できないため blocked-by 関係をスキップ"),
        );
        expect(warnMsg).toBeDefined();

        // snapshot の blocked_by が [] に保持され、次回 push でリトライされること
        const snap = newSyncState.snapshots["o/r#99"];
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.blocked_by).toEqual([]);

        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#99")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("既存タスク: 新 parent の issue_node_id が欠損している場合 warning + parentFailed でスナップショットをロールバック", async () => {
      const newParent = makeTask("o/r#20", { github_issue: 20 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        parent: "o/r#20",
      });
      const oldSyncFields = extractSyncFields(makeTask("o/r#1", { github_issue: 1 }));
      const tasksFile: TasksFile = {
        tasks: [newParent, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          // 新 parent の issue_node_id が意図的に欠損
          "o/r#20": { issue_number: 20 } as any,
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: oldSyncFields,
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let addSubIssueCalled = false;
        const mockGql = makeMockGql({
          addSubIssue: () => {
            addSubIssueCalled = true;
            return { addSubIssue: { issue: { id: "X" } } };
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
        );

        // addSubIssue は呼び出されてはならない
        expect(addSubIssueCalled).toBe(false);

        // warning が出力されること
        const warnMsg = warnSpy.mock.calls.find((c) =>
          (c[0] as string).includes("issue_node_id が取得できないため sub-issue 関係をスキップ"),
        );
        expect(warnMsg).toBeDefined();

        // parent が old value (null) にロールバックされること
        const snap = newSyncState.snapshots["o/r#1"];
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.parent).toBe(oldSyncFields.parent);

        // computeLocalDiff で diff が検出され次回リトライ可能
        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#1")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("既存タスク: blocked_by 追加で blocker の issue_node_id が欠損している場合 warning + blockedByFailed", async () => {
      const blocker = makeTask("o/r#5", { github_issue: 5 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        blocked_by: [{ task: "o/r#5", type: "finish-to-start" as const, lag: 0 }],
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
          // blocker の issue_node_id が意図的に欠損
          "o/r#5": { issue_number: 5 } as any,
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: oldSyncFields,
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let addBlockedByCalled = false;
        const mockGql = makeMockGql({
          addBlockedBy: () => {
            addBlockedByCalled = true;
            return { addIssueRelation: { issue: { id: "ISSUE_1" } } };
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
        );

        // addBlockedBy は呼び出されてはならない
        expect(addBlockedByCalled).toBe(false);

        // warning が出力されること
        const warnMsg = warnSpy.mock.calls.find((c) =>
          (c[0] as string).includes("issue_node_id が取得できないため blocked-by 関係をスキップ"),
        );
        expect(warnMsg).toBeDefined();

        // blocked_by が old value ([]) にロールバックされること
        const snap = newSyncState.snapshots["o/r#1"];
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.blocked_by).toEqual(oldSyncFields.blocked_by);

        // computeLocalDiff で diff が検出され次回リトライ可能
        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#1")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("既存タスク: blocked_by 削除で blocker の issue_node_id が欠損している場合 warning + blockedByFailed", async () => {
      const blocker = makeTask("o/r#5", { github_issue: 5 });
      const task = makeTask("o/r#1", {
        github_issue: 1,
        blocked_by: [], // blocker を削除
      });
      const oldBlockedBy = [{ task: "o/r#5", type: "finish-to-start" as const, lag: 0 }];
      const oldSyncFields = extractSyncFields(
        makeTask("o/r#1", { github_issue: 1, blocked_by: oldBlockedBy }),
      );
      const tasksFile: TasksFile = {
        tasks: [blocker, task],
        cache: { comments: {}, reactions: {} },
      };
      const syncState: SyncState = {
        last_synced_at: "",
        project_node_id: "PVT_1",
        id_map: {
          "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
          // blocker の issue_node_id が意図的に欠損
          "o/r#5": { issue_number: 5 } as any,
        },
        field_ids: {},
        snapshots: {
          "o/r#1": {
            hash: "stale-hash",
            synced_at: "",
            syncFields: oldSyncFields,
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        let removeBlockedByCalled = false;
        const mockGql = makeMockGql({
          removeBlockedBy: () => {
            removeBlockedByCalled = true;
            return { removeIssueRelation: { issue: { id: "ISSUE_1" } } };
          },
        });

        const { syncState: newSyncState } = await executePush(
          mockGql as any,
          makeConfig(),
          tasksFile,
          syncState,
        );

        // removeBlockedBy は呼び出されてはならない
        expect(removeBlockedByCalled).toBe(false);

        // warning が出力されること
        const warnMsg = warnSpy.mock.calls.find((c) =>
          (c[0] as string).includes("issue_node_id が取得できないため blocked-by 削除をスキップ"),
        );
        expect(warnMsg).toBeDefined();

        // blocked_by が old value にロールバックされること（削除に失敗したため）
        const snap = newSyncState.snapshots["o/r#1"];
        expect(snap).toBeDefined();
        expect(snap!.syncFields?.blocked_by).toEqual(oldBlockedBy);

        // computeLocalDiff で diff が検出され次回リトライ可能
        const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
        expect(retryDiffs.some((d) => d.id === "o/r#1")).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
