import type { graphql } from "@octokit/graphql";
import type { Config, Task, SyncState, TasksFile } from "@gh-gantt/shared";
import { fetchProject, fetchRepositoryMetadata, checkRemoteChanges } from "../github/projects.js";
import { fetchAllIssueRelationshipLinks } from "../github/sub-issues.js";
import {
  applySubIssueLinks,
  applyBlockedByLinks,
  buildTaskId,
  isDraftTask,
  isMilestoneSyntheticTask,
  milestoneToTask,
} from "../github/issues.js";
import { hashTask, extractSyncFields } from "./hash.js";
import { threeWayMerge } from "./three-way-merge.js";
import { applyConflictMarkers } from "./conflict-marker.js";
import { computeLocalDiff } from "./diff.js";
import { mapRemoteItemToTask } from "./mapper.js";
import { rebaseSyncFields } from "./rebase.js";
import { validateSyncState, type SyncStateFinding } from "./validate-sync-state.js";

export interface PullResult {
  added: number;
  updated: number;
  removed: number;
  conflicts: number;
  hasConflicts: boolean;
  details: PullTaskDetail[];
  skipped: boolean;
  /** sync-state 整合性検証で検出された findings (自動修復されたものを含む) */
  syncStateFindings: SyncStateFinding[];
}

export interface PullOptions {
  /** sameIdSets quick-skip をバイパスし、フル pull を強制する */
  force?: boolean;
  /** pre-check をバイパスし、常にフル fetch を実行する */
  fullFetch?: boolean;
}

export interface PullTaskDetail {
  id: string;
  title: string;
  type: "added" | "updated" | "removed" | "conflict" | "kept-local";
  conflictFields?: Array<{ field: string; local: unknown; remote: unknown }>;
}

export async function executePull(
  gql: typeof graphql,
  config: Config,
  tasksFile: TasksFile,
  syncState: SyncState,
  opts: PullOptions = {},
): Promise<{ result: PullResult; tasksFile: TasksFile; syncState: SyncState }> {
  const { owner, repo: repoName, project_number } = config.project.github;
  const repoFullName = `${owner}/${repoName}`;

  // 最初に sync-state の整合性を検証し、自動修復可能な不整合を修正する。
  // 修正済みの syncState をこの関数以降の全処理で使用する。
  // findings は PullResult.syncStateFindings として返却し、表示は呼び出し側 (command 層) が行う。
  const { syncState: validatedSyncState, findings: syncStateFindings } = validateSyncState(
    syncState,
    tasksFile,
  );
  syncState = validatedSyncState;

  // Pre-check: issue の更新有無を軽量クエリで確認し、変化なし時はフル fetch をスキップする。
  // force / fullFetch / 初回同期（last_synced_at 空）の場合はバイパス。
  // [Issue #167] sync-state に id_map 不整合が検出されている場合もバイパスしてフル fetch に
  // 降格する。これにより pull がユーザーに --force を強いずにセルフヒーリングする。
  // pre-check は最適化パスなので失敗時はフル fetch にフォールバックする (fail-open)。
  const hasSyncStateInconsistency = syncStateFindings.some(
    (f) => f.category === "missing_id_map" || f.category === "orphan_id_map",
  );
  const skipPrecheck =
    opts.force || opts.fullFetch || !syncState.last_synced_at || hasSyncStateInconsistency;
  if (!skipPrecheck) {
    let hasChanges = true;
    try {
      hasChanges = await checkRemoteChanges(gql, owner, repoName, syncState.last_synced_at);
    } catch (error) {
      console.warn(
        `  ⚠ pre-check に失敗したためフル fetch にフォールバック: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!hasChanges) {
      return {
        result: {
          added: 0,
          updated: 0,
          removed: 0,
          conflicts: 0,
          hasConflicts: false,
          details: [],
          skipped: true,
          syncStateFindings,
        },
        tasksFile,
        syncState,
      };
    }
  }

  // Record which tasks have unpushed local changes BEFORE merging
  const prePullDiffs = computeLocalDiff(tasksFile.tasks, syncState);
  const locallyChangedIds = new Set(
    prePullDiffs.filter((d) => d.type === "modified").map((d) => d.id),
  );

  // Fetch project data and repository metadata in parallel
  const [projectData, repoMetadata] = await Promise.all([
    fetchProject(gql, owner, project_number),
    fetchRepositoryMetadata(gql, owner, repoName),
  ]);

  // Map remote items to tasks
  const remoteTasks = new Map<string, Task>();
  for (const item of projectData.items) {
    const task = mapRemoteItemToTask(item, config);
    if (task) remoteTasks.set(task.id, task);
  }
  for (const m of repoMetadata.milestones) {
    if (!m.dueOn) continue;
    const syntheticTask = milestoneToTask(m, repoFullName);
    remoteTasks.set(syntheticTask.id, syntheticTask);
  }

  // Extract field_ids and option_ids from project data
  const fieldIds: Record<string, string> = {};
  const optionIds: Record<string, Record<string, string>> = {};
  for (const field of projectData.fields) {
    if (field.id && field.name) {
      fieldIds[field.name] = field.id;
    }
    if (field.options && field.options.length > 0) {
      const optMap: Record<string, string> = {};
      for (const opt of field.options) {
        optMap[opt.name] = opt.id;
      }
      optionIds[field.name] = optMap;
    }
  }

  // [Issue #167] id_map を projectData.items から authoritative に rebuild する。
  //
  // pull が id_map を更新しない設計だと、gh-gantt を経由せず作成された Issue
  // (GitHub UI / gh issue create / PR マージによる自動追加 / 外部エディタによる
  // sync-state.json 直接編集等) が tasks.json には入るが id_map には入らない
  // 状態が発生し、その後の push で silent skip される (push-executor.ts:476-479)。
  //
  // 毎 pull で projectData.items から rebuild することで、pull が外部変化に対する
  // セルフヒーリング点となる。副次的効果:
  //   - 外部作成 issue → 次 pull で自動補完
  //   - 破損した id_map → 次 pull で自動上書き
  //   - stale な node_id → 自動更新
  //   - orphan id_map (project から detach された) → 自動削除
  //
  // draft タスク (github_issue=null) は projectData.items に含まれないため
  // id_map には入らない。push が draft→real 変換時に初めて id_map に追加する
  // 既存仕様 (push-executor.ts:309) と整合する。
  const newIdMap: SyncState["id_map"] = {};
  for (const item of projectData.items) {
    if (!item.content) continue;
    const taskId = buildTaskId(item.content.repository, item.content.number);
    newIdMap[taskId] = {
      issue_number: item.content.number,
      issue_node_id: item.content.nodeId,
      project_item_id: item.id,
    };
  }

  // [Issue #167] rebuild 後に findings を正しい状態へ promote する。
  // validateSyncState は rebuild 前の状態で findings を出しているため、missing_id_map
  // エントリのうち今 rebuild で補完されたものを autoFixed: true に promote し、
  // メッセージも「次回 pull で補完」ではなく「自動補完しました」の過去形にする。
  for (const finding of syncStateFindings) {
    if (finding.category === "missing_id_map" && newIdMap[finding.taskId]) {
      finding.autoFixed = true;
      finding.message = `${finding.taskId} を id_map に自動補完しました (GraphQL から rebuild)`;
    }
  }

  // Quick check: skip sub-issues fetch if no remote changes.
  // --force 指定時は整合性担保のため quick-skip をバイパスし常にフル処理する。
  const localNonDraft = tasksFile.tasks.filter((t) => !isDraftTask(t.id));
  const localIds = new Set(localNonDraft.map((t) => t.id));
  const remoteIds = new Set(remoteTasks.keys());
  const sameIdSets =
    localIds.size === remoteIds.size && [...localIds].every((id) => remoteIds.has(id));
  if (sameIdSets && !opts.force) {
    let changed = false;
    for (const [id, remote] of remoteTasks) {
      const snap = syncState.snapshots[id];
      if (!snap?.updated_at) {
        changed = true;
        break;
      }
      if (remote.updated_at !== snap.updated_at) {
        changed = true;
        break;
      }
      if (isMilestoneSyntheticTask(id) && !snap.hash) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return {
        result: {
          added: 0,
          updated: 0,
          removed: 0,
          conflicts: 0,
          hasConflicts: false,
          details: [],
          skipped: true,
          syncStateFindings,
        },
        tasksFile,
        syncState: {
          ...syncState,
          id_map: newIdMap,
          field_ids: fieldIds,
          option_ids: optionIds,
        },
      };
    }
  }

  // Fetch and apply sub-issue + blocked_by links
  const issueItems = projectData.items
    .filter((i) => i.content)
    .map((i) => ({ number: i.content!.number, repository: i.content!.repository }));
  const { subIssueLinks, blockedByLinks } = await fetchAllIssueRelationshipLinks(gql, issueItems);
  const remoteTaskArray = Array.from(remoteTasks.values());
  applySubIssueLinks(remoteTaskArray, subIssueLinks);
  applyBlockedByLinks(remoteTaskArray, blockedByLinks);
  for (const t of remoteTaskArray) remoteTasks.set(t.id, t);

  const localTaskMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));

  let added = 0;
  let updated = 0;
  let removed = 0;
  let conflictCount = 0;
  let hasConflictsFlag = false;
  const conflictedIds = new Set<string>();
  const details: PullTaskDetail[] = [];
  const mergedTasks: Task[] = [];

  // Process remote tasks — 3-way merge
  for (const [id, remoteTask] of remoteTasks) {
    const localTask = localTaskMap.get(id);
    if (!localTask) {
      mergedTasks.push(remoteTask);
      added++;
      details.push({ id, title: remoteTask.title, type: "added" });
    } else {
      const snapshot = syncState.snapshots[id];
      const remoteHash = hashTask(remoteTask);
      const snapshotRemoteHash = snapshot?.remoteHash ?? snapshot?.hash;

      if (remoteHash === snapshotRemoteHash) {
        mergedTasks.push(localTask);
      } else if (!snapshot || !snapshot.syncFields) {
        const localHash = hashTask(localTask);
        if (snapshot && localHash !== snapshot.hash) {
          mergedTasks.push({
            ...localTask,
            created_at: remoteTask.created_at,
            updated_at: remoteTask.updated_at,
            closed_at: remoteTask.closed_at,
            state_reason: remoteTask.state_reason,
            linked_prs: remoteTask.linked_prs,
          });
          details.push({ id, title: remoteTask.title, type: "kept-local" });
        } else {
          mergedTasks.push(remoteTask);
          updated++;
          details.push({ id, title: remoteTask.title, type: "updated" });
        }
      } else {
        const rebasedBase = rebaseSyncFields(snapshot.syncFields, config);
        const localFields = extractSyncFields(localTask);
        const remoteFields = extractSyncFields(remoteTask);
        const { merged, conflicts } = threeWayMerge(rebasedBase, localFields, remoteFields);

        const mergedTask: Task = { ...localTask, ...merged };
        mergedTask.created_at = remoteTask.created_at;
        mergedTask.updated_at = remoteTask.updated_at;
        mergedTask.closed_at = remoteTask.closed_at;
        mergedTask.state_reason = remoteTask.state_reason;
        mergedTask.linked_prs = remoteTask.linked_prs;

        if (conflicts.length > 0) {
          const marked = applyConflictMarkers(mergedTask, conflicts);
          mergedTasks.push(marked as unknown as Task);
          hasConflictsFlag = true;
          conflictCount++;
          conflictedIds.add(id);
          details.push({
            id,
            title: remoteTask.title,
            type: "conflict",
            conflictFields: conflicts.map((c) => ({
              field: c.field,
              local: c.current,
              remote: c.incoming,
            })),
          });
        } else {
          mergedTasks.push(mergedTask);
          const localHash = hashTask(localTask);
          const mergedHash = hashTask(mergedTask);
          if (localHash !== mergedHash) {
            updated++;
            details.push({ id, title: remoteTask.title, type: "updated" });
          }
        }
      }
      localTaskMap.delete(id);
    }
  }

  // Tasks that exist locally but not remotely.
  // [Issue #167] kept-local で残されたタスクが GitHub Project から detach された
  // 場合 (remote に無い & ローカル変更あり)、mergedTasks には残るが newIdMap には
  // 入らない (projectData.items の rebuild から漏れるため)。次 pull で validateSyncState が
  // missing_id_map finding を emit し、その pull 内で現状のまま (project に戻るまで)
  // id_map は空のまま → push は silent skip する設計。これは
  // 「project が source of truth であり、detach された issue は gh-gantt の管理外」という
  // ADR-007 の方針に沿った挙動。detach を永続化したいならローカルから削除、
  // 再 attach したいなら GitHub 側で対応する。
  for (const [id, localTask] of localTaskMap) {
    if (isDraftTask(id)) {
      mergedTasks.push(localTask);
      continue;
    }
    const snapshot = syncState.snapshots[id];
    if (snapshot) {
      const localHash = hashTask(localTask);
      if (localHash !== snapshot.hash) {
        mergedTasks.push(localTask);
        details.push({ id, title: localTask.title, type: "kept-local" });
        localTaskMap.delete(id);
        continue;
      }
    }
    removed++;
    details.push({ id, title: localTask.title, type: "removed" });
  }

  // Update snapshots
  const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };
  for (const task of mergedTasks) {
    const remoteTask = remoteTasks.get(task.id);
    const remoteHash = remoteTask ? hashTask(remoteTask) : undefined;
    const existing = syncState.snapshots[task.id];

    const isConflicted = conflictedIds.has(task.id);
    const hasLocalChanges = locallyChangedIds.has(task.id);

    if (isConflicted) {
      // Conflicted: preserve hash so local changes remain pushable
      newSnapshots[task.id] = {
        ...(existing ?? { hash: hashTask(task), synced_at: new Date().toISOString() }),
        remoteHash,
      };
    } else if (hasLocalChanges) {
      // Unpushed local changes: preserve hash for diff detection,
      // but advance syncFields/updated_at to prevent false conflicts on next pull
      newSnapshots[task.id] = {
        ...(existing ?? { hash: hashTask(task), synced_at: new Date().toISOString() }),
        updated_at: remoteTask?.updated_at ?? existing?.updated_at,
        syncFields: extractSyncFields(task),
        remoteHash,
      };
    } else if (existing && remoteHash === (existing.remoteHash ?? existing.hash)) {
      newSnapshots[task.id] = { ...existing, remoteHash };
    } else {
      newSnapshots[task.id] = {
        hash: hashTask(task),
        synced_at: new Date().toISOString(),
        updated_at: task.updated_at,
        syncFields: extractSyncFields(task),
        remoteHash,
      };
    }
  }
  for (const id of localTaskMap.keys()) {
    delete newSnapshots[id];
  }

  const newSyncState: SyncState = {
    ...syncState,
    last_synced_at: new Date().toISOString(),
    id_map: newIdMap,
    snapshots: newSnapshots,
    field_ids: fieldIds,
    option_ids: optionIds,
  };

  const newTasksFile: TasksFile = {
    tasks: mergedTasks,
    cache: tasksFile.cache,
    ...(hasConflictsFlag ? { has_conflicts: true } : {}),
  };

  return {
    result: {
      added,
      updated,
      removed,
      conflicts: conflictCount,
      hasConflicts: hasConflictsFlag,
      details,
      skipped: false,
      syncStateFindings,
    },
    tasksFile: newTasksFile,
    syncState: newSyncState,
  };
}
