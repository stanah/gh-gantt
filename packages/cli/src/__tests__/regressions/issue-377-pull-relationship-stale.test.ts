/**
 * [Issue #377] pull が updated_at 不変の Issue の親子・blocked_by 変更を検出せず
 * --force が必要になるリグレッションテスト。
 *
 * 機序 (GitHub API で実測済み):
 * - sub-issue / blockedBy の追加・削除は、親子・blocker・blocked のいずれの Issue の
 *   `updatedAt` も更新しない (timeline には SubIssueAddedEvent 等が記録される)
 * - `issues(filterBy: { since })` も updatedAt ベースなので pre-check は「変化なし」を返す
 * - #350 で導入した quick-skip と isRelationshipStale は「updated_at 不変なら関係も不変」と
 *   仮定していたため、関係だけが変わった Issue の辺を snapshot から再構成し続ける
 *
 * 修正: ProjectV2 items の一括取得に関係シグネチャ (parent / sub-issue 件数 /
 * blockedBy 件数 / blocking 件数) を同梱して snapshot に保存し、pre-check・quick-skip・
 * 関係リンクの stale 判定を updated_at とシグネチャの両方で行う。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config, SyncState, TasksFile, Task, RelationshipSignature } from "@gh-gantt/shared";

vi.mock("../../github/projects.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../github/projects.js")>();
  return {
    ...original,
    fetchProject: vi.fn(),
    fetchProjectRelationshipSignatures: vi.fn(),
    fetchRepositoryMetadata: vi.fn(),
    checkRemoteChanges: vi.fn(),
  };
});

vi.mock("../../github/sub-issues.js", () => ({
  fetchAllIssueRelationshipLinks: vi.fn(),
}));

import { executePull } from "../../sync/pull-executor.js";
import { hashTask, extractSyncFields } from "../../sync/hash.js";
import {
  fetchProject,
  fetchProjectRelationshipSignatures,
  fetchRepositoryMetadata,
  checkRemoteChanges,
  type RawProjectItem,
} from "../../github/projects.js";
import { fetchAllIssueRelationshipLinks } from "../../github/sub-issues.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchSignatures = vi.mocked(fetchProjectRelationshipSignatures);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);
const mockFetchLinks = vi.mocked(fetchAllIssueRelationshipLinks);

const LAST_PULL_AT = "2026-07-01T00:00:00Z";
/** 全 Issue の updatedAt。関係変更では動かないため、テスト全体で固定 */
const UNCHANGED_AT = "2026-06-30T00:00:00Z";
const REPO = "stanah/gh-gantt";

function id(issueNumber: number): string {
  return `${REPO}#${issueNumber}`;
}

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

function makeTask(issueNumber: number, overrides: Partial<Task> = {}): Task {
  return {
    id: id(issueNumber),
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
    updated_at: UNCHANGED_AT,
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

/** タスク集合から関係シグネチャを導出する。blocking_total は他タスクの blocked_by に現れる数 */
function signatureOf(task: Task, all: Task[]): RelationshipSignature {
  return {
    parent: task.parent,
    sub_issues_total: task.sub_tasks.length,
    blocked_by_total: task.blocked_by.length,
    blocking_total: all.filter((t) => t.blocked_by.some((d) => d.task === task.id)).length,
  };
}

function makeProjectItem(
  issueNumber: number,
  relationships: RelationshipSignature,
): RawProjectItem {
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
      updatedAt: UNCHANGED_AT,
      closedAt: null,
      issueType: null,
      repository: REPO,
      linkedPullRequests: [],
      relationships,
    },
  };
}

/** GitHub 側の現在状態 (tasks) から project items と pre-check 用シグネチャを組み立てる */
function mockRemote(remoteTasks: Task[]): void {
  mockFetchProject.mockResolvedValue({
    projectNodeId: "PVT_1",
    projectTitle: "Test",
    fields: [],
    items: remoteTasks.map((t) => makeProjectItem(t.github_issue!, signatureOf(t, remoteTasks))),
  });
  mockFetchSignatures.mockResolvedValue(
    remoteTasks.map((t) => ({
      number: t.github_issue!,
      repository: REPO,
      relationships: signatureOf(t, remoteTasks),
    })),
  );
}

function makeSnapshot(
  task: Task,
  all: Task[],
  opts: { withSignature: boolean },
): SyncState["snapshots"][string] {
  const hash = hashTask(task);
  return {
    hash,
    remoteHash: hash,
    synced_at: LAST_PULL_AT,
    updated_at: task.updated_at,
    syncFields: extractSyncFields(task),
    ...(opts.withSignature ? { relationships: signatureOf(task, all) } : {}),
  };
}

function makeSyncState(tasks: Task[], opts = { withSignature: true }): SyncState {
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
    snapshots: Object.fromEntries(tasks.map((t) => [t.id, makeSnapshot(t, tasks, opts)])),
  };
}

function makeTasksFile(tasks: Task[]): TasksFile {
  return { tasks, cache: { comments: {}, reactions: {} } } as unknown as TasksFile;
}

function dep(task: string) {
  return { task, type: "finish-to-start" as const, lag: 0 };
}

/** 同期済み状態: 親 #1 → 子 #2, #3。#4 は独立 */
function makeSyncedTasks(): Task[] {
  return [
    makeTask(1, { sub_tasks: [id(2), id(3)] }),
    makeTask(2, { parent: id(1) }),
    makeTask(3, { parent: id(1) }),
    makeTask(4),
  ];
}

/** GitHub Web UI で #4 を #1 の sub-issue に追加した後の状態。updated_at は誰も動かない */
function makeRemoteAfterSubIssueAdded(): Task[] {
  return [
    makeTask(1, { sub_tasks: [id(2), id(3), id(4)] }),
    makeTask(2, { parent: id(1) }),
    makeTask(3, { parent: id(1) }),
    makeTask(4, { parent: id(1) }),
  ];
}

function fetchedNumbers(): number[] {
  return mockFetchLinks.mock.calls[0]![1].map((item) => item.number);
}

describe("[NFR-STABILITY-001-AC7] [NFR-SYNC-002-AC2] [Issue #377] pull が親子・blocked_by の変更を updated_at に依存せず検出する", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoMeta.mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    });
    mockFetchLinks.mockResolvedValue({ subIssueLinks: [], blockedByLinks: [] });
  });

  it("since クエリが変化なしでも sub-issue 追加を pre-check で検出し親子関係を取り込む", async () => {
    const synced = makeSyncedTasks();
    // GitHub の updatedAt ベースの pre-check は関係変更を見ない (実測)
    mockCheckRemote.mockResolvedValue(false);
    mockRemote(makeRemoteAfterSubIssueAdded());
    mockFetchLinks.mockResolvedValue({
      subIssueLinks: [
        { parentNumber: 1, parentRepo: REPO, childNumber: 2, childRepo: REPO },
        { parentNumber: 1, parentRepo: REPO, childNumber: 3, childRepo: REPO },
        { parentNumber: 1, parentRepo: REPO, childNumber: 4, childRepo: REPO },
      ],
      blockedByLinks: [],
    });

    const { result, tasksFile, syncState } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(synced),
      makeSyncState(synced),
    );

    expect(result.skipped).toBe(false);
    expect(mockFetchProject).toHaveBeenCalledOnce();
    // 関係が変わった #1 (sub-issue 件数) と #4 (parent) だけ関係リンクを取り直す
    expect(fetchedNumbers()).toEqual([1, 4]);

    const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
    expect(byId.get(id(4))?.parent).toBe(id(1));
    expect(byId.get(id(1))?.sub_tasks).toEqual([id(2), id(3), id(4)]);
    // 変わらなかった #2, #3 の親子は snapshot から再構成される
    expect(byId.get(id(2))?.parent).toBe(id(1));
    expect(byId.get(id(3))?.parent).toBe(id(1));
    // 観測したシグネチャが snapshot に保存され、次回は再取得しない
    expect(syncState.snapshots[id(1)]?.relationships?.sub_issues_total).toBe(3);
    expect(syncState.snapshots[id(4)]?.relationships?.parent).toBe(id(1));
  });

  it("全 Issue の updated_at が一致しても関係シグネチャが違えば quick-skip しない", async () => {
    const synced = makeSyncedTasks();
    // 別 Issue の更新等で since クエリは「変化あり」だが、items は updated_at 全一致
    mockCheckRemote.mockResolvedValue(true);
    mockRemote(makeRemoteAfterSubIssueAdded());
    mockFetchLinks.mockResolvedValue({
      subIssueLinks: [{ parentNumber: 1, parentRepo: REPO, childNumber: 4, childRepo: REPO }],
      blockedByLinks: [],
    });

    const { result, tasksFile } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(synced),
      makeSyncState(synced),
    );

    expect(result.skipped).toBe(false);
    expect(mockFetchSignatures).not.toHaveBeenCalled();
    expect(fetchedNumbers()).toEqual([1, 4]);
    expect(tasksFile.tasks.find((t) => t.id === id(4))?.parent).toBe(id(1));
  });

  it("sub-issue の削除も検出し、古い親子の辺が残らない", async () => {
    const synced = makeSyncedTasks();
    // GitHub Web UI で #3 を #1 の sub-issue から外した
    mockCheckRemote.mockResolvedValue(false);
    mockRemote([
      makeTask(1, { sub_tasks: [id(2)] }),
      makeTask(2, { parent: id(1) }),
      makeTask(3),
      makeTask(4),
    ]);
    mockFetchLinks.mockResolvedValue({
      subIssueLinks: [{ parentNumber: 1, parentRepo: REPO, childNumber: 2, childRepo: REPO }],
      blockedByLinks: [],
    });

    const { result, tasksFile } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(synced),
      makeSyncState(synced),
    );

    expect(result.skipped).toBe(false);
    expect(fetchedNumbers()).toEqual([1, 3]);
    const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
    expect(byId.get(id(3))?.parent).toBeNull();
    expect(byId.get(id(1))?.sub_tasks).toEqual([id(2)]);
  });

  it("blocked_by の追加を blocked 側と blocker 側の件数で検出する", async () => {
    const synced = makeSyncedTasks();
    // GitHub Web UI で #3 を #4 に blocked にした。updated_at はどちらも動かない
    mockCheckRemote.mockResolvedValue(false);
    mockRemote([
      makeTask(1, { sub_tasks: [id(2), id(3)] }),
      makeTask(2, { parent: id(1) }),
      makeTask(3, { parent: id(1), blocked_by: [dep(id(4))] }),
      makeTask(4),
    ]);
    mockFetchLinks.mockResolvedValue({
      subIssueLinks: [{ parentNumber: 1, parentRepo: REPO, childNumber: 3, childRepo: REPO }],
      blockedByLinks: [
        { blockedNumber: 3, blockedRepo: REPO, blockingNumber: 4, blockingRepo: REPO },
      ],
    });

    const { result, tasksFile } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(synced),
      makeSyncState(synced),
    );

    expect(result.skipped).toBe(false);
    expect(fetchedNumbers()).toEqual([3, 4]);
    const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
    expect(byId.get(id(3))?.blocked_by).toEqual([dep(id(4))]);
    // 親子は変わっていないので #1 の sub_tasks は snapshot と取得結果の合成で維持される
    expect(byId.get(id(1))?.sub_tasks).toEqual([id(2), id(3)]);
  });

  it("シグネチャの無い旧形式 snapshot は stale 扱いで関係リンクを再取得し、次回から保存される", async () => {
    const synced = makeSyncedTasks();
    mockCheckRemote.mockResolvedValue(true);
    mockRemote(synced);

    const first = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(synced),
      makeSyncState(synced, { withSignature: false }),
    );

    // 旧形式では関係が変わったか判断できないため全 Issue を取り直す (安全側)
    expect(first.result.skipped).toBe(false);
    expect(fetchedNumbers()).toEqual([1, 2, 3, 4]);
    for (const t of synced) {
      expect(first.syncState.snapshots[t.id]?.relationships).toEqual(signatureOf(t, synced));
    }

    // 2 回目: シグネチャが保存されたので同じ remote なら quick-skip できる
    mockFetchLinks.mockClear();
    const second = await executePull(
      vi.fn() as never,
      makeConfig(),
      first.tasksFile,
      first.syncState,
    );
    expect(second.result.skipped).toBe(true);
    expect(mockFetchLinks).not.toHaveBeenCalled();
  });

  it("関係もシグネチャも変わっていなければ pre-check で skip し fetchProject を呼ばない", async () => {
    const synced = makeSyncedTasks();
    mockCheckRemote.mockResolvedValue(false);
    mockRemote(synced);

    const { result } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(synced),
      makeSyncState(synced),
    );

    expect(result.skipped).toBe(true);
    expect(mockFetchSignatures).toHaveBeenCalledOnce();
    expect(mockFetchProject).not.toHaveBeenCalled();
    expect(mockFetchLinks).not.toHaveBeenCalled();
  });

  it("関係シグネチャの pre-check に失敗した場合はフル fetch にフォールバックする", async () => {
    const synced = makeSyncedTasks();
    mockCheckRemote.mockResolvedValue(false);
    mockRemote(synced);
    mockFetchSignatures.mockRejectedValue(new Error("network"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = await executePull(
      vi.fn() as never,
      makeConfig(),
      makeTasksFile(synced),
      makeSyncState(synced),
    );

    // フル fetch の結果 items は snapshot と全一致するので quick-skip で終わる
    expect(mockFetchProject).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("フル fetch にフォールバック"));
    warn.mockRestore();
  });
});
