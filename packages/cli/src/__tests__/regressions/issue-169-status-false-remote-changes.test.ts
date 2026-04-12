import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config, SyncState, TasksFile, Task } from "@gh-gantt/shared";

vi.mock("../../github/projects.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../github/projects.js")>();
  return {
    ...original,
    fetchProject: vi.fn(),
    fetchRepositoryMetadata: vi.fn(),
    checkRemoteChanges: vi.fn(),
  };
});

vi.mock("../../github/sub-issues.js", () => ({
  fetchAllIssueRelationshipLinks: vi.fn().mockResolvedValue({
    subIssueLinks: [],
    blockedByLinks: [],
  }),
}));

import { executePull } from "../../sync/pull-executor.js";
import { hashTask } from "../../sync/hash.js";
import {
  fetchProject,
  fetchRepositoryMetadata,
  checkRemoteChanges,
  type RawProjectItem,
} from "../../github/projects.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);

function makeConfig(): Config {
  const config = {
    version: "1",
    project: {
      name: "test",
      github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
    },
    sync: {
      auto_create_issues: true,
      conflict_strategy: "remote-wins" as const,
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
    gantt: { default_view: "week" as const },
  } satisfies Config;
  return config;
}

function makeSyncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    last_synced_at: "2026-04-01T00:00:00Z",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots: {},
    ...overrides,
  } as SyncState;
}

function makeTasksFile(tasks: Task[] = []): TasksFile {
  return { tasks, cache: { comments: {}, reactions: {} } } as unknown as TasksFile;
}

function makeProjectItem(issueNumber: number, updatedAt = "2026-04-01T00:00:00Z"): RawProjectItem {
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
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: updatedAt,
      closedAt: null,
      issueType: null,
      repository: "stanah/gh-gantt",
    },
  };
}

function makeTask(issueNumber: number, updatedAt = "2026-04-01T00:00:00Z"): Task {
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
    created_at: "2026-04-01T00:00:00Z",
    updated_at: updatedAt,
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
  };
}

const gql = vi.fn();

describe("[NFR-STABILITY-001-AC5] [Issue #169] pull がハッシュ一致でも snapshot.updated_at を refresh する (#36 regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoMeta.mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    } as unknown as Awaited<ReturnType<typeof fetchRepositoryMetadata>>);
    mockCheckRemote.mockResolvedValue(true);
  });

  it("[Issue #169] ハッシュ一致 + updated_at のみ進行 → snapshot.updated_at が remote に追従する", async () => {
    const oldUpdatedAt = "2026-04-01T00:00:00Z";
    const newUpdatedAt = "2026-04-05T12:00:00Z";

    // ローカルタスク: 古い updated_at
    const localTask = makeTask(10, oldUpdatedAt);
    const taskHash = hashTask(localTask);

    // リモート: 内容同一 (ハッシュ一致) だが updated_at のみ進行
    // (例: PR リンク、タイムライン参照等の hashTask 対象外変更)
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10, newUpdatedAt)],
    });

    const syncState = makeSyncState({
      id_map: {
        "stanah/gh-gantt#10": {
          issue_number: 10,
          issue_node_id: "I_10",
          project_item_id: "PVTI_10",
        },
      },
      snapshots: {
        "stanah/gh-gantt#10": {
          hash: taskHash,
          synced_at: "2026-04-01T00:00:00Z",
          updated_at: oldUpdatedAt,
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
    });

    const { syncState: newState, result } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile([localTask]),
      syncState,
      { force: true },
    );

    // 内容は変わっていないので updated=0 のまま
    expect(result.updated).toBe(0);

    // snapshot.updated_at が remote 側に追従していることを検証
    const snap = newState.snapshots["stanah/gh-gantt#10"];
    expect(snap).toBeDefined();
    expect(snap!.updated_at).toBe(newUpdatedAt);
  });

  it("[Issue #169] updated_at 追従後の 2 回目 pull で quick-skip が正しく機能する", async () => {
    const oldUpdatedAt = "2026-04-01T00:00:00Z";
    const newUpdatedAt = "2026-04-05T12:00:00Z";

    const localTask = makeTask(10, oldUpdatedAt);
    const taskHash = hashTask(localTask);

    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10, newUpdatedAt)],
    });

    const syncState = makeSyncState({
      id_map: {
        "stanah/gh-gantt#10": {
          issue_number: 10,
          issue_node_id: "I_10",
          project_item_id: "PVTI_10",
        },
      },
      snapshots: {
        "stanah/gh-gantt#10": {
          hash: taskHash,
          synced_at: "2026-04-01T00:00:00Z",
          updated_at: oldUpdatedAt,
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
    });

    // 1 回目: force pull で snapshot.updated_at を refresh
    const { syncState: afterFirst, tasksFile: afterFirstTasks } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile([localTask]),
      syncState,
      { force: true },
    );

    // 2 回目: 同じ remote で pull → quick-skip が効くはず
    const { result: secondResult } = await executePull(
      gql as never,
      makeConfig(),
      afterFirstTasks,
      afterFirst,
    );

    expect(secondResult.skipped).toBe(true);
  });

  it("[Issue #169] 複数タスクで一部のみ updated_at が進行 → 進行分のみ refresh される", async () => {
    const baseTime = "2026-04-01T00:00:00Z";
    const advancedTime = "2026-04-05T12:00:00Z";

    const task10 = makeTask(10, baseTime);
    const task20 = makeTask(20, baseTime);
    const task30 = makeTask(30, baseTime);
    const hash10 = hashTask(task10);
    const hash20 = hashTask(task20);
    const hash30 = hashTask(task30);

    // #10 と #30 のみ updated_at が進行、#20 は変化なし
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        makeProjectItem(10, advancedTime),
        makeProjectItem(20, baseTime),
        makeProjectItem(30, advancedTime),
      ],
    });

    const makeSnap = (issueNumber: number, hash: string) => ({
      hash,
      synced_at: "2026-04-01T00:00:00Z",
      updated_at: baseTime,
      remoteHash: hash,
      syncFields: {
        title: `Issue ${issueNumber}`,
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
    });

    const idMapEntry = (n: number) => ({
      issue_number: n,
      issue_node_id: `I_${n}`,
      project_item_id: `PVTI_${n}`,
    });

    const syncState = makeSyncState({
      id_map: {
        "stanah/gh-gantt#10": idMapEntry(10),
        "stanah/gh-gantt#20": idMapEntry(20),
        "stanah/gh-gantt#30": idMapEntry(30),
      },
      snapshots: {
        "stanah/gh-gantt#10": makeSnap(10, hash10) as SyncState["snapshots"][string],
        "stanah/gh-gantt#20": makeSnap(20, hash20) as SyncState["snapshots"][string],
        "stanah/gh-gantt#30": makeSnap(30, hash30) as SyncState["snapshots"][string],
      },
    });

    const { syncState: newState, result } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile([task10, task20, task30]),
      syncState,
      { force: true },
    );

    expect(result.updated).toBe(0);

    // #10, #30: updated_at が進行
    expect(newState.snapshots["stanah/gh-gantt#10"]!.updated_at).toBe(advancedTime);
    expect(newState.snapshots["stanah/gh-gantt#30"]!.updated_at).toBe(advancedTime);

    // #20: 変化なし
    expect(newState.snapshots["stanah/gh-gantt#20"]!.updated_at).toBe(baseTime);
  });
});
