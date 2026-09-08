import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CommentsFile, Config, SyncState, TasksFile, Task } from "@gh-gantt/shared";

vi.mock("../github/projects.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../github/projects.js")>();
  return {
    ...original,
    fetchProject: vi.fn(),
    fetchRepositoryMetadata: vi.fn(),
    checkRemoteChanges: vi.fn(),
  };
});

vi.mock("../github/sub-issues.js", () => ({
  fetchAllIssueRelationshipLinks: vi.fn().mockResolvedValue({
    subIssueLinks: [],
    blockedByLinks: [],
  }),
}));

import { executePull } from "../sync/pull-executor.js";
import { hashTask } from "../sync/hash.js";
import { buildCommentItems } from "../commands/pull.js";
import { fetchAllComments } from "../github/comments.js";
import {
  fetchProject,
  fetchRepositoryMetadata,
  checkRemoteChanges,
  type RawProjectItem,
} from "../github/projects.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);

const TASK_ID = "stanah/gh-gantt#10";
const OLD_UPDATED_AT = "2026-04-01T00:00:00Z";
const NEW_UPDATED_AT = "2026-04-05T12:00:00Z";

function makeConfig(): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
    },
    sync: {
      auto_create_issues: true,
      field_mapping: {
        start_date: "Start Date",
        end_date: "End Date",
        status: "Status",
        priority: "Priority",
      },
    },
    task_types: {
      task: { label: "Task", display: "bar" as const, color: "#27AE60", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week" as const,
      working_days: [1, 2, 3, 4, 5],
      colors: {
        critical_path: "#E74C3C",
        on_track: "#27AE60",
        at_risk: "#F1C40F",
        overdue: "#C0392B",
      },
    },
  } satisfies Config;
}

function makeProjectItem(issueNumber: number, updatedAt: string): RawProjectItem {
  return {
    id: `PVTI_${issueNumber}`,
    fieldValues: {},
    content: {
      nodeId: `I_${issueNumber}`,
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      body: null,
      state: "open",
      stateReason: null,
      assignees: [],
      labels: [],
      milestone: null,
      createdAt: OLD_UPDATED_AT,
      updatedAt,
      closedAt: null,
      issueType: null,
      repository: "stanah/gh-gantt",
      linkedPullRequests: [],
    },
  };
}

function makeTask(issueNumber: number, updatedAt: string): Task {
  return {
    id: `stanah/gh-gantt#${issueNumber}`,
    type: "task",
    github_issue: issueNumber,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: `Issue ${issueNumber}`,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: OLD_UPDATED_AT,
    updated_at: updatedAt,
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
  };
}

/** ハッシュ一致 (内容変更なし) の task が snapshot 済みの sync-state を作る */
function makeSyncState(task: Task): SyncState {
  const taskHash = hashTask(task);
  return {
    last_synced_at: OLD_UPDATED_AT,
    project_node_id: "PVT_1",
    id_map: {
      [task.id]: { issue_number: 10, issue_node_id: "I_10", project_item_id: "PVTI_10" },
    },
    field_ids: {},
    snapshots: {
      [task.id]: {
        hash: taskHash,
        synced_at: OLD_UPDATED_AT,
        updated_at: OLD_UPDATED_AT,
        remoteHash: taskHash,
        syncFields: {
          title: "Issue 10",
          body: null,
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
    },
  } as SyncState;
}

function makeCommentsFile(): CommentsFile {
  return {
    version: "2",
    fetched_at: { [TASK_ID]: "2026-04-01T01:00:00Z" },
    issue_updated_at: { [TASK_ID]: OLD_UPDATED_AT },
    comments: {
      [TASK_ID]: [
        {
          id: "C_old",
          author: "alice",
          body: "old",
          created_at: OLD_UPDATED_AT,
          updated_at: OLD_UPDATED_AT,
        },
      ],
    },
  };
}

function makeCommentsGql(body: string) {
  return vi.fn(async () => ({
    repository: {
      issue: {
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "C_new",
              author: { login: "bob" },
              body,
              createdAt: NEW_UPDATED_AT,
              updatedAt: NEW_UPDATED_AT,
            },
          ],
        },
      },
    },
  }));
}

/** executePull を実行し、pull コマンドと同じ手順でコメント取得対象を組み立てる */
async function pullAndBuildItems(remoteUpdatedAt: string) {
  const localTask = makeTask(10, OLD_UPDATED_AT);
  mockFetchProject.mockResolvedValue({
    projectNodeId: "PVT_1",
    projectTitle: "Test",
    fields: [],
    items: [makeProjectItem(10, remoteUpdatedAt)],
  });
  const tasksFile = { tasks: [localTask], cache: { comments: {}, reactions: {} } } as TasksFile;
  const { tasksFile: newTasksFile, syncState: newSyncState } = await executePull(
    vi.fn() as never,
    makeConfig(),
    tasksFile,
    makeSyncState(localTask),
    { force: true },
  );
  // 前提: ハッシュ一致経路を通り、task.updated_at は remote に追従せず local 値のまま残る (#169)。
  // この前提が崩れると AC1 テストの回帰検出力が失われるため明示的に assert する
  expect(newTasksFile.tasks[0].updated_at).toBe(OLD_UPDATED_AT);
  expect(newSyncState.snapshots[TASK_ID]?.updated_at).toBe(remoteUpdatedAt);
  return buildCommentItems(newTasksFile.tasks, newSyncState);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchRepoMeta.mockResolvedValue({
    labelMap: new Map(),
    milestoneMap: new Map(),
    milestones: [],
  } as unknown as Awaited<ReturnType<typeof fetchRepositoryMetadata>>);
  mockCheckRemote.mockResolvedValue(true);
});

describe("[FR-SYNC-008-AC1] 取得済み Issue でも updated_at が前回取得時と異なればコメントを再取得し、追加・編集・削除が反映される", () => {
  it("ハッシュ一致で task が local のまま残っても snapshot の updated_at でコメントを再取得する", async () => {
    const items = await pullAndBuildItems(NEW_UPDATED_AT);
    // task.updated_at は remote に追従しない (#169) が、判定には snapshot 側を使う
    expect(items).toEqual([
      {
        taskId: TASK_ID,
        owner: "stanah",
        repo: "gh-gantt",
        issueNumber: 10,
        updatedAt: NEW_UPDATED_AT,
      },
    ]);

    const gql = makeCommentsGql("new comment");
    const result = await fetchAllComments(gql as any, items, makeCommentsFile(), async () => {});
    expect(gql).toHaveBeenCalledTimes(1);
    expect(result.comments[TASK_ID].map((c) => c.id)).toEqual(["C_new"]);
    expect(result.issue_updated_at[TASK_ID]).toBe(NEW_UPDATED_AT);
  });
});

describe("[FR-SYNC-008-AC2] updated_at が変わらない取得済み Issue には GitHub API を呼ばない", () => {
  it("remote の updated_at が snapshot と一致する Issue はコメント取得の API を呼ばない", async () => {
    const items = await pullAndBuildItems(OLD_UPDATED_AT);
    expect(items[0].updatedAt).toBe(OLD_UPDATED_AT);

    const gql = makeCommentsGql("unexpected");
    const result = await fetchAllComments(gql as any, items, makeCommentsFile(), async () => {});
    expect(gql).not.toHaveBeenCalled();
    expect(result.comments[TASK_ID].map((c) => c.id)).toEqual(["C_old"]);
  });
});
