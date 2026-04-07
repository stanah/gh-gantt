import { describe, it, expect, beforeEach } from "vitest";
import { resolveAll } from "../commands/resolve.js";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import type { Task, SyncState, Snapshot } from "@gh-gantt/shared";

describe("[Issue #152] resolve --theirs 後の snapshot.hash 更新", () => {
  let tasks: Record<string, unknown>[];
  let syncState: SyncState;
  let remoteHash: string;

  beforeEach(() => {
    // リモートタスク（完全版）
    const remoteTask: Task = {
      id: "owner/repo#8",
      title: "Fix login bug v2",
      body: "Updated description",
      state: "closed",
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
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      linked_prs: [],
    };
    remoteHash = hashTask(remoteTask);

    // コンフリクト状態のローカルタスク（Record<string, unknown>[] 形式）
    tasks = [
      {
        id: "owner/repo#8",
        title: "Fix login bug",
        body: "Original description",
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
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T12:00:00Z",
        linked_prs: [],
        // コンフリクトマーカー
        title_current: "Fix login bug",
        title_incoming: "Fix login bug v2",
        body_current: "Original description",
        body_incoming: "Updated description",
        state_current: "open",
        state_incoming: "closed",
      },
    ];

    // 既存の snapshot（コンフリクト検出前の状態）
    const localHash = "local-hash-123";
    const localTask: Task = {
      id: "owner/repo#8",
      title: "Fix login bug",
      body: "Original description",
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
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T12:00:00Z",
      linked_prs: [],
    };
    syncState = {
      last_synced_at: "2024-01-01T00:00:00Z",
      snapshots: {
        "owner/repo#8": {
          hash: localHash,
          synced_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T12:00:00Z",
          syncFields: extractSyncFields(localTask),
          remoteHash, // pull 時に設定されたリモートの hash
        },
      },
      field_ids: {},
      option_ids: {},
    };
  });

  it("--theirs で全フィールド解決時、snapshot.hash を remoteHash に更新", () => {
    // すべてのコンフリクトを --theirs で解決
    const theirsResolutions = resolveAll(tasks, "theirs");

    // マーカーが削除され、incoming 値が採用される
    expect(tasks[0].title).toBe("Fix login bug v2");
    expect(tasks[0].body).toBe("Updated description");
    expect(tasks[0].state).toBe("closed");
    expect(tasks[0]).not.toHaveProperty("title_current");
    expect(tasks[0]).not.toHaveProperty("title_incoming");

    // theirsResolutions に記録される
    expect(theirsResolutions.get("owner/repo#8")).toEqual(new Set(["title", "body", "state"]));

    // snapshot 更新ロジックを模擬
    const id = "owner/repo#8";
    const existing = syncState.snapshots[id];
    const taskTyped = tasks[0] as unknown as Task;
    const theirsFields = theirsResolutions.get(id);

    if (theirsFields && theirsFields.size > 0 && existing?.remoteHash) {
      // remoteHash をそのまま使用してタスクをリモートと同一状態にする
      syncState.snapshots[id] = {
        ...existing,
        hash: existing.remoteHash,
        syncFields: extractSyncFields(taskTyped),
      };
    }

    // 検証: snapshot.hash が remoteHash に更新されている
    expect(syncState.snapshots[id]?.hash).toBe(remoteHash);
    expect(syncState.snapshots[id]?.hash).not.toBe("local-hash-123");
  });

  it("--ours で解決時、snapshot.hash は更新しない（push 可能にするため）", () => {
    // すべてのコンフリクトを --ours で解決
    const theirsResolutions = resolveAll(tasks, "ours");

    // マーカーが削除され、current 値が採用される
    expect(tasks[0].title).toBe("Fix login bug");
    expect(tasks[0].body).toBe("Original description");
    expect(tasks[0].state).toBe("open");

    // theirsResolutions は空
    expect(theirsResolutions.size).toBe(0);

    // snapshot 更新ロジックを模擬
    const id = "owner/repo#8";
    const existing = syncState.snapshots[id];
    const taskTyped = tasks[0] as unknown as Task;
    const theirsFields = theirsResolutions.get(id);

    if (theirsFields && theirsFields.size > 0 && existing?.remoteHash) {
      syncState.snapshots[id] = {
        ...existing,
        hash: existing.remoteHash,
        syncFields: extractSyncFields(taskTyped),
      };
    } else {
      // --ours なので hash は更新しない
      syncState.snapshots[id] = {
        ...existing!,
        syncFields: extractSyncFields(taskTyped),
      };
    }

    // 検証: snapshot.hash は元のまま（ローカル変更として push 可能）
    expect(syncState.snapshots[id]?.hash).toBe("local-hash-123");
    expect(syncState.snapshots[id]?.hash).not.toBe(remoteHash);
  });

  it("混在解決（一部 --ours、一部 --theirs）時、snapshot.hash は更新しない", () => {
    // title と body を --theirs、state を --ours で解決
    let theirsResolutions = new Map<string, Set<string>>();

    // title と body を --theirs で解決
    tasks[0].title = tasks[0].title_incoming;
    tasks[0].body = tasks[0].body_incoming;
    delete tasks[0].title_current;
    delete tasks[0].title_incoming;
    delete tasks[0].body_current;
    delete tasks[0].body_incoming;

    // theirsResolutions に記録
    theirsResolutions.set("owner/repo#8", new Set(["title", "body"]));

    // state を --ours で解決（マーカーを削除）
    delete tasks[0].state_current;
    delete tasks[0].state_incoming;

    // 解決統計を設定
    const stats = {
      totalConflicts: 3, // title, body, state
      theirsCount: 2, // title, body のみ
    };

    // snapshot 更新ロジックを模擬
    const id = "owner/repo#8";
    const existing = syncState.snapshots[id];
    const taskTyped = tasks[0] as unknown as Task;

    // 一部のみ --theirs なので hash は更新しない
    const allResolvedWithTheirs =
      stats && stats.theirsCount > 0 && stats.theirsCount === stats.totalConflicts;

    if (allResolvedWithTheirs && existing?.remoteHash) {
      syncState.snapshots[id] = {
        ...existing,
        hash: existing.remoteHash,
        syncFields: extractSyncFields(taskTyped),
      };
    } else {
      syncState.snapshots[id] = {
        ...existing!,
        syncFields: extractSyncFields(taskTyped),
      };
    }

    // 検証: 一部のみ --theirs なので hash は元のまま（ローカル変更として push 可能）
    expect(syncState.snapshots[id]?.hash).toBe("local-hash-123");
    expect(syncState.snapshots[id]?.hash).not.toBe(remoteHash);
  });
});
