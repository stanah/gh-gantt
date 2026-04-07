import type { graphql } from "@octokit/graphql";
import type { Config, Task, SyncState, TasksFile, TaskType } from "@gh-gantt/shared";
import { computeLocalDiff } from "./diff.js";
import { hashTask, hashSyncFields, extractSyncFields } from "./hash.js";
import {
  isDraftTask,
  isMilestoneSyntheticTask,
  isMilestoneDraftTask,
  buildTaskId,
  buildMilestoneSyntheticId,
} from "../github/issues.js";
import { fetchRepositoryId, fetchRepositoryMetadata, fetchUserIds } from "../github/projects.js";
import { buildIssueUpdatedAtQuery } from "../github/queries.js";
import { getToken } from "../github/auth.js";
import {
  createIssue,
  addProjectItem,
  addSubIssue,
  removeSubIssue,
  updateIssue,
  setIssueState,
  updateProjectItemField,
  createGithubMilestone,
  addBlockedByIssue,
  removeBlockedByIssue,
} from "../github/mutations.js";
import { formatError } from "../util/format.js";

export interface PushResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * addSubIssue を指数バックオフでリトライする。
 *
 * GitHub の sub-issue API は同一親配下で priority (順序) を内部割り当てするため、
 * 並列呼び出しや連続呼び出しで "Priority has already been taken" が返ることがある。
 * この関数は同エラーおよび一過性エラーをリトライ対象とする。
 */
export async function addSubIssueWithRetry(
  gql: typeof graphql,
  parentNodeId: string,
  childNodeId: string,
  maxAttempts = 4,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await addSubIssue(gql, parentNodeId, childNodeId);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        /Priority has already been taken|timeout|ECONN|rate limit|abuse|secondary rate|5\d\d/i.test(
          msg,
        );
      if (!retryable || attempt === maxAttempts - 1) break;
      const delay = 100 * 2 ** attempt + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error("addSubIssueWithRetry: 全試行が失敗しました");
}

export function replaceTaskIdReferences(tasks: Task[], oldId: string, newId: string): void {
  for (const task of tasks) {
    if (task.parent === oldId) {
      task.parent = newId;
    }
    task.sub_tasks = task.sub_tasks.map((id) => (id === oldId ? newId : id));
    for (const dep of task.blocked_by) {
      if (dep.task === oldId) {
        dep.task = newId;
      }
    }
  }
}

export async function executePush(
  gql: typeof graphql,
  config: Config,
  tasksFile: TasksFile,
  syncState: SyncState,
  opts?: {
    force?: boolean;
    saveProgress?: (tasksFile: TasksFile, syncState: SyncState) => Promise<void>;
  },
): Promise<{ result: PushResult; tasksFile: TasksFile; syncState: SyncState }> {
  const diffs = computeLocalDiff(tasksFile.tasks, syncState);
  const result: PushResult = { created: 0, updated: 0, skipped: 0 };

  if (diffs.length === 0) {
    return { result, tasksFile, syncState };
  }

  // Check if remote has changed since last pull (like git push rejecting non-fast-forward)
  if (!opts?.force) {
    const modifiedDiffs = diffs.filter(
      (d) => d.type === "modified" && !isDraftTask(d.id) && !isMilestoneSyntheticTask(d.id),
    );
    const staleCheckTargets = modifiedDiffs.filter(
      (d) => d.task.github_issue !== null && syncState.snapshots[d.id]?.updated_at,
    );
    if (staleCheckTargets.length > 0) {
      const { owner, repo } = config.project.github;
      const tasksByNumber = new Map(staleCheckTargets.map((d) => [d.task.github_issue!, d]));
      const remoteUpdatedAt = await fetchBatchUpdatedAt(gql, owner, repo, [
        ...tasksByNumber.keys(),
      ]);
      const staleTaskIds: string[] = [];
      for (const [number, diff] of tasksByNumber) {
        const remoteTs = remoteUpdatedAt.get(number);
        const snapshotTs = syncState.snapshots[diff.id]?.updated_at;
        if (remoteTs === undefined) {
          // Could not fetch — treat as stale to be safe
          console.warn(`⚠ リモート状態の確認に失敗しました (${diff.id})`);
          staleTaskIds.push(diff.id);
        } else if (remoteTs !== snapshotTs) {
          staleTaskIds.push(diff.id);
        }
      }
      if (staleTaskIds.length > 0) {
        console.error("リモートが更新されています。先に pull してください");
        for (const id of staleTaskIds) console.error("  " + id);
        console.error("--force で強制 push できます");
        return { result: { created: 0, updated: 0, skipped: 0 }, tasksFile, syncState };
      }
    }
  }

  const fm = config.sync.field_mapping;
  const { owner, repo } = config.project.github;

  // Track which tasks were actually pushed (by their current ID after push)
  const pushedTaskIds = new Set<string>();
  const replacedDraftIds = new Set<string>();
  // Track per-field relationship mutation failures for accurate partial retry
  interface RelationFailure {
    parentFailed: boolean;
    blockedByFailed: boolean;
  }
  const failedRelations = new Map<string, RelationFailure>();
  // Pre-relation baseline: remote state before relation mutations were attempted
  const preRelationBaseline = new Map<
    string,
    Pick<import("@gh-gantt/shared").SyncFields, "parent" | "blocked_by">
  >();

  // Filter out synthetic milestone tasks (read-only, managed by pull)
  const nonSyntheticDiffs = diffs.filter((d) => !isMilestoneSyntheticTask(d.id));

  // Separate draft tasks from existing tasks
  const allDraftDiffs = nonSyntheticDiffs.filter((d) => isDraftTask(d.id));
  const existingDiffs = nonSyntheticDiffs.filter((d) => !isDraftTask(d.id));

  // Further separate milestone drafts from regular issue drafts
  const draftMilestones = allDraftDiffs.filter(
    (d) => d.type !== "deleted" && isMilestoneDraftTask(d.task),
  );
  const draftDiffs = allDraftDiffs.filter(
    (d) => d.type === "deleted" || !isMilestoneDraftTask(d.task),
  );

  // Process milestone drafts first (must precede Issue creation for milestoneMap)
  if (draftMilestones.length > 0) {
    const token = await getToken();
    for (const diff of draftMilestones) {
      const task = diff.task;
      const oldId = task.id;

      const { number: milestoneNumber } = await createGithubMilestone(token, owner, repo, {
        title: task.title,
        description: task.body ?? undefined,
        dueOn: task.date ?? undefined,
      });

      // Convert to synthetic milestone ID
      const newId = buildMilestoneSyntheticId(`${owner}/${repo}`, milestoneNumber);
      task.id = newId;
      task.github_issue = null;
      task.github_repo = `${owner}/${repo}`;

      // Update references in all tasks
      replaceTaskIdReferences(tasksFile.tasks, oldId, newId);

      replacedDraftIds.add(oldId);
      pushedTaskIds.add(newId);
      result.created++;

      // Save progress: remove old draft snapshot, add new snapshot
      if (opts?.saveProgress) {
        const newSnapshots = { ...syncState.snapshots };
        delete newSnapshots[oldId];
        newSnapshots[newId] = {
          hash: hashTask(task),
          synced_at: new Date().toISOString(),
          syncFields: extractSyncFields(task),
          remoteHash: hashTask(task),
        };
        syncState = { ...syncState, snapshots: newSnapshots };
        await opts.saveProgress(tasksFile, syncState);
      }
    }
  }

  // Process draft tasks (create issues) if auto_create_issues is enabled
  if (config.sync.auto_create_issues && draftDiffs.length > 0) {
    // Collect assignees upfront so all three fetches can run in parallel
    const allAssignees = new Set<string>();
    for (const d of draftDiffs) {
      if (d.type !== "deleted") {
        for (const a of d.task.assignees) allAssignees.add(a);
      }
    }

    const [repositoryId, metadata, userIdMap] = await Promise.all([
      fetchRepositoryId(gql, owner, repo),
      fetchRepositoryMetadata(gql, owner, repo),
      fetchUserIds(gql, [...allAssignees]),
    ]);
    const createdTaskIds: string[] = [];

    for (const diff of draftDiffs) {
      if (diff.type === "deleted") {
        result.skipped++;
        continue;
      }

      const task = diff.task;
      const oldId = task.id;

      // Resolve IDs for labels, milestone, assignees
      const labelIds = task.labels
        .map((name) => metadata.labelMap.get(name))
        .filter((id): id is string => id != null);
      const milestoneId = task.milestone ? metadata.milestoneMap.get(task.milestone) : undefined;
      const assigneeIds = task.assignees
        .map((login) => userIdMap.get(login))
        .filter((id): id is string => id != null);

      // Create GitHub issue
      const { issueId, issueNumber } = await createIssue(gql, repositoryId, {
        title: task.title,
        body: task.body ?? undefined,
        labelIds,
        milestoneId,
        assigneeIds,
      });

      // Add to project
      const projectItemId = await addProjectItem(gql, syncState.project_node_id, issueId);

      // Update project fields (dates)
      if (task.start_date && syncState.field_ids[fm.start_date]) {
        await updateProjectItemField(
          gql,
          syncState.project_node_id,
          projectItemId,
          syncState.field_ids[fm.start_date],
          { date: task.start_date },
        );
      }
      if (task.end_date && syncState.field_ids[fm.end_date]) {
        await updateProjectItemField(
          gql,
          syncState.project_node_id,
          projectItemId,
          syncState.field_ids[fm.end_date],
          { date: task.end_date },
        );
      }

      // Set Type custom field
      if (fm.type && syncState.field_ids[fm.type]) {
        const typeOptionId = resolveTypeOptionId(
          task.type,
          config.task_types,
          fm.type,
          syncState.option_ids,
        );
        if (typeOptionId) {
          await updateProjectItemField(
            gql,
            syncState.project_node_id,
            projectItemId,
            syncState.field_ids[fm.type],
            { singleSelectOptionId: typeOptionId },
          );
        }
      }

      // Set Priority custom field
      const priorityUpdate = buildPriorityFieldUpdate(gql, syncState, fm, projectItemId, task);
      if (priorityUpdate) await priorityUpdate;

      // Update task ID from draft to real
      const newId = buildTaskId(`${owner}/${repo}`, issueNumber);
      task.id = newId;
      task.github_issue = issueNumber;
      task.github_repo = `${owner}/${repo}`;

      // Update references in all tasks
      replaceTaskIdReferences(tasksFile.tasks, oldId, newId);

      // Add id_map entry
      syncState.id_map[newId] = {
        issue_number: issueNumber,
        issue_node_id: issueId,
        project_item_id: projectItemId,
      };

      replacedDraftIds.add(oldId);
      pushedTaskIds.add(newId);
      createdTaskIds.push(newId);
      result.created++;

      // Save progress: remove old draft snapshot, add new snapshot
      if (opts?.saveProgress) {
        const newSnapshots = { ...syncState.snapshots };
        delete newSnapshots[oldId];
        newSnapshots[newId] = {
          hash: hashTask(task),
          synced_at: new Date().toISOString(),
          syncFields: extractSyncFields(task),
          remoteHash: hashTask(task),
        };
        syncState = { ...syncState, snapshots: newSnapshots };
        await opts.saveProgress(tasksFile, syncState);
      }
    }

    // Set up relationships for newly created issues.
    // Newly created issues have no relations on remote yet, so baseline is always null/empty.
    //
    // sub-issue (親子) 関係は「同一親への追加」を **逐次** 実行する必要がある。
    // GitHub sub-issue API は親ごとに priority (順序) を割り当てるため、
    // 同一親に対して並列/高速連続で addSubIssue を呼ぶと
    // "Priority has already been taken" エラーが頻発する。
    // そのため親ノード ID でグループ化し、グループ内は直列、グループ間は並列で実行する。
    // blocked_by は priority 制約がないので従来どおり並列で良い。
    const taskMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));
    const subIssueGroups = new Map<string, Array<{ taskId: string; childNodeId: string }>>();
    const blockerMutations: Promise<{ taskId: string; ok: boolean }>[] = [];

    for (const id of createdTaskIds) {
      preRelationBaseline.set(id, { parent: null, blocked_by: [] });
      const task = taskMap.get(id);
      if (task?.parent) {
        const childEntry = syncState.id_map[task.id];
        const parentEntry = syncState.id_map[task.parent];
        if (childEntry?.issue_node_id && parentEntry?.issue_node_id) {
          const list = subIssueGroups.get(parentEntry.issue_node_id) ?? [];
          list.push({ taskId: task.id, childNodeId: childEntry.issue_node_id });
          subIssueGroups.set(parentEntry.issue_node_id, list);
        } else {
          const missingIds = [
            !childEntry?.issue_node_id ? task.id : null,
            !parentEntry?.issue_node_id ? task.parent : null,
          ]
            .filter(Boolean)
            .join(", ");
          console.warn(
            `  ⚠ issue_node_id が取得できないため sub-issue 関係をスキップ (${missingIds})`,
          );
          const existing = failedRelations.get(task.id) ?? {
            parentFailed: false,
            blockedByFailed: false,
          };
          existing.parentFailed = true;
          failedRelations.set(task.id, existing);
        }
      }

      if (task?.blocked_by.length) {
        const taskEntry = syncState.id_map[task.id];
        if (taskEntry?.issue_node_id) {
          for (const dep of task.blocked_by) {
            const blockerEntry = syncState.id_map[dep.task];
            if (blockerEntry?.issue_node_id) {
              blockerMutations.push(
                addBlockedByIssue(gql, taskEntry.issue_node_id, blockerEntry.issue_node_id).then(
                  () => ({ taskId: task.id, ok: true }),
                  (err) => {
                    console.warn(
                      `  ⚠ blocked-by 関係の設定に失敗 (${task.id} ← ${dep.task}): ${formatError(err)}`,
                    );
                    return { taskId: task.id, ok: false };
                  },
                ),
              );
            } else {
              console.warn(
                `  ⚠ issue_node_id が取得できないため blocked-by 関係をスキップ (${task.id} ← ${dep.task})`,
              );
              const existing = failedRelations.get(task.id) ?? {
                parentFailed: false,
                blockedByFailed: false,
              };
              existing.blockedByFailed = true;
              failedRelations.set(task.id, existing);
            }
          }
        } else {
          console.warn(
            `  ⚠ issue_node_id が取得できないため blocked-by 関係をスキップ (${task.id}: ${task.blocked_by.length} 件)`,
          );
          const existing = failedRelations.get(task.id) ?? {
            parentFailed: false,
            blockedByFailed: false,
          };
          existing.blockedByFailed = true;
          failedRelations.set(task.id, existing);
        }
      }
    }

    // 親グループ単位で並列、グループ内は直列
    const subIssueGroupResults = await Promise.all(
      Array.from(subIssueGroups.entries()).map(async ([parentNodeId, children]) => {
        const groupResults: Array<{ taskId: string; ok: boolean }> = [];
        for (const { taskId, childNodeId } of children) {
          try {
            await addSubIssueWithRetry(gql, parentNodeId, childNodeId);
            groupResults.push({ taskId, ok: true });
          } catch (err) {
            console.warn(`  ⚠ sub-issue 関係の設定に失敗 (${taskId}): ${formatError(err)}`);
            groupResults.push({ taskId, ok: false });
          }
        }
        return groupResults;
      }),
    );

    for (const group of subIssueGroupResults) {
      for (const r of group) {
        if (!r.ok) {
          const existing = failedRelations.get(r.taskId) ?? {
            parentFailed: false,
            blockedByFailed: false,
          };
          existing.parentFailed = true;
          failedRelations.set(r.taskId, existing);
        }
      }
    }

    if (blockerMutations.length > 0) {
      const results = await Promise.all(blockerMutations);
      for (const r of results) {
        if (!r.ok) {
          const existing = failedRelations.get(r.taskId) ?? {
            parentFailed: false,
            blockedByFailed: false,
          };
          existing.blockedByFailed = true;
          failedRelations.set(r.taskId, existing);
        }
      }
    }
  } else if (draftDiffs.length > 0) {
    result.skipped += draftDiffs.length;
  }

  // Process existing task updates
  for (const diff of existingDiffs) {
    if (diff.type === "deleted") {
      result.skipped++;
      continue;
    }

    const task = diff.task;
    const idEntry = syncState.id_map[task.id];
    if (!idEntry) {
      result.skipped++;
      continue;
    }

    if (diff.type === "modified" || diff.type === "added") {
      if (idEntry.issue_node_id) {
        await Promise.all([
          updateIssue(gql, idEntry.issue_node_id, {
            title: task.title,
            body: task.body ?? undefined,
          }),
          setIssueState(gql, idEntry.issue_node_id, task.state),
        ]);
      }

      if (idEntry.project_item_id) {
        const fieldUpdates: Promise<unknown>[] = [];

        if (task.start_date && syncState.field_ids[fm.start_date]) {
          fieldUpdates.push(
            updateProjectItemField(
              gql,
              syncState.project_node_id,
              idEntry.project_item_id,
              syncState.field_ids[fm.start_date],
              { date: task.start_date },
            ),
          );
        }
        if (task.end_date && syncState.field_ids[fm.end_date]) {
          fieldUpdates.push(
            updateProjectItemField(
              gql,
              syncState.project_node_id,
              idEntry.project_item_id,
              syncState.field_ids[fm.end_date],
              { date: task.end_date },
            ),
          );
        }
        if (fm.type && syncState.field_ids[fm.type]) {
          const typeOptionId = resolveTypeOptionId(
            task.type,
            config.task_types,
            fm.type,
            syncState.option_ids,
          );
          if (typeOptionId) {
            fieldUpdates.push(
              updateProjectItemField(
                gql,
                syncState.project_node_id,
                idEntry.project_item_id,
                syncState.field_ids[fm.type],
                { singleSelectOptionId: typeOptionId },
              ),
            );
          }
        }
        const priorityUpdate = buildPriorityFieldUpdate(
          gql,
          syncState,
          fm,
          idEntry.project_item_id,
          task,
        );
        if (priorityUpdate) fieldUpdates.push(priorityUpdate);

        if (fieldUpdates.length > 0) {
          await Promise.all(fieldUpdates);
        }
      }

      const snapshot = syncState.snapshots[task.id];
      if (idEntry.issue_node_id) {
        // Capture pre-mutation baseline for rollback on failure
        preRelationBaseline.set(task.id, {
          parent: snapshot?.syncFields?.parent ?? null,
          blocked_by: snapshot?.syncFields?.blocked_by ?? [],
        });

        let parentFailed = false;
        let blockedByFailed = false;
        const oldParent = snapshot?.syncFields?.parent ?? null;
        const newParent = task.parent;

        // Parent change: remove then add (order matters)
        if (oldParent !== newParent) {
          if (oldParent) {
            const oldParentEntry = syncState.id_map[oldParent];
            if (oldParentEntry?.issue_node_id) {
              try {
                await removeSubIssue(gql, oldParentEntry.issue_node_id, idEntry.issue_node_id);
              } catch (err) {
                console.warn(`  ⚠ sub-issue 関係の削除に失敗 (${task.id}): ${formatError(err)}`);
                parentFailed = true;
              }
            }
          }
          if (newParent) {
            const newParentEntry = syncState.id_map[newParent];
            if (newParentEntry?.issue_node_id) {
              try {
                await addSubIssueWithRetry(
                  gql,
                  newParentEntry.issue_node_id,
                  idEntry.issue_node_id,
                );
              } catch (err) {
                console.warn(`  ⚠ sub-issue 関係の設定に失敗 (${task.id}): ${formatError(err)}`);
                parentFailed = true;
              }
            } else {
              console.warn(
                `  ⚠ issue_node_id が取得できないため sub-issue 関係をスキップ (${newParent})`,
              );
              parentFailed = true;
            }
          }
        }

        // Blocked-by changes (all independent, parallel)
        const oldBlockedBy = new Set((snapshot?.syncFields?.blocked_by ?? []).map((d) => d.task));
        const newBlockedBy = new Set((task.blocked_by ?? []).map((d) => d.task));

        const blockerMutations: Promise<{ ok: boolean }>[] = [];

        for (const dep of task.blocked_by ?? []) {
          if (!oldBlockedBy.has(dep.task)) {
            const blockerEntry = syncState.id_map[dep.task];
            if (blockerEntry?.issue_node_id) {
              blockerMutations.push(
                addBlockedByIssue(gql, idEntry.issue_node_id, blockerEntry.issue_node_id).then(
                  () => ({ ok: true }),
                  (err) => {
                    console.warn(
                      `  ⚠ blocked-by 関係の設定に失敗 (${task.id} ← ${dep.task}): ${formatError(err)}`,
                    );
                    return { ok: false };
                  },
                ),
              );
            } else {
              console.warn(
                `  ⚠ issue_node_id が取得できないため blocked-by 関係をスキップ (${task.id} ← ${dep.task})`,
              );
              blockedByFailed = true;
            }
          }
        }

        for (const dep of snapshot?.syncFields?.blocked_by ?? []) {
          if (!newBlockedBy.has(dep.task)) {
            const blockerEntry = syncState.id_map[dep.task];
            if (blockerEntry?.issue_node_id) {
              blockerMutations.push(
                removeBlockedByIssue(gql, idEntry.issue_node_id, blockerEntry.issue_node_id).then(
                  () => ({ ok: true }),
                  (err) => {
                    console.warn(
                      `  ⚠ blocked-by 関係の削除に失敗 (${task.id} ← ${dep.task}): ${formatError(err)}`,
                    );
                    return { ok: false };
                  },
                ),
              );
            } else {
              console.warn(
                `  ⚠ issue_node_id が取得できないため blocked-by 削除をスキップ (${task.id} ← ${dep.task})`,
              );
              blockedByFailed = true;
            }
          }
        }

        if (blockerMutations.length > 0) {
          const results = await Promise.all(blockerMutations);
          if (results.some((r) => !r.ok)) blockedByFailed = true;
        }

        if (parentFailed || blockedByFailed) {
          failedRelations.set(task.id, { parentFailed, blockedByFailed });
        }
      }

      pushedTaskIds.add(task.id);
      result.updated++;
    }
  }

  const freshUpdatedAt = await fetchFreshUpdatedAt(gql, owner, repo, tasksFile, pushedTaskIds);

  // Update snapshots — only for tasks that were actually pushed
  const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };

  // Remove stale draft snapshots whose IDs were replaced
  for (const oldId of replacedDraftIds) {
    delete newSnapshots[oldId];
  }

  // Update snapshots only for pushed tasks; preserve existing snapshots for others
  for (const id of pushedTaskIds) {
    const task = tasksFile.tasks.find((t) => t.id === id);
    if (task) {
      const existing = newSnapshots[id];
      let syncFields = extractSyncFields(task);

      // If relationship mutations partially failed, roll back only the failed fields
      // to the pre-mutation baseline so computeLocalDiff detects the diff on next push
      const failure = failedRelations.get(id);
      if (failure) {
        const baseline = preRelationBaseline.get(id);
        if (baseline) {
          if (failure.parentFailed) {
            syncFields = { ...syncFields, parent: baseline.parent };
          }
          if (failure.blockedByFailed) {
            syncFields = { ...syncFields, blocked_by: baseline.blocked_by };
          }
        }
      }

      // Hash must match syncFields so diff detection works correctly
      const snapshotHash = failure ? hashSyncFields(syncFields) : hashTask(task);

      newSnapshots[id] = {
        hash: snapshotHash,
        synced_at: new Date().toISOString(),
        syncFields,
        updated_at: freshUpdatedAt.get(id) ?? existing?.updated_at,
        remoteHash: snapshotHash,
      };
    }
  }

  syncState = {
    ...syncState,
    last_synced_at: new Date().toISOString(),
    snapshots: newSnapshots,
  };

  return { result, tasksFile, syncState };
}

function resolveTypeOptionId(
  typeName: string,
  taskTypes: Record<string, TaskType>,
  typeFieldName: string,
  optionIds?: Record<string, Record<string, string>>,
): string | undefined {
  const typeDef = taskTypes[typeName];
  if (!typeDef?.github_field_value) return undefined;
  return optionIds?.[typeFieldName]?.[typeDef.github_field_value];
}

function resolvePriorityOptionId(
  priorityValue: string,
  fieldName: string,
  optionIds?: Record<string, Record<string, string>>,
): string | undefined {
  const fieldOptions = optionIds?.[fieldName];
  if (!fieldOptions) return undefined;
  // Exact match first, then case-insensitive fallback
  if (fieldOptions[priorityValue]) return fieldOptions[priorityValue];
  const lowerValue = priorityValue.toLowerCase();
  for (const [key, id] of Object.entries(fieldOptions)) {
    if (key.toLowerCase() === lowerValue) return id;
  }
  return undefined;
}

const BATCH_SIZE = 100;

async function fetchBatchUpdatedAt(
  gql: typeof graphql,
  owner: string,
  repo: string,
  issueNumbers: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (issueNumbers.length === 0) return result;

  for (let i = 0; i < issueNumbers.length; i += BATCH_SIZE) {
    const batch = issueNumbers.slice(i, i + BATCH_SIZE);
    try {
      const query = buildIssueUpdatedAtQuery(owner, repo, batch);
      const data = await gql<{
        repository: Record<string, { number: number; updatedAt: string } | null>;
      }>(query);
      for (let j = 0; j < batch.length; j++) {
        const issue = data.repository[`i${j}`];
        if (issue?.updatedAt) {
          result.set(issue.number, issue.updatedAt);
        }
      }
    } catch (err) {
      console.warn(
        `⚠ updatedAt の取得に失敗 (${owner}/${repo} #${batch.join(", #")}): ${formatError(err)}`,
      );
    }
  }
  return result;
}

async function fetchFreshUpdatedAt(
  gql: typeof graphql,
  owner: string,
  repo: string,
  tasksFile: TasksFile,
  pushedTaskIds: Set<string>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const taskById = new Map(tasksFile.tasks.map((t) => [t.id, t]));
  const ids = [...pushedTaskIds].filter((id) => !isDraftTask(id) && !isMilestoneSyntheticTask(id));
  const numberToId = new Map<number, string>();
  for (const id of ids) {
    const task = taskById.get(id);
    if (task?.github_issue) numberToId.set(task.github_issue, id);
  }

  const updatedAtByNumber = await fetchBatchUpdatedAt(gql, owner, repo, [...numberToId.keys()]);
  for (const [number, ts] of updatedAtByNumber) {
    const id = numberToId.get(number);
    if (id) result.set(id, ts);
  }
  return result;
}

function buildPriorityFieldUpdate(
  gql: typeof graphql,
  syncState: SyncState,
  fm: Config["sync"]["field_mapping"],
  projectItemId: string,
  task: Task,
): Promise<unknown> | null {
  if (!fm.priority || !syncState.field_ids[fm.priority]) return null;
  const priorityValue = task.custom_fields[fm.priority] as string | undefined;
  if (!priorityValue) return null;
  const optionId = resolvePriorityOptionId(priorityValue, fm.priority, syncState.option_ids);
  if (!optionId) return null;
  return updateProjectItemField(
    gql,
    syncState.project_node_id,
    projectItemId,
    syncState.field_ids[fm.priority],
    {
      singleSelectOptionId: optionId,
    },
  );
}
