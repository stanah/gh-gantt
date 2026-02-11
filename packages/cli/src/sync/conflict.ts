import type { Task, SyncState, SyncFields } from "@gh-gantt/shared";
import { hashTask, extractSyncFields } from "./hash.js";
import { detectChangedFields } from "./diff.js";

export interface ConflictFieldDetail {
  field: string;
  local: unknown;
  remote: unknown;
  snapshot: unknown;
}

export interface Conflict {
  taskId: string;
  title: string;
  localHash: string;
  remoteHash: string;
  snapshotHash: string;
  localChangedFields: string[];
  remoteChangedFields: string[];
  fieldDetails: ConflictFieldDetail[];
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
      let localChangedFields: string[] = [];
      let remoteChangedFields: string[] = [];
      let fieldDetails: ConflictFieldDetail[] = [];

      if (snapshot.syncFields) {
        const localFields = extractSyncFields(local);
        const remoteFields = extractSyncFields(remote);
        const snapshotFields = snapshot.syncFields;

        localChangedFields = detectChangedFields(localFields, snapshotFields);
        remoteChangedFields = detectChangedFields(remoteFields, snapshotFields);

        const allChanged = new Set([...localChangedFields, ...remoteChangedFields]);
        for (const field of allChanged) {
          const key = field as keyof SyncFields;
          fieldDetails.push({
            field,
            local: localFields[key],
            remote: remoteFields[key],
            snapshot: snapshotFields[key],
          });
        }
      }

      conflicts.push({
        taskId: local.id,
        title: local.title,
        localHash,
        remoteHash,
        snapshotHash,
        localChangedFields,
        remoteChangedFields,
        fieldDetails,
      });
    }
  }

  return conflicts;
}
