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
  // force / fullFetch / 初回同期 (last_synced_at 空) の場合はバイパス。
  // [Issue #167] id_map 不整合検出時もバイパスする: 早期 return すると下流の
  // id_map rebuild 経路に到達できず、破損が次 pull まで持ち越されるため。
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

  // [Issue #167] pull が id_map を更新しない旧設計では、gh-gantt を経由せず
  // 作成された Issue や sync-state.json の破損が push の silent skip の温床と
  // なっていた (push-executor の existingDiffs ループで idEntry が undefined の
  // 場合に skip される)。fetchProject 実行時に毎回 projectData.items から
  // id_map を authoritative に rebuild することで、pull が外部変化への
  // セルフヒーリング点となる (NFR-STABILITY-001)。
  //
  // draft タスク (github_issue=null) は projectData.items に含まれないため
  // 対象外。draft→real 変換時の id_map 追加は push-executor の責務 (責務分離)。
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

  // [Issue #167] rebuild 前に採取した findings を実状態に合わせて promote する。
  // - missing_id_map: newIdMap に入った場合のみ解消 (project に無いままなら未解消)
  // - orphan_id_map: rebuild により entry が必ず newIdMap から除去されるため無条件解消
  for (const finding of syncStateFindings) {
    if (finding.category === "missing_id_map" && newIdMap[finding.taskId]) {
      finding.autoFixed = true;
      finding.level = "info";
      finding.message = `${finding.taskId} を id_map に自動補完しました (GraphQL から rebuild)`;
    } else if (finding.category === "orphan_id_map") {
      finding.autoFixed = true;
      finding.level = "info";
      finding.message = `${finding.taskId} の orphan id_map エントリを自動解消しました (GraphQL から rebuild)`;
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

  // [Issue #167] pull 冒頭の validate は pre-pull 状態しか捕捉できない。
  // pull 処理中に新しく不整合が生まれる経路 — 代表例は kept-local detach
  // (projectData に無いタスクをローカル変更保護のため残す) で、mergedTasks に
  // 残るが newIdMap から漏れる — を顕在化するため、返却前の最終状態に対して
  // 再検証を行う。放置すると push で silent skip され NFR-STABILITY-002 に反する。
  // 冒頭で既報告の (category, taskId) は重複を避けるため skip する。
  const finalValidation = validateSyncState(newSyncState, newTasksFile);
  const reportedKeys = new Set(syncStateFindings.map((f) => `${f.category}:${f.taskId}`));
  for (const finding of finalValidation.findings) {
    const key = `${finding.category}:${finding.taskId}`;
    if (reportedKeys.has(key)) continue;
    syncStateFindings.push(finding);
    reportedKeys.add(key);
  }

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
