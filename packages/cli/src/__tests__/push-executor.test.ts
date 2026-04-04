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
    repo[`i${i}`] = { number: n, updatedAt: "2026-01-01T00:00:00Z" };
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
        blocked_by: [{ task: "o/r#20", type: "blocked_by" as const }],
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
});
