import { describe, expect, it } from "vitest";
import type { SyncState, Task } from "@gh-gantt/shared";
import { countRemoteChanges } from "../../commands/status.js";
import { hashTask } from "../../sync/hash.js";

function makeTask(updatedAt: string, overrides: Partial<Task> = {}): Task {
  return {
    id: "stanah/gh-gantt#139",
    type: "task",
    github_issue: 139,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: "context コマンド新設",
    body: null,
    state: "closed",
    state_reason: "COMPLETED",
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-04-05T12:46:03Z",
    updated_at: updatedAt,
    closed_at: "2026-05-03T15:09:50Z",
    custom_fields: {
      "End Date": "2026-04-30",
      "Start Date": "2026-04-25",
      Status: "Done",
      Title: "context コマンド新設",
    },
    start_date: "2026-04-25",
    end_date: "2026-04-30",
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeSyncState(snapshotTask: Task, overrides: Partial<SyncState> = {}): SyncState {
  const hash = hashTask(snapshotTask);
  return {
    last_synced_at: "2026-05-03T15:10:26.877Z",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots: {
      [snapshotTask.id]: {
        hash,
        remoteHash: hash,
        synced_at: "2026-05-03T15:10:26.877Z",
        updated_at: snapshotTask.updated_at,
        syncFields: {
          title: snapshotTask.title,
          body: snapshotTask.body,
          state: snapshotTask.state,
          type: snapshotTask.type,
          assignees: snapshotTask.assignees,
          labels: snapshotTask.labels,
          milestone: snapshotTask.milestone,
          custom_fields: snapshotTask.custom_fields,
          parent: snapshotTask.parent,
          sub_tasks: snapshotTask.sub_tasks,
          start_date: snapshotTask.start_date,
          end_date: snapshotTask.end_date,
          date: snapshotTask.date,
          blocked_by: snapshotTask.blocked_by,
        },
      },
    },
    ...overrides,
  };
}

describe("[NFR-STABILITY-001-AC5] [Issue #197] status remote_changed の stale updated_at 誤検出", () => {
  it("remote updated_at が last_synced_at より古く hash も一致する場合は remote_changed に数えない", () => {
    const snapshotTask = makeTask("2026-05-03T15:09:00Z");
    const remoteTask = makeTask("2026-05-03T15:09:50Z");
    const syncState = makeSyncState(snapshotTask);

    expect(countRemoteChanges([remoteTask], syncState)).toBe(0);
  });

  it("remote updated_at が last_synced_at より新しい場合は hash 一致でも remote_changed に数える", () => {
    const snapshotTask = makeTask("2026-05-03T15:09:00Z");
    const remoteTask = makeTask("2026-05-03T15:11:00Z");
    const syncState = makeSyncState(snapshotTask);

    expect(countRemoteChanges([remoteTask], syncState)).toBe(1);
  });

  it("snapshot.updated_at がない旧 sync-state では hash 差分を remote_changed に数える", () => {
    const snapshotTask = makeTask("2026-05-03T15:09:00Z");
    const remoteTask = makeTask("2026-05-03T15:09:50Z", { title: "context コマンド新設を更新" });
    const syncState = makeSyncState(snapshotTask);
    delete syncState.snapshots[snapshotTask.id]!.updated_at;

    expect(countRemoteChanges([remoteTask], syncState)).toBe(1);
  });
});
