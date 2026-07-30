/**
 * [Issue #318] pull の quick-skip と push の stale check が食い違い、
 * pull --force が必要になるデッドロックのリグレッションテスト。
 *
 * デッドロックの機序:
 * 1. 最終 pull (watermark T0) 以降に、GitHub 側で Issue X の updatedAt だけが変わる
 *    (PR マージによる自動クローズ関連の更新や sub-issue 関係の設定。内容ハッシュは同一)
 * 2. 別タスク Y を push する。旧実装は push 完了時に last_synced_at を現在時刻へ進めるが、
 *    snapshot を更新するのは push 対象 (Y) のみ。X の bump 時刻は新しい watermark より
 *    古くなり、pre-check (checkRemoteChanges since=last_synced_at) から永久に不可視になる
 * 3. pull → pre-check が「変化なし」→ quick-skip → X の snapshot.updated_at は stale のまま
 * 4. X をローカル更新して push → stale check (remote updatedAt ≠ snapshot.updated_at) が拒否
 * 5. 3 と 4 が無限ループし、pre-check と quick-skip を両方バイパスする pull --force のみが出口
 *
 * 修正: push は last_synced_at (pull の取り込み watermark) を進めない。
 * pull は fetch 開始前の時刻を watermark に採用し、sameIdSets quick-skip 成立時にも
 * watermark を前進させて pre-check の高速性を維持する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { executePush } from "../../sync/push-executor.js";
import { hashTask, extractSyncFields } from "../../sync/hash.js";
import {
  fetchProject,
  fetchRepositoryMetadata,
  checkRemoteChanges,
  type RawProjectItem,
} from "../../github/projects.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);

// ---- タイムライン定数 ----
// 実時刻 (テスト実行時) より過去であることが重要: 旧実装では push が last_synced_at を
// 現在時刻へ進めるため、外部 bump (X_UPDATED_AT_BUMPED) が pre-check の since より古くなる
const LAST_PULL_AT = "2026-07-01T00:00:00Z";
const X_UPDATED_AT_OLD = "2026-06-30T00:00:00Z";
const Y_UPDATED_AT_OLD = "2026-06-29T00:00:00Z";
/** 外部イベント (PR マージ自動クローズ関連等) による X の updatedAt のみの bump */
const X_UPDATED_AT_BUMPED = "2026-07-02T00:00:00Z";
/** push の mutation により GitHub が進める Y / X の updatedAt */
const Y_UPDATED_AT_AFTER_PUSH = "2026-07-02T01:00:00Z";
const X_UPDATED_AT_AFTER_PUSH = "2026-07-02T02:00:00Z";

const X_ID = "stanah/gh-gantt#10";
const Y_ID = "stanah/gh-gantt#20";

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

function makeTask(issueNumber: number, updatedAt: string, overrides: Partial<Task> = {}): Task {
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
    ...overrides,
  };
}

function makeProjectItem(
  issueNumber: number,
  updatedAt: string,
  overrides: Partial<NonNullable<RawProjectItem["content"]>> = {},
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
      updatedAt,
      closedAt: null,
      issueType: null,
      repository: "stanah/gh-gantt",
      linkedPullRequests: [],
      ...overrides,
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

function idMapEntry(issueNumber: number) {
  return {
    issue_number: issueNumber,
    issue_node_id: `I_${issueNumber}`,
    project_item_id: `PVTI_${issueNumber}`,
  };
}

function makeTasksFile(tasks: Task[]): TasksFile {
  return { tasks, cache: { comments: {}, reactions: {} } } as unknown as TasksFile;
}

/**
 * push 用の gql mock。
 * - Issue.updatedAt のバッチ取得 (stale check と fetchFreshIssueMetadata の両方) は
 *   remoteUpdatedAt の現在値を返す
 * - updateIssue mutation は GitHub が updatedAt を進める挙動を bumpOnUpdate で模倣する
 */
function makePushGql(
  remoteUpdatedAt: Map<number, string>,
  bumpOnUpdate: Map<string, { issueNumber: number; to: string }>,
) {
  return vi.fn().mockImplementation(async (query: string, vars?: Record<string, unknown>) => {
    if (query.includes("issue(number:") && !query.includes("mutation")) {
      const numbers = [...query.matchAll(/issue\(number:\s*(\d+)\)/g)].map((m) => Number(m[1]));
      const repo: Record<string, unknown> = {};
      numbers.forEach((n, i) => {
        repo[`i${i}`] = {
          number: n,
          updatedAt: remoteUpdatedAt.get(n),
          stateReason: null,
          closedAt: null,
        };
      });
      return { repository: repo };
    }
    if (query.includes("updateIssue")) {
      const bump = bumpOnUpdate.get(String(vars?.issueId ?? ""));
      if (bump) remoteUpdatedAt.set(bump.issueNumber, bump.to);
      return { updateIssue: { issue: { id: vars?.issueId } } };
    }
    if (query.includes("reopenIssue")) {
      return { reopenIssue: { issue: { id: vars?.issueId } } };
    }
    if (query.includes("closeIssue")) {
      return { closeIssue: { issue: { id: vars?.issueId } } };
    }
    return {};
  });
}

/** 実 GitHub の pre-check セマンティクスの模倣: since より後に更新された Issue があるか */
function mockPrecheckWithRemoteTimeline(bumpTimes: () => string[]): void {
  mockCheckRemote.mockImplementation(async (_gql, _owner, _repo, since) =>
    bumpTimes().some((t) => Date.parse(t) > Date.parse(since)),
  );
}

const pullGql = vi.fn();

describe("[NFR-STABILITY-001-AC6] [Issue #318] pull quick-skip と push stale check の食い違いによるデッドロック", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoMeta.mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    } as unknown as Awaited<ReturnType<typeof fetchRepositoryMetadata>>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("[Issue #318] 外部 bump → 別タスク push → pull が snapshot.updated_at を追従させ、直後の push が stale 拒否されない", async () => {
    const config = makeConfig();

    // 最終 pull 時点の状態: X / Y とも同期済み
    const baseX = makeTask(10, X_UPDATED_AT_OLD);
    const baseY = makeTask(20, Y_UPDATED_AT_OLD);
    const syncState: SyncState = {
      last_synced_at: LAST_PULL_AT,
      project_node_id: "PVT_1",
      id_map: { [X_ID]: idMapEntry(10), [Y_ID]: idMapEntry(20) },
      field_ids: {},
      snapshots: { [X_ID]: makeSnapshot(baseX), [Y_ID]: makeSnapshot(baseY) },
    };

    // リモートの現況: X は外部イベントで updatedAt のみ bump 済み (内容ハッシュ同一)
    const remoteUpdatedAt = new Map<number, string>([
      [10, X_UPDATED_AT_BUMPED],
      [20, Y_UPDATED_AT_OLD],
    ]);
    const gqlPush = makePushGql(
      remoteUpdatedAt,
      new Map([
        ["I_20", { issueNumber: 20, to: Y_UPDATED_AT_AFTER_PUSH }],
        ["I_10", { issueNumber: 10, to: X_UPDATED_AT_AFTER_PUSH }],
      ]),
    );

    // Step 1: Y だけをローカル更新して push (X は push 対象外)
    const localY = makeTask(20, Y_UPDATED_AT_OLD, { title: "Issue 20 (edited locally)" });
    const push1 = await executePush(
      gqlPush as never,
      config,
      makeTasksFile([baseX, localY]),
      syncState,
    );
    expect(push1.result.updated).toBe(1);

    // push は pull の取り込み watermark を進めてはならない。
    // 旧実装はここで last_synced_at を現在時刻へ進め、X の bump (過去時刻) を
    // pre-check から永久に不可視にしていた
    expect(push1.syncState.last_synced_at).toBe(LAST_PULL_AT);

    // Step 2: pull。pre-check は実 GitHub 同様「since より後に更新された Issue があるか」で判定
    mockPrecheckWithRemoteTimeline(() => [X_UPDATED_AT_BUMPED, Y_UPDATED_AT_AFTER_PUSH]);
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [
        // X: 内容同一・updatedAt のみ bump
        makeProjectItem(10, X_UPDATED_AT_BUMPED),
        // Y: push した内容が反映済み
        makeProjectItem(20, Y_UPDATED_AT_AFTER_PUSH, { title: "Issue 20 (edited locally)" }),
      ],
    });

    const pull = await executePull(pullGql as never, config, push1.tasksFile, push1.syncState);

    // 旧実装: pre-check が「変化なし」と誤判定して quick-skip → snapshot は stale のまま
    expect(pull.result.skipped).toBe(false);
    expect(pull.syncState.snapshots[X_ID]!.updated_at).toBe(X_UPDATED_AT_BUMPED);
    // 内容は同一なので更新カウントは増えない
    expect(pull.result.updated).toBe(0);

    // Step 3: X をローカル更新して push → stale 拒否されないこと
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const taskX = pull.tasksFile.tasks.find((t) => t.id === X_ID)!;
      taskX.title = "Issue 10 (edited)";

      const push2 = await executePush(gqlPush as never, config, pull.tasksFile, pull.syncState);

      expect(push2.result.updated).toBe(1);
      const staleMessage = errorSpy.mock.calls.find((c) =>
        String(c[0]).includes("リモートが更新されています"),
      );
      expect(staleMessage).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("[Issue #318] push は last_synced_at (pull の取り込み watermark) を進めない", async () => {
    const config = makeConfig();
    const baseY = makeTask(20, Y_UPDATED_AT_OLD);
    const syncState: SyncState = {
      last_synced_at: LAST_PULL_AT,
      project_node_id: "PVT_1",
      id_map: { [Y_ID]: idMapEntry(20) },
      field_ids: {},
      snapshots: { [Y_ID]: makeSnapshot(baseY) },
    };

    const remoteUpdatedAt = new Map<number, string>([[20, Y_UPDATED_AT_OLD]]);
    const gqlPush = makePushGql(
      remoteUpdatedAt,
      new Map([["I_20", { issueNumber: 20, to: Y_UPDATED_AT_AFTER_PUSH }]]),
    );

    const localY = makeTask(20, Y_UPDATED_AT_OLD, { title: "Issue 20 (edited locally)" });
    const { syncState: newState, result } = await executePush(
      gqlPush as never,
      config,
      makeTasksFile([localY]),
      syncState,
    );

    expect(result.updated).toBe(1);
    // push 対象の snapshot は更新される
    expect(newState.snapshots[Y_ID]!.updated_at).toBe(Y_UPDATED_AT_AFTER_PUSH);
    // watermark は最終 pull の時刻のまま
    expect(newState.last_synced_at).toBe(LAST_PULL_AT);
  });

  it("[Issue #318] sameIdSets quick-skip 成立時は last_synced_at を fetch 開始時刻へ前進させる", async () => {
    const pullStart = "2026-07-05T00:00:00.000Z";
    vi.useFakeTimers({ now: new Date(pullStart) });

    const config = makeConfig();
    const baseX = makeTask(10, X_UPDATED_AT_OLD);
    const syncState: SyncState = {
      last_synced_at: LAST_PULL_AT,
      project_node_id: "PVT_1",
      id_map: { [X_ID]: idMapEntry(10) },
      field_ids: {},
      snapshots: { [X_ID]: makeSnapshot(baseX) },
    };

    // pre-check は「変化あり」(push 対象外の Issue が更新された等) だが、
    // fetch した project データは snapshot と全一致 → quick-skip 成立
    mockCheckRemote.mockResolvedValue(true);
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10, X_UPDATED_AT_OLD)],
    });

    const { result, syncState: newState } = await executePull(
      pullGql as never,
      config,
      makeTasksFile([baseX]),
      syncState,
    );

    expect(result.skipped).toBe(true);
    // 全タスクの一致を確認済みなので watermark を fetch 開始時刻へ前進させてよい。
    // これを怠ると (push が watermark を進めなくなった修正後は) pre-check が
    // 二度と quick-skip できなくなる
    expect(newState.last_synced_at).toBe(pullStart);
  });

  it("[Issue #318] full pull の last_synced_at は fetch 開始前の時刻 (fetch 中の外部 bump を影に入れない)", async () => {
    const pullStart = "2026-07-05T00:00:00.000Z";
    const duringFetch = "2026-07-05T00:00:10.000Z";
    vi.useFakeTimers({ now: new Date(pullStart) });

    const config = makeConfig();
    const baseX = makeTask(10, X_UPDATED_AT_OLD);
    const syncState: SyncState = {
      last_synced_at: LAST_PULL_AT,
      project_node_id: "PVT_1",
      id_map: { [X_ID]: idMapEntry(10) },
      field_ids: {},
      snapshots: { [X_ID]: makeSnapshot(baseX) },
    };

    mockCheckRemote.mockResolvedValue(true);
    // fetch に時間がかかり、その間に時計が進む状況を模倣する
    mockFetchProject.mockImplementation(async () => {
      vi.setSystemTime(new Date(duringFetch));
      return {
        projectNodeId: "PVT_1",
        projectTitle: "Test",
        fields: [],
        items: [makeProjectItem(10, X_UPDATED_AT_BUMPED)],
      };
    });

    const { result, syncState: newState } = await executePull(
      pullGql as never,
      config,
      makeTasksFile([baseX]),
      syncState,
    );

    expect(result.skipped).toBe(false);
    // watermark が fetch 完了時刻 (duringFetch 以降) になると、fetch と完了の間に
    // 発生した外部 bump が pre-check から不可視になり #318 のレース窓が再発する
    expect(newState.last_synced_at).toBe(pullStart);
  });
});
