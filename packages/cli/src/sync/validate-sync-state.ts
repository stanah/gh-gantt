import type { SyncState, TasksFile } from "@gh-gantt/shared";

/**
 * sync-state の整合性検証で見つかった問題。
 *
 * 自動修復された項目は `autoFixed: true` となる。
 * 自動修復不可能な項目は警告としてユーザーに提示され、
 * `gh-gantt pull --force` での再取得が推奨される。
 */
export interface SyncStateFinding {
  level: "warn" | "info";
  category:
    | "orphan_snapshot"
    | "orphan_id_map"
    | "invalid_snapshot_hash"
    | "missing_snapshot_updated_at";
  taskId: string;
  message: string;
  autoFixed: boolean;
}

export interface ValidateSyncStateResult {
  syncState: SyncState;
  findings: SyncStateFinding[];
}

/**
 * sync-state (id_map + snapshots) と tasksFile の整合性を検証し、
 * 自動修復可能な不整合を修正した新しい sync-state を返す。
 *
 * 検出する不整合:
 * - **orphan snapshot**: snapshot に存在するが tasksFile にも id_map にも存在しない ID
 *   → 自動削除 (古い同期状態の残骸)
 * - **invalid snapshot hash**: snapshot.hash が空文字列や欠損
 *   → snapshot ごと削除し、次回 pull で再構築させる
 * - **orphan id_map**: id_map に存在するが tasksFile に存在しない ID
 *   → 警告のみ (リモート側にはまだ存在する可能性があるため自動削除しない)
 *
 * いずれも pull がタスクをスキップしたり、想定外の挙動を起こす原因になり得る。
 */
export function validateSyncState(
  syncState: SyncState,
  tasksFile: TasksFile,
): ValidateSyncStateResult {
  const findings: SyncStateFinding[] = [];
  const taskIds = new Set(tasksFile.tasks.map((t) => t.id));
  const idMapKeys = new Set(Object.keys(syncState.id_map));

  const newSnapshots = { ...syncState.snapshots };
  let mutated = false;

  for (const [id, snapshot] of Object.entries(syncState.snapshots)) {
    const inTasks = taskIds.has(id);
    const inIdMap = idMapKeys.has(id);

    // 1. orphan snapshot — どこからも参照されていない残骸
    if (!inTasks && !inIdMap) {
      delete newSnapshots[id];
      mutated = true;
      findings.push({
        level: "warn",
        category: "orphan_snapshot",
        taskId: id,
        message: `snapshot ${id} が tasksFile にも id_map にも存在しないため削除しました`,
        autoFixed: true,
      });
      continue;
    }

    // 2. invalid hash — hash が壊れていると diff 検出が正しく働かない。
    // Zod でパース済みなら空文字列ケースのみだが、手動編集や旧バージョン由来の
    // 破損 JSON を想定し typeof ガードも残す (防御的)。
    if (!snapshot.hash || typeof snapshot.hash !== "string") {
      delete newSnapshots[id];
      mutated = true;
      findings.push({
        level: "warn",
        category: "invalid_snapshot_hash",
        taskId: id,
        message: `snapshot ${id} の hash が不正のため削除しました。次回 pull で再構築されます`,
        autoFixed: true,
      });
      continue;
    }
  }

  // 3. orphan id_map — id_map にあるが tasks に無い (リモートにまだある可能性を考慮し自動削除しない)
  for (const id of idMapKeys) {
    if (!taskIds.has(id)) {
      findings.push({
        level: "warn",
        category: "orphan_id_map",
        taskId: id,
        message: `id_map ${id} が tasksFile に存在しません。リモートで削除されていれば次回 pull で解消されます。不整合が残る場合は 'gh-gantt pull --force' を実行してください`,
        autoFixed: false,
      });
    }
  }

  if (!mutated) {
    return { syncState, findings };
  }

  return {
    syncState: { ...syncState, snapshots: newSnapshots },
    findings,
  };
}
