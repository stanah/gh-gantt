import type { Config, SyncState, TasksFile } from "@gh-gantt/shared";
import { createGraphQLClient } from "../../github/client.js";
import type { ProjectStorageSession } from "../../store/project-storage.js";
import { hasUnresolvedMarkers } from "../../sync/conflict-marker.js";
import { computeLocalDiff } from "../../sync/diff.js";
import { executePush, type PushResult } from "../../sync/push-executor.js";

export interface WriteThroughPushOptions {
  push?: boolean;
  createClient?: typeof createGraphQLClient;
  atomicTargetGroups?: readonly (readonly string[])[];
}

export interface WriteThroughPushResult {
  status: "disabled" | "no-targets" | "pushed";
  result?: PushResult;
}

function rollbackAtomicGroupSnapshots(
  beforePush: SyncState,
  afterPush: SyncState,
  groupIds: readonly string[],
): SyncState {
  const snapshots = { ...afterPush.snapshots };
  for (const id of groupIds) {
    const beforeSnapshot = beforePush.snapshots[id];
    if (!beforeSnapshot) {
      delete snapshots[id];
      continue;
    }
    const updatedAt = afterPush.snapshots[id]?.updated_at;
    snapshots[id] = {
      ...beforeSnapshot,
      ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    };
  }
  return { ...afterPush, snapshots };
}

export async function executeWriteThroughPush(
  storage: ProjectStorageSession,
  config: Config,
  tasksFile: TasksFile,
  targetTaskIds: readonly string[],
  options: WriteThroughPushOptions = {},
): Promise<WriteThroughPushResult> {
  if (options.push === false || config.sync.auto_push === false) {
    return { status: "disabled" };
  }

  const targetIds = new Set(targetTaskIds);
  const tasksById = new Map(tasksFile.tasks.map((task) => [task.id, task]));
  const groupedIds = new Set<string>();
  const eligibleIds = new Set<string>();
  const eligibleAtomicGroups: string[][] = [];
  for (const configuredGroup of options.atomicTargetGroups ?? []) {
    const groupIds = [...new Set(configuredGroup.filter((id) => targetIds.has(id)))];
    if (groupIds.length === 0) continue;
    for (const id of groupIds) groupedIds.add(id);

    const hasConflict = groupIds.some((id) => {
      const task = tasksById.get(id);
      return task && hasUnresolvedMarkers(task as unknown as Record<string, unknown>);
    });
    if (hasConflict) {
      console.warn(
        `未解決のコンフリクトがあるため atomic auto-push group をスキップしました: ${groupIds.join(", ")}`,
      );
      continue;
    }

    const existingGroupIds = groupIds.filter((id) => tasksById.has(id));
    for (const id of existingGroupIds) eligibleIds.add(id);
    if (existingGroupIds.length > 0) eligibleAtomicGroups.push(existingGroupIds);
  }

  for (const id of targetIds) {
    if (groupedIds.has(id)) continue;
    const task = tasksById.get(id);
    if (!task) continue;
    if (hasUnresolvedMarkers(task as unknown as Record<string, unknown>)) {
      console.warn(`未解決のコンフリクトがあるため auto-push をスキップしました: ${task.id}`);
      continue;
    }
    eligibleIds.add(task.id);
  }

  if (eligibleIds.size === 0) {
    return { status: "no-targets" };
  }

  const syncState = await storage.stateStore.read();
  const pendingIds = computeLocalDiff(tasksFile.tasks, syncState)
    .map((diff) => diff.id)
    .filter((id) => eligibleIds.has(id));
  if (pendingIds.length === 0) {
    return { status: "no-targets" };
  }

  const createClient = options.createClient ?? createGraphQLClient;
  const gql = await createClient();
  const {
    result,
    tasksFile: updatedTasksFile,
    syncState: updatedSyncState,
  } = await executePush(gql, config, tasksFile, syncState, {
    targetTaskIds: pendingIds,
    saveProgress: async (nextTasksFile, nextSyncState) => {
      await storage.tasksStore.write(nextTasksFile);
      await storage.stateStore.write(nextSyncState);
      await storage.flush();
    },
  });

  const pendingIdSet = new Set(pendingIds);
  let finalSyncState = updatedSyncState;
  let remainingIds = new Set(
    computeLocalDiff(updatedTasksFile.tasks, finalSyncState)
      .map((diff) => diff.id)
      .filter((id) => pendingIdSet.has(id)),
  );
  for (const groupIds of eligibleAtomicGroups) {
    const pendingGroupIds = groupIds.filter((id) => pendingIdSet.has(id));
    if (!pendingGroupIds.some((id) => remainingIds.has(id))) continue;
    finalSyncState = rollbackAtomicGroupSnapshots(syncState, finalSyncState, pendingGroupIds);
  }
  remainingIds = new Set(
    computeLocalDiff(updatedTasksFile.tasks, finalSyncState)
      .map((diff) => diff.id)
      .filter((id) => pendingIdSet.has(id)),
  );

  await storage.tasksStore.write(updatedTasksFile);
  await storage.stateStore.write(finalSyncState);
  await storage.flush();

  if (remainingIds.size > 0) {
    throw new Error(
      `auto-push 後もローカル差分が残っています: ${[...remainingIds].sort().join(", ")}`,
    );
  }

  return { status: "pushed", result };
}
