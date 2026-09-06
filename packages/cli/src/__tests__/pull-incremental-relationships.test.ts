/**
 * [Issue #350] pull の関係リンク (sub-issue / blockedBy) 取得を
 * updated_at が sync-state と一致しない Issue だけに絞る。
 *
 * 変わらなかった Issue の辺は snapshot の syncFields から再構成し、
 * 変わった Issue に接する既存の辺は捨てて取得結果で置き換える。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config, SyncState, TasksFile, Task } from "@gh-gantt/shared";

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
  fetchAllIssueRelationshipLinks: vi.fn(),
}));

import { executePull } from "../sync/pull-executor.js";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import {
  fetchProject,
  fetchRepositoryMetadata,
  checkRemoteChanges,
  type RawProjectItem,
} from "../github/projects.js";
import { fetchAllIssueRelationshipLinks } from "../github/sub-issues.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);
const mockFetchLinks = vi.mocked(fetchAllIssueRelationshipLinks);

const LAST_PULL_AT = "2026-07-01T00:00:00Z";
const UNCHANGED_AT = "2026-06-30T00:00:00Z";
const CHANGED_AT = "2026-07-02T00:00:00Z";
const REPO = "stanah/gh-gantt";

function makeConfig(): Config {
  return {
    version: "1",
    project: { name: "test", github: { owner: "stanah", repo: "gh-gantt", project_number: 1 } },
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

function makeTask(issueNumber: number, updatedAt: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `${REPO}#${issueNumber}`,
    type: "task",
    github_issue: issueNumber,
    github_repo: REPO,
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
    ...overrides,
  };
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
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt,
      closedAt: null,
      issueType: null,
      repository: REPO,
      linkedPullRequests: [],
    },
  };
}

function makeSnapshot(task: Task): SyncState["snapshots"][string] {
  const hash = hashTask(task);
  return {
    hash,
    remoteHash: hash,
    synced_at: LAST_PULL_AT,
    updated_at: task.updated_at,
    syncFields: extractSyncFields(task),
  };
}

function makeSyncState(tasks: Task[]): SyncState {
  return {
    last_synced_at: LAST_PULL_AT,
    project_node_id: "PVT_1",
    id_map: Object.fromEntries(
      tasks.map((t) => [
        t.id,
        {
          issue_number: t.github_issue!,
          issue_node_id: `I_${t.github_issue}`,
          project_item_id: `PVTI_${t.github_issue}`,
        },
      ]),
    ),
    field_ids: {},
    snapshots: Object.fromEntries(tasks.map((t) => [t.id, makeSnapshot(t)])),
  };
}

function makeTasksFile(tasks: Task[]): TasksFile {
  return { tasks, cache: { comments: {}, reactions: {} } } as unknown as TasksFile;
}

function dep(task: string) {
  return { task, type: "finish-to-start" as const, lag: 0 };
}

/** 親 #1 → 子 #2, #3。#3 は #4 に blocked。全員 UNCHANGED_AT で同期済み */
function makeSyncedTasks(): Task[] {
  return [
    makeTask(1, UNCHANGED_AT, { sub_tasks: [`${REPO}#2`, `${REPO}#3`] }),
    makeTask(2, UNCHANGED_AT, { parent: `${REPO}#1` }),
    makeTask(3, UNCHANGED_AT, { parent: `${REPO}#1`, blocked_by: [dep(`${REPO}#4`)] }),
    makeTask(4, UNCHANGED_AT),
  ];
}

function fetchedNumbers(): number[] {
  return mockFetchLinks.mock.calls[0][1].map((item) => item.number);
}

describe("[NFR-SYNC-002-AC2] [NFR-SYNC-002-AC3] pull の関係リンク差分取得 [Issue #350]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRemote.mockResolvedValue(true);
    mockFetchRepoMeta.mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    });
    mockFetchLinks.mockResolvedValue({ subIssueLinks: [], blockedByLinks: [] });
  });

  it("updated_at が変わった Issue だけ関係リンクを取得する", async () => {
    const tasks = makeSyncedTasks();
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        makeProjectItem(1, UNCHANGED_AT),
        makeProjectItem(2, UNCHANGED_AT),
        makeProjectItem(3, UNCHANGED_AT),
        makeProjectItem(4, CHANGED_AT),
      ],
    });

    await executePull(vi.fn() as never, makeConfig(), makeTasksFile(tasks), makeSyncState(tasks));

    expect(mockFetchLinks).toHaveBeenCalledOnce();
    expect(fetchedNumbers()).toEqual([4]);
  });

  it("変わらなかった Issue の親子と blocked_by は snapshot から再構成され全件取得と一致する", async () => {
    const tasks = makeSyncedTasks();
    // #4 の title だけ変わった。#4 に接する辺 (#3 ← #4) は #4 の blocking から復元される
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        makeProjectItem(1, UNCHANGED_AT),
        makeProjectItem(2, UNCHANGED_AT),
        makeProjectItem(3, UNCHANGED_AT),
        makeProjectItem(4, CHANGED_AT),
      ],
    });
    mockFetchLinks.mockResolvedValue({
      subIssueLinks: [],
      blockedByLinks: [
        { blockedNumber: 3, blockedRepo: REPO, blockingNumber: 4, blockingRepo: REPO },
      ],
    });

    const { tasksFile } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(tasks),
      makeSyncState(tasks),
    );

    const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
    expect(byId.get(`${REPO}#1`)?.sub_tasks).toEqual([`${REPO}#2`, `${REPO}#3`]);
    expect(byId.get(`${REPO}#2`)?.parent).toBe(`${REPO}#1`);
    expect(byId.get(`${REPO}#3`)?.parent).toBe(`${REPO}#1`);
    // #3 ← #4 の辺は #4 が stale なので snapshot からは捨てられ、取得結果で復元される
    expect(byId.get(`${REPO}#3`)?.blocked_by).toEqual([dep(`${REPO}#4`)]);
  });

  it("変わった Issue に接していた既存の辺は捨てられ取得結果で置き換わる", async () => {
    const tasks = makeSyncedTasks();
    // GitHub 側で #3 を #1 の子から外し、#4 への依存も解除した。#1 と #3 の updated_at が進む
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        makeProjectItem(1, CHANGED_AT),
        makeProjectItem(2, UNCHANGED_AT),
        makeProjectItem(3, CHANGED_AT),
        makeProjectItem(4, UNCHANGED_AT),
      ],
    });
    mockFetchLinks.mockResolvedValue({
      subIssueLinks: [{ parentNumber: 1, parentRepo: REPO, childNumber: 2, childRepo: REPO }],
      blockedByLinks: [],
    });

    const { tasksFile } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(tasks),
      makeSyncState(tasks),
    );

    expect(fetchedNumbers()).toEqual([1, 3]);
    const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
    expect(byId.get(`${REPO}#1`)?.sub_tasks).toEqual([`${REPO}#2`]);
    expect(byId.get(`${REPO}#3`)?.parent).toBeNull();
    expect(byId.get(`${REPO}#3`)?.blocked_by).toEqual([]);
  });

  it("片側の Issue だけが変わっても古い辺が残らない", async () => {
    const tasks = makeSyncedTasks();
    // #4 を blocker から外す操作で #3 (blocked 側) だけ updated_at が進んだ
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        makeProjectItem(1, UNCHANGED_AT),
        makeProjectItem(2, UNCHANGED_AT),
        makeProjectItem(3, CHANGED_AT),
        makeProjectItem(4, UNCHANGED_AT),
      ],
    });
    // #3 の取得結果: 親は #1 のまま、blockedBy は空
    mockFetchLinks.mockResolvedValue({
      subIssueLinks: [{ parentNumber: 1, parentRepo: REPO, childNumber: 3, childRepo: REPO }],
      blockedByLinks: [],
    });

    const { tasksFile } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(tasks),
      makeSyncState(tasks),
    );

    expect(fetchedNumbers()).toEqual([3]);
    const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
    expect(byId.get(`${REPO}#3`)?.blocked_by).toEqual([]);
    expect(byId.get(`${REPO}#3`)?.parent).toBe(`${REPO}#1`);
    // 親 #1 は変わっていないが、#3 との辺は取得結果で復元され順序も保たれる
    expect(byId.get(`${REPO}#1`)?.sub_tasks).toEqual([`${REPO}#2`, `${REPO}#3`]);
  });

  it("snapshot のない新規 Issue は取得対象に含まれる", async () => {
    const tasks = makeSyncedTasks();
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        makeProjectItem(1, UNCHANGED_AT),
        makeProjectItem(2, UNCHANGED_AT),
        makeProjectItem(3, UNCHANGED_AT),
        makeProjectItem(4, UNCHANGED_AT),
        makeProjectItem(5, CHANGED_AT),
      ],
    });

    await executePull(vi.fn() as never, makeConfig(), makeTasksFile(tasks), makeSyncState(tasks));

    expect(fetchedNumbers()).toEqual([5]);
  });

  it("force=true では全 Issue の関係リンクを取得する", async () => {
    const tasks = makeSyncedTasks();
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        makeProjectItem(1, UNCHANGED_AT),
        makeProjectItem(2, UNCHANGED_AT),
        makeProjectItem(3, UNCHANGED_AT),
        makeProjectItem(4, UNCHANGED_AT),
      ],
    });

    await executePull(vi.fn() as never, makeConfig(), makeTasksFile(tasks), makeSyncState(tasks), {
      force: true,
    });

    expect(fetchedNumbers()).toEqual([1, 2, 3, 4]);
  });

  it("sync-state が空の初回同期では全 Issue の関係リンクを取得する", async () => {
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(1, UNCHANGED_AT), makeProjectItem(2, UNCHANGED_AT)],
    });
    const emptyState: SyncState = {
      last_synced_at: "",
      project_node_id: "",
      id_map: {},
      field_ids: {},
      snapshots: {},
    };

    await executePull(vi.fn() as never, makeConfig(), makeTasksFile([]), emptyState);

    expect(fetchedNumbers()).toEqual([1, 2]);
  });
});
