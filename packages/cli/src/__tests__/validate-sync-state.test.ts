/**
 * Tests for validateSyncState — Issue #123
 * sync-state の整合性検証と自動修復。
 */
import { describe, it, expect } from "vitest";
import { validateSyncState } from "../sync/validate-sync-state.js";
import type { SyncState, TasksFile, Task } from "@gh-gantt/shared";

function makeTask(id: string): Task {
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
  };
}

function makeSyncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    last_synced_at: "",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots: {},
    ...overrides,
  };
}

describe("validateSyncState [Issue #123]", () => {
  it("不整合が無い場合は同一の syncState を返し findings が空になる", () => {
    const task = makeTask("o/r#1");
    const tasksFile: TasksFile = { tasks: [task], cache: { comments: {}, reactions: {} } };
    const syncState = makeSyncState({
      id_map: { "o/r#1": { issue_number: 1, issue_node_id: "I1", project_item_id: "P1" } },
      snapshots: { "o/r#1": { hash: "h1", synced_at: "" } },
    });

    const { syncState: result, findings } = validateSyncState(syncState, tasksFile);

    expect(findings).toEqual([]);
    expect(result).toBe(syncState);
  });

  it("orphan snapshot (tasks にも id_map にも無い) を自動削除する", () => {
    const task = makeTask("o/r#1");
    const tasksFile: TasksFile = { tasks: [task], cache: { comments: {}, reactions: {} } };
    const syncState = makeSyncState({
      id_map: { "o/r#1": { issue_number: 1, issue_node_id: "I1", project_item_id: "P1" } },
      snapshots: {
        "o/r#1": { hash: "h1", synced_at: "" },
        "o/r#999": { hash: "h999", synced_at: "" }, // orphan
      },
    });

    const { syncState: result, findings } = validateSyncState(syncState, tasksFile);

    expect(result.snapshots["o/r#999"]).toBeUndefined();
    expect(result.snapshots["o/r#1"]).toBeDefined();
    const orphan = findings.find((f) => f.category === "orphan_snapshot");
    expect(orphan).toBeDefined();
    expect(orphan!.taskId).toBe("o/r#999");
    expect(orphan!.autoFixed).toBe(true);
  });

  it("hash が空文字列で tasks に存在しない snapshot を自動削除する", () => {
    const tasksFile: TasksFile = { tasks: [], cache: { comments: {}, reactions: {} } };
    const syncState = makeSyncState({
      id_map: { "o/r#1": { issue_number: 1, issue_node_id: "I1", project_item_id: "P1" } },
      snapshots: {
        "o/r#1": { hash: "", synced_at: "" }, // 不正な hash、tasks に無い
      },
    });

    const { syncState: result, findings } = validateSyncState(syncState, tasksFile);

    expect(result.snapshots["o/r#1"]).toBeUndefined();
    const invalid = findings.find((f) => f.category === "invalid_snapshot_hash");
    expect(invalid).toBeDefined();
    expect(invalid!.autoFixed).toBe(true);
  });

  it("hash が空文字列で tasks に存在する snapshot はローカル変更保護のため削除しない", () => {
    const task = makeTask("o/r#1");
    const tasksFile: TasksFile = { tasks: [task], cache: { comments: {}, reactions: {} } };
    const syncState = makeSyncState({
      id_map: { "o/r#1": { issue_number: 1, issue_node_id: "I1", project_item_id: "P1" } },
      snapshots: {
        "o/r#1": { hash: "", synced_at: "" }, // 不正な hash だが tasks に存在
      },
    });

    const { syncState: result, findings } = validateSyncState(syncState, tasksFile);

    // ローカル変更保護のため snapshot は保持される
    expect(result.snapshots["o/r#1"]).toBeDefined();
    const invalid = findings.find((f) => f.category === "invalid_snapshot_hash");
    expect(invalid).toBeDefined();
    expect(invalid!.autoFixed).toBe(false);
    expect(invalid!.message).toContain("--force");
  });

  it("orphan id_map (tasks に無い) は warn のみで自動削除しない", () => {
    const tasksFile: TasksFile = { tasks: [], cache: { comments: {}, reactions: {} } };
    const syncState = makeSyncState({
      id_map: { "o/r#5": { issue_number: 5, issue_node_id: "I1", project_item_id: "P1" } },
      snapshots: { "o/r#5": { hash: "h5", synced_at: "" } },
    });

    const { syncState: result, findings } = validateSyncState(syncState, tasksFile);

    // id_map はそのまま保持
    expect(result.id_map["o/r#5"]).toBeDefined();
    // snapshot も (id_map が参照するため) 残す
    expect(result.snapshots["o/r#5"]).toBeDefined();
    const orphanIdMap = findings.find((f) => f.category === "orphan_id_map");
    expect(orphanIdMap).toBeDefined();
    expect(orphanIdMap!.autoFixed).toBe(false);
    expect(orphanIdMap!.message).toContain("--force");
  });

  it("複数種類の不整合を同時に検出できる", () => {
    const task = makeTask("o/r#1");
    const tasksFile: TasksFile = { tasks: [task], cache: { comments: {}, reactions: {} } };
    const syncState = makeSyncState({
      id_map: {
        "o/r#1": { issue_number: 1, issue_node_id: "I1", project_item_id: "P1" },
        "o/r#2": { issue_number: 2, issue_node_id: "I1", project_item_id: "P1" }, // orphan id_map
      },
      snapshots: {
        "o/r#1": { hash: "h1", synced_at: "" },
        "o/r#2": { hash: "h2", synced_at: "" }, // id_map に紐づくため orphan ではない
        "o/r#999": { hash: "h999", synced_at: "" }, // orphan snapshot
      },
    });

    const { findings } = validateSyncState(syncState, tasksFile);

    expect(findings.filter((f) => f.category === "orphan_snapshot")).toHaveLength(1);
    expect(findings.filter((f) => f.category === "orphan_id_map")).toHaveLength(1);
  });

  it("自動修復が発生しない場合は元の syncState オブジェクトをそのまま返す (参照同一性)", () => {
    const task = makeTask("o/r#1");
    const tasksFile: TasksFile = { tasks: [task], cache: { comments: {}, reactions: {} } };
    const syncState = makeSyncState({
      id_map: { "o/r#2": { issue_number: 2, issue_node_id: "I1", project_item_id: "P1" } }, // orphan id_map (warn only, no mutation)
      snapshots: {},
    });

    const { syncState: result } = validateSyncState(syncState, tasksFile);

    // warn only なので元のオブジェクトと同一参照
    expect(result).toBe(syncState);
  });

  describe("[NFR-STABILITY-001-AC4] [Issue #167] missing_id_map の検出", () => {
    it("tasks.json にあるが id_map に無い非 draft タスクを検出する", () => {
      const task = makeTask("o/r#10");
      const tasksFile: TasksFile = { tasks: [task], cache: { comments: {}, reactions: {} } };
      const syncState = makeSyncState({
        id_map: {}, // #10 のエントリが欠けている
      });

      const { findings } = validateSyncState(syncState, tasksFile);

      const missing = findings.find((f) => f.category === "missing_id_map");
      expect(missing).toBeDefined();
      expect(missing!.taskId).toBe("o/r#10");
      expect(missing!.level).toBe("info");
      // 次回 pull で自動修復されるため autoFixed=false (validate 自体では直せない) かつメッセージで自動修復を予告する
      expect(missing!.autoFixed).toBe(false);
      expect(missing!.message).toMatch(/pull/);
    });

    it("draft タスクは missing_id_map として検出されない (仕様通り id_map に入らない)", () => {
      const draftTask = makeTask("o/r#draft-1");
      const tasksFile: TasksFile = { tasks: [draftTask], cache: { comments: {}, reactions: {} } };
      const syncState = makeSyncState({ id_map: {} });

      const { findings } = validateSyncState(syncState, tasksFile);

      const missing = findings.filter((f) => f.category === "missing_id_map");
      expect(missing).toHaveLength(0);
    });

    it("milestone 合成タスクは missing_id_map として検出されない (id_map を使わない)", () => {
      // milestone 合成 ID は "milestone:<repo>#<number>" 形式 (buildMilestoneSyntheticId 参照)
      const milestoneTask = makeTask("milestone:o/r#1");
      const tasksFile: TasksFile = {
        tasks: [milestoneTask],
        cache: { comments: {}, reactions: {} },
      };
      const syncState = makeSyncState({ id_map: {} });

      const { findings } = validateSyncState(syncState, tasksFile);

      const missing = findings.filter((f) => f.category === "missing_id_map");
      expect(missing).toHaveLength(0);
    });

    it("複数の missing_id_map を列挙する", () => {
      const tasks = [makeTask("o/r#10"), makeTask("o/r#20"), makeTask("o/r#30")];
      const tasksFile: TasksFile = { tasks, cache: { comments: {}, reactions: {} } };
      const syncState = makeSyncState({
        id_map: {
          "o/r#20": { issue_number: 20, issue_node_id: "I20", project_item_id: "P20" },
        },
      });

      const { findings } = validateSyncState(syncState, tasksFile);

      const missing = findings.filter((f) => f.category === "missing_id_map");
      expect(missing).toHaveLength(2);
      expect(missing.map((f) => f.taskId).sort()).toEqual(["o/r#10", "o/r#30"]);
    });
  });
});
