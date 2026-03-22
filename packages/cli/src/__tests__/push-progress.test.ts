/**
 * Test that push saves progress after each draft conversion,
 * so that a mid-push failure doesn't leave stale draft snapshots.
 */
import { describe, it, expect, vi } from "vitest";
import { executePush } from "../sync/push-executor.js";
import { extractSyncFields } from "../sync/hash.js";
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

describe("push progress saving", () => {
  it("saveProgress is called after each draft is converted to a real issue", async () => {
    const draft1 = makeTask("o/r#draft-1", { title: "Draft 1" });
    const draft2 = makeTask("o/r#draft-2", { title: "Draft 2" });
    const tasksFile: TasksFile = {
      tasks: [draft1, draft2],
      cache: { comments: {}, reactions: {} },
    };
    const syncState: SyncState = {
      last_synced_at: "",
      project_node_id: "PVT_1",
      id_map: {},
      field_ids: {},
      snapshots: {
        "o/r#draft-1": { hash: "old1", synced_at: "" },
        "o/r#draft-2": { hash: "old2", synced_at: "" },
      },
    };

    const saveProgress = vi.fn();

    // Mock GraphQL: first draft succeeds, second draft fails
    let callCount = 0;
    const mockGql = vi.fn().mockImplementation(async (query: string) => {
      // fetchRepositoryId
      if (query.includes("repository(owner")) {
        if (query.includes("issue(number")) {
          // updatedAt check — not reached for drafts
          return { repository: { issue: { updatedAt: "" } } };
        }
        return { repository: { id: "REPO_1", labels: { nodes: [] }, milestones: { nodes: [] } } };
      }
      // createIssue
      if (query.includes("createIssue")) {
        callCount++;
        if (callCount === 1) {
          return { createIssue: { issue: { id: "ISSUE_1", number: 100 } } };
        }
        throw new Error("API error on second draft");
      }
      // addProjectV2ItemById
      if (query.includes("addProjectV2ItemById")) {
        return { addProjectV2ItemById: { item: { id: "ITEM_1" } } };
      }
      // fetchUserIds
      if (query.includes("nodes(ids")) {
        return { nodes: [] };
      }
      return {};
    });

    try {
      await executePush(mockGql as any, makeConfig(), tasksFile, syncState, {
        saveProgress,
      });
    } catch {
      // Expected: second draft creation fails
    }

    // saveProgress should have been called after first draft succeeded
    expect(saveProgress).toHaveBeenCalled();

    // The saved state should have draft-1's snapshot removed (replaced by real ID)
    const savedCall = saveProgress.mock.calls[0];
    const savedTasksFile = savedCall[0] as TasksFile;
    const savedSyncState = savedCall[1] as SyncState;

    // o/r#draft-1 should be replaced with o/r#100
    expect(savedTasksFile.tasks.find((t: Task) => t.id === "o/r#draft-1")).toBeUndefined();
    expect(savedTasksFile.tasks.find((t: Task) => t.id === "o/r#100")).toBeDefined();

    // draft-1 snapshot should be removed, real ID snapshot should exist
    expect(savedSyncState.snapshots["o/r#draft-1"]).toBeUndefined();
    expect(savedSyncState.snapshots["o/r#100"]).toBeDefined();
  });

  it("without saveProgress callback, push still works (backward compatible)", async () => {
    const task = makeTask("o/r#1", { github_issue: 1, title: "Existing" });
    const tasksFile: TasksFile = {
      tasks: [task],
      cache: { comments: {}, reactions: {} },
    };
    const syncState: SyncState = {
      last_synced_at: "",
      project_node_id: "PVT_1",
      id_map: {},
      field_ids: {},
      snapshots: {
        "o/r#1": { hash: "different", synced_at: "", syncFields: extractSyncFields(task) },
      },
    };

    const mockGql = vi.fn().mockImplementation(async (query: string) => {
      if (query.includes("issue(number")) {
        return { repository: { issue: { updatedAt: "" } } };
      }
      if (query.includes("updateIssue")) {
        return { updateIssue: { issue: { id: "ISSUE_1" } } };
      }
      return {};
    });

    // Should not throw even without saveProgress
    const { result } = await executePush(mockGql as any, makeConfig(), tasksFile, syncState);
    expect(result).toBeDefined();
  });
});
