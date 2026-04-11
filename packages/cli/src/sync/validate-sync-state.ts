import type { SyncState, TasksFile } from "@gh-gantt/shared";
import { isDraftTask, isMilestoneSyntheticTask } from "../github/issues.js";

/**
 * sync-state の整合性検証で見つかった問題。
 *
 * 自動修復された項目は `autoFixed: true` となる。
 * 自動修復不可能な項目は警告としてユーザーに提示され、
 * `gh-gantt pull --force` での再取得が推奨される。
 */
export interface SyncStateFinding {
  level: "warn" | "info";
  category: "orphan_snapshot" | "orphan_id_map" | "missing_id_map" | "invalid_snapshot_hash";
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
 * - **missing id_map** [Issue #167]: tasksFile に存在するが id_map に無い ID
 *   → 情報のみ (level: "info")。validate 自体では修復不可。発生源は 2 系統あり:
 *     (a) pre-pull 状態の破損 — pull-executor が rebuild で自動修復し promote する。
 *     (b) kept-local detach — project から消失したがローカル変更のため保持されたタスク。
 *         rebuild 対象外のため autoFixed: false のまま残り、ユーザー操作 (ローカル削除
 *         または project への再 attach) が必要。
 *     draft タスクと milestone 合成タスクは id_map を使わないため除外。
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
        level: "info",
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
    // tasks に存在する場合はローカル変更保護のため削除せず warn のみ。
    if (!snapshot.hash || typeof snapshot.hash !== "string") {
      if (inTasks) {
        findings.push({
          level: "warn",
          category: "invalid_snapshot_hash",
          taskId: id,
          message: `snapshot ${id} の hash が不正です。ローカル変更保護のため保持しますが、'gh-gantt pull --force' での再同期を推奨します`,
          autoFixed: false,
        });
      } else {
        delete newSnapshots[id];
        mutated = true;
        findings.push({
          level: "info",
          category: "invalid_snapshot_hash",
          taskId: id,
          message: `snapshot ${id} の hash が不正のため削除しました。次回 pull で再構築されます`,
          autoFixed: true,
        });
      }
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
        message: `id_map ${id} が tasksFile に存在しません。まず 'gh-gantt pull --force' を試してください。それでも解消しない場合は .gantt-sync/ の再初期化を検討してください`,
        autoFixed: false,
      });
    }
  }

  // 4. missing id_map [Issue #167] — tasks にあるが id_map に無い。validate 自体では
  // 修復不可。解消経路は 2 系統 (JSDoc 参照)。
  // draft タスクは push 経由で初めて id_map に入る仕様のため除外。
  // milestone 合成タスクは projectData.items ではなく fetchRepositoryMetadata の
  // milestones から合成される (id_map を使わない) ため除外。
  for (const task of tasksFile.tasks) {
    if (isDraftTask(task.id)) continue;
    if (isMilestoneSyntheticTask(task.id)) continue;
    if (!idMapKeys.has(task.id)) {
      findings.push({
        level: "info",
        category: "missing_id_map",
        taskId: task.id,
        message: `${task.id} が id_map に存在しません。task が GitHub Project に含まれていれば pull で自動補完されます。含まれていない場合は project への再追加またはローカルから削除が必要です`,
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
