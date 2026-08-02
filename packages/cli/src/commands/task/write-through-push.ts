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
  tasksFile: TasksFile;
  result?: PushResult;
}

/** atomic group 失敗時に同期内容を戻し、取得済みの remote watermark だけを維持する。 */
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

/**
 * update / close / link が変更した既存 Issue を即時同期する。
 * draft の実体化は #298 の責務なので、remote API を呼ぶ前に fail-closed する。
 */
export async function executeWriteThroughPush(
  storage: ProjectStorageSession,
  config: Config,
  tasksFile: TasksFile,
  targetTaskIds: readonly string[],
  options: WriteThroughPushOptions = {},
): Promise<WriteThroughPushResult> {
  if (options.push === false || config.sync.auto_push === false) {
    return { status: "disabled", tasksFile };
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
    return { status: "no-targets", tasksFile };
  }

  const syncState = await storage.stateStore.read();
  const pendingIds = computeLocalDiff(tasksFile.tasks, syncState)
    .map((diff) => diff.id)
    .filter((id) => eligibleIds.has(id));
  if (pendingIds.length === 0) {
    return { status: "no-targets", tasksFile };
  }

  const unsupportedIds = pendingIds.filter((id) => tasksById.get(id)?.github_issue === null);
  if (unsupportedIds.length > 0) {
    throw new Error(
      `write-through push は既存 Issue のみ対象です: ${unsupportedIds.sort().join(", ")}`,
    );
  }

  const createClient = options.createClient ?? createGraphQLClient;
  const gql = await createClient();
  const pendingIdSet = new Set(pendingIds);
  const groupedPendingIds = new Set<string>();
  const executionUnits: Array<{ ids: string[]; atomic: boolean }> = [];
  for (const groupIds of eligibleAtomicGroups) {
    const pendingGroupIds = groupIds.filter((id) => pendingIdSet.has(id));
    if (pendingGroupIds.length === 0) continue;
    for (const id of pendingGroupIds) groupedPendingIds.add(id);
    executionUnits.push({ ids: pendingGroupIds, atomic: true });
  }
  for (const id of pendingIds) {
    if (!groupedPendingIds.has(id)) executionUnits.push({ ids: [id], atomic: false });
  }

  let currentTasksFile = tasksFile;
  let currentSyncState = syncState;
  const totalResult: PushResult = { created: 0, updated: 0, skipped: 0 };
  // 各 target の成功直後に remote watermark を永続化する。
  // link の mirror 群は後続失敗時に syncFields だけをまとめて戻し、全体を再送可能にする。
  for (const unit of executionUnits) {
    const beforeUnitSyncState = currentSyncState;
    try {
      for (const id of unit.ids) {
        const {
          result,
          tasksFile: nextTasksFile,
          syncState: nextSyncState,
        } = await executePush(gql, config, currentTasksFile, currentSyncState, {
          targetTaskIds: [id],
          saveProgress: async (progressTasksFile, progressSyncState) => {
            await storage.tasksStore.write(progressTasksFile);
            await storage.stateStore.write(progressSyncState);
            await storage.flush();
          },
        });

        totalResult.created += result.created;
        totalResult.updated += result.updated;
        totalResult.skipped += result.skipped;
        currentTasksFile = nextTasksFile;
        currentSyncState = nextSyncState;

        const remainingIds = new Set(
          computeLocalDiff(currentTasksFile.tasks, currentSyncState)
            .map((diff) => diff.id)
            .filter((remainingId) => remainingId === id),
        );
        await storage.tasksStore.write(currentTasksFile);
        await storage.stateStore.write(currentSyncState);
        await storage.flush();

        if (remainingIds.size > 0) {
          throw new Error(
            `auto-push 後もローカル差分が残っています: ${[...remainingIds].sort().join(", ")}`,
          );
        }
      }
    } catch (error) {
      if (unit.atomic) {
        currentSyncState = rollbackAtomicGroupSnapshots(
          beforeUnitSyncState,
          currentSyncState,
          unit.ids,
        );
        await storage.tasksStore.write(currentTasksFile);
        await storage.stateStore.write(currentSyncState);
        await storage.flush();
      }
      throw error;
    }
  }

  return { status: "pushed", tasksFile: currentTasksFile, result: totalResult };
}
