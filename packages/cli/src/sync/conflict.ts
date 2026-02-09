import type { Task, SyncState } from "@gh-gantt/shared";
import { hashTask } from "./hash.js";

export interface Conflict {
  taskId: string;
  title: string;
  localHash: string;
  remoteHash: string;
  snapshotHash: string;
}

export function detectConflicts(
  localTasks: Task[],
  remoteTasks: Task[],
  syncState: SyncState,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const remoteMap = new Map(remoteTasks.map((t) => [t.id, t]));

  for (const local of localTasks) {
    const remote = remoteMap.get(local.id);
    if (!remote) continue;

    const snapshot = syncState.snapshots[local.id];
    if (!snapshot) continue;

    const localHash = hashTask(local);
    const remoteHash = hashTask(remote);
    const snapshotHash = snapshot.hash;

    // Conflict: both local and remote changed since last sync
    if (localHash !== snapshotHash && remoteHash !== snapshotHash) {
      conflicts.push({
        taskId: local.id,
        title: local.title,
        localHash,
        remoteHash,
        snapshotHash,
      });
    }
  }

  return conflicts;
}
