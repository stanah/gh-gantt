import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config, SyncState, TasksFile, Task } from "@gh-gantt/shared";

// executePull は内部で fetchProject, checkRemoteChanges 等を呼ぶ。
// pull-precheck.test.ts と同じ mock 方針を採用する。
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
import {
  fetchProject,
  fetchRepositoryMetadata,
  checkRemoteChanges,
  type RawProjectItem,
} from "../../github/projects.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);

/**
 * テスト用の最小 Config を構築する。
 * 本リグレッションテストで参照される Config のパスは限定的だが、
 * Config インターフェースの必須フィールドはすべて満たす。
 * 型アサーションを使わず satisfies で shape を検証することで、
 * 将来 Config に必須フィールドが追加された際にコンパイルエラーで気付けるようにする。
 */
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

/**
 * GraphQL の projectV2.items.nodes 相当を模した RawProjectItem を生成する。
 * id_map の 3 フィールド (issue_number, issue_node_id, project_item_id) が
 * 正しく伝搬するかを検証するため、各フィールドに一意な値を持たせる。
 */
function makeProjectItem(issueNumber: number): RawProjectItem {
  return {
    id: `PVTI_${issueNumber}`, // → project_item_id
    fieldValues: {},
    content: {
      nodeId: `I_${issueNumber}`, // → issue_node_id
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      body: null,
      state: "open",
      stateReason: null,
      assignees: [],
      labels: [],
      milestone: null,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
      closedAt: null,
      issueType: null,
      repository: "stanah/gh-gantt",
    },
  };
}

function makeDraftTask(draftNumber: number): Task {
  return {
    id: `stanah/gh-gantt#draft-${draftNumber}`,
    type: "task",
    github_issue: null,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: `Draft ${draftNumber}`,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-04-11T00:00:00Z",
    updated_at: "2026-04-11T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
  };
}

const gql = vi.fn();

describe("[NFR-STABILITY-001-AC3] [Issue #167] pull が id_map を authoritative に rebuild する", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoMeta.mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    } as unknown as Awaited<ReturnType<typeof fetchRepositoryMetadata>>);
    mockCheckRemote.mockResolvedValue(true);
  });

  it("空の id_map + pull → projectData.items から全エントリが populate される", async () => {
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10), makeProjectItem(20), makeProjectItem(30)],
    });

    const { syncState: newState } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile(),
      makeSyncState({ id_map: {} }),
      { force: true },
    );

    expect(Object.keys(newState.id_map).sort()).toEqual([
      "stanah/gh-gantt#10",
      "stanah/gh-gantt#20",
      "stanah/gh-gantt#30",
    ]);
    expect(newState.id_map["stanah/gh-gantt#10"]).toEqual({
      issue_number: 10,
      issue_node_id: "I_10",
      project_item_id: "PVTI_10",
    });
  });

  it("欠けた id_map エントリが pull で補完される (セルフヒーリング)", async () => {
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10), makeProjectItem(20), makeProjectItem(30)],
    });

    // #10 のみ存在し、#20 / #30 は欠けている破損状態を再現
    const brokenState = makeSyncState({
      id_map: {
        "stanah/gh-gantt#10": {
          issue_number: 10,
          issue_node_id: "I_10",
          project_item_id: "PVTI_10",
        },
      },
    });

    const { syncState: newState } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile(),
      brokenState,
      { force: true },
    );

    expect(Object.keys(newState.id_map).sort()).toEqual([
      "stanah/gh-gantt#10",
      "stanah/gh-gantt#20",
      "stanah/gh-gantt#30",
    ]);
    expect(newState.id_map["stanah/gh-gantt#20"]).toEqual({
      issue_number: 20,
      issue_node_id: "I_20",
      project_item_id: "PVTI_20",
    });
  });

  it("orphan id_map エントリ (project に存在しない) は pull で削除される", async () => {
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10)],
    });

    // #999 は project に存在しないのに id_map に残っている状態
    const orphanState = makeSyncState({
      id_map: {
        "stanah/gh-gantt#999": {
          issue_number: 999,
          issue_node_id: "I_999",
          project_item_id: "PVTI_999",
        },
      },
    });

    const { syncState: newState } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile(),
      orphanState,
      { force: true },
    );

    expect(Object.keys(newState.id_map)).toEqual(["stanah/gh-gantt#10"]);
    expect(newState.id_map["stanah/gh-gantt#999"]).toBeUndefined();
  });

  it("stale な issue_node_id は pull で最新値に更新される", async () => {
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10)], // nodeId = I_10
    });

    // 古い node_id を持つ id_map (例: project から detach 後に再 attach された場合)
    const staleState = makeSyncState({
      id_map: {
        "stanah/gh-gantt#10": {
          issue_number: 10,
          issue_node_id: "I_OLD",
          project_item_id: "PVTI_OLD",
        },
      },
    });

    const { syncState: newState } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile(),
      staleState,
      { force: true },
    );

    expect(newState.id_map["stanah/gh-gantt#10"]).toEqual({
      issue_number: 10,
      issue_node_id: "I_10",
      project_item_id: "PVTI_10",
    });
  });

  it("draft タスクは id_map に入らない (既存仕様の維持)", async () => {
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [makeProjectItem(10)],
    });

    const draftTask = makeDraftTask(1);

    const { syncState: newState } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile([draftTask]),
      makeSyncState({ id_map: {} }),
      { force: true },
    );

    // draft は projectData.items に含まれないため id_map に入らない
    expect(Object.keys(newState.id_map)).toEqual(["stanah/gh-gantt#10"]);
    expect(newState.id_map[draftTask.id]).toBeUndefined();
  });

  it("空 project (items が空配列) → id_map も空になる", async () => {
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [],
    });

    const populatedState = makeSyncState({
      id_map: {
        "stanah/gh-gantt#10": {
          issue_number: 10,
          issue_node_id: "I_10",
          project_item_id: "PVTI_10",
        },
      },
    });

    const { syncState: newState } = await executePull(
      gql as never,
      makeConfig(),
      makeTasksFile(),
      populatedState,
      { force: true },
    );

    expect(newState.id_map).toEqual({});
  });

  describe("セルフヒーリングのエンドツーエンド検証", () => {
    /**
     * tasks.json に存在するが id_map に無い破損タスクを表現するヘルパー。
     * ここでの makeSyncTask は pull 後に生成される Task の形状に合わせる。
     */
    function makeSyncTask(issueNumber: number): Task {
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
        updated_at: "2026-04-01T00:00:00Z",
        closed_at: null,
        custom_fields: {},
        start_date: null,
        end_date: null,
        date: null,
        blocked_by: [],
      };
    }

    it("破損 id_map で非 force 呼び出しでも pre-check をバイパスしてフル fetch する", async () => {
      // pre-check は checkRemoteChanges を呼ぶ。通常「変化なし」で早期 return するが、
      // 破損した id_map を検出した場合はバイパスしてフル fetch すべき。
      mockCheckRemote.mockResolvedValue(false); // remote には変化なし
      mockFetchProject.mockResolvedValue({
        projectNodeId: "PVT_1",
        projectTitle: "Test",
        fields: [],
        items: [makeProjectItem(10)],
      });

      const brokenState = makeSyncState({
        id_map: {}, // #10 が欠けている
      });

      await executePull(
        gql as never,
        makeConfig(),
        makeTasksFile([makeSyncTask(10)]),
        brokenState,
        // force フラグ無し
      );

      // 破損検出により pre-check はバイパスされ fetchProject が呼ばれる
      expect(mockFetchProject).toHaveBeenCalled();
    });

    it("result.syncStateFindings に missing_id_map が列挙され、rebuild 後 autoFixed に promote される", async () => {
      mockFetchProject.mockResolvedValue({
        projectNodeId: "PVT_1",
        projectTitle: "Test",
        fields: [],
        items: [makeProjectItem(10), makeProjectItem(20)],
      });

      const brokenState = makeSyncState({
        id_map: {}, // #10 / #20 ともに欠けている
      });

      const { result } = await executePull(
        gql as never,
        makeConfig(),
        makeTasksFile([{ ...makeSyncTask(10) }, { ...makeSyncTask(20) }]),
        brokenState,
        { force: true },
      );

      const missing = result.syncStateFindings.filter((f) => f.category === "missing_id_map");
      expect(missing).toHaveLength(2);
      expect(missing.map((f) => f.taskId).sort()).toEqual([
        "stanah/gh-gantt#10",
        "stanah/gh-gantt#20",
      ]);
      // rebuild で補完された項目は autoFixed: true に promote される
      for (const f of missing) {
        expect(f.autoFixed).toBe(true);
        expect(f.message).toMatch(/自動補完しました/);
      }
    });

    it("連続 pull で 1 回目は heal、2 回目は finding なし (収束確認)", async () => {
      mockFetchProject.mockResolvedValue({
        projectNodeId: "PVT_1",
        projectTitle: "Test",
        fields: [],
        items: [makeProjectItem(10)],
      });

      // 1 回目: 破損状態で pull
      const brokenState = makeSyncState({ id_map: {} });
      const first = await executePull(
        gql as never,
        makeConfig(),
        makeTasksFile([makeSyncTask(10)]),
        brokenState,
        { force: true },
      );

      expect(Object.keys(first.syncState.id_map)).toEqual(["stanah/gh-gantt#10"]);
      expect(first.result.syncStateFindings.some((f) => f.category === "missing_id_map")).toBe(
        true,
      );

      // 2 回目: 1 回目の結果を使って再度 pull → findings は空
      const second = await executePull(
        gql as never,
        makeConfig(),
        first.tasksFile,
        first.syncState,
        { force: true },
      );

      expect(second.result.syncStateFindings.some((f) => f.category === "missing_id_map")).toBe(
        false,
      );
      // id_map は維持される
      expect(Object.keys(second.syncState.id_map)).toEqual(["stanah/gh-gantt#10"]);
    });

    it("sameIdSets quick-skip 経路でも id_map が rebuild される", async () => {
      // 破損した id_map だが、tasks.json とリモートの id セットは一致している
      mockFetchProject.mockResolvedValue({
        projectNodeId: "PVT_1",
        projectTitle: "Test",
        fields: [],
        items: [makeProjectItem(10)],
      });

      // remoteHash と snapshot が一致する状態を作る
      // (changed フラグが立たず sameIdSets quick-skip 経路に入る)
      // ここでは snapshot の updated_at を remote と一致させる
      const quickSkipState = makeSyncState({
        id_map: {}, // 破損
        snapshots: {
          "stanah/gh-gantt#10": {
            hash: "irrelevant",
            synced_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-01T00:00:00Z", // makeProjectItem の updatedAt と一致
          },
        },
      });

      // force なしで呼び出しても、missing_id_map 検出によって pre-check はバイパスされる
      // その後 fetchProject まで到達すれば sameIdSets quick-skip または通常パスを通る
      const { syncState: newState } = await executePull(
        gql as never,
        makeConfig(),
        makeTasksFile([makeSyncTask(10)]),
        quickSkipState,
      );

      // いずれの経路でも id_map は rebuild されていなければならない
      expect(newState.id_map["stanah/gh-gantt#10"]).toEqual({
        issue_number: 10,
        issue_node_id: "I_10",
        project_item_id: "PVTI_10",
      });
    });

    it("kept-local で detach されたタスクに対して missing_id_map finding が追加される", async () => {
      // シナリオ: pre-pull 状態は整合 (タスク #10 が tasks.json と id_map の両方にあり、
      // snapshot も存在する)。pull 中に projectData.items から #10 が消失 (detach) し、
      // ローカル変更があるため kept-local として mergedTasks に残される。
      // 結果として「tasks.json にあるが id_map に無い」状態が発生するが、pull 冒頭の
      // validateSyncState はこれを検出できない (pre-pull 時点では整合していたため)。
      // 返却前の再検証によって missing_id_map finding が追加されることを検証する。
      mockFetchProject.mockResolvedValue({
        projectNodeId: "PVT_1",
        projectTitle: "Test",
        fields: [],
        items: [], // #10 は project から detach された
      });

      const localTask = makeSyncTask(10);
      // ローカル変更を表現 (snapshot.hash と現在の hash が異なる状態)
      localTask.title = "Modified title locally";

      const preConsistentState = makeSyncState({
        id_map: {
          "stanah/gh-gantt#10": {
            issue_number: 10,
            issue_node_id: "I_10",
            project_item_id: "PVTI_10",
          },
        },
        snapshots: {
          "stanah/gh-gantt#10": {
            // 本物の hash と異なる値を入れることで「ローカル変更あり」を表現
            hash: "pre-modification-hash",
            synced_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-01T00:00:00Z",
          },
        },
      });

      const {
        result,
        tasksFile: newTasksFile,
        syncState: newState,
      } = await executePull(
        gql as never,
        makeConfig(),
        makeTasksFile([localTask]),
        preConsistentState,
        { force: true },
      );

      // kept-local で #10 は tasks.json に残る
      expect(newTasksFile.tasks.map((t) => t.id)).toContain("stanah/gh-gantt#10");
      // しかし newIdMap には入らない (projectData.items から消失したため)
      expect(newState.id_map["stanah/gh-gantt#10"]).toBeUndefined();

      // 返却前の再検証により missing_id_map finding が追加される
      const missing = result.syncStateFindings.find(
        (f) => f.category === "missing_id_map" && f.taskId === "stanah/gh-gantt#10",
      );
      expect(missing).toBeDefined();
      expect(missing!.level).toBe("info");
      // この finding は再検証由来なので autoFixed=false (rebuild で解消されていない)
      expect(missing!.autoFixed).toBe(false);
    });

    it("orphan_id_map finding が rebuild 後 autoFixed に promote される", async () => {
      // #10 は project に存在するが、id_map には #10 と #999 (orphan) の両方がある。
      // tasks.json には #10 のみ存在 → validateSyncState が #999 を orphan_id_map として
      // 検出する。rebuild 後、#999 は newIdMap から除去されるため autoFixed に promote
      // されるべき。
      mockFetchProject.mockResolvedValue({
        projectNodeId: "PVT_1",
        projectTitle: "Test",
        fields: [],
        items: [makeProjectItem(10)],
      });

      const stateWithOrphan = makeSyncState({
        id_map: {
          "stanah/gh-gantt#10": {
            issue_number: 10,
            issue_node_id: "I_10",
            project_item_id: "PVTI_10",
          },
          "stanah/gh-gantt#999": {
            issue_number: 999,
            issue_node_id: "I_999",
            project_item_id: "PVTI_999",
          },
        },
      });

      const { result, syncState: newState } = await executePull(
        gql as never,
        makeConfig(),
        makeTasksFile([makeSyncTask(10)]),
        stateWithOrphan,
        { force: true },
      );

      // #999 は newIdMap (= 新 id_map) から除去される
      expect(newState.id_map["stanah/gh-gantt#999"]).toBeUndefined();
      expect(newState.id_map["stanah/gh-gantt#10"]).toBeDefined();

      // orphan_id_map finding は autoFixed=true に promote され、
      // メッセージも過去形に書き換えられる
      const orphan = result.syncStateFindings.find(
        (f) => f.category === "orphan_id_map" && f.taskId === "stanah/gh-gantt#999",
      );
      expect(orphan).toBeDefined();
      expect(orphan!.autoFixed).toBe(true);
      expect(orphan!.level).toBe("info");
      expect(orphan!.message).toMatch(/自動解消しました/);
    });
  });
});
