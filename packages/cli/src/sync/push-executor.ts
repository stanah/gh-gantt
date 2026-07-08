import type { graphql } from "@octokit/graphql";
import type { Config, SyncFields, Task, SyncState, TasksFile, TaskType } from "@gh-gantt/shared";
import {
  DEFAULT_ESTIMATE_HOURS_FIELD,
  parseEstimateHours,
  serializeAcceptanceCriteriaBody,
  serializeTaskReviewBody,
  serializeTaskRolesBody,
} from "@gh-gantt/shared";
import { computeLocalDiff } from "./diff.js";
import { hashTask, hashSyncFields, extractSyncFields } from "./hash.js";
import {
  isDraftTask,
  isMilestoneSyntheticTask,
  isMilestoneDraftTask,
  buildTaskId,
  buildMilestoneSyntheticId,
} from "../github/issues.js";
import {
  fetchRepositoryId,
  fetchRepositoryMetadata,
  fetchUserIds,
  fetchOrgIssueTypes,
  type RepositoryMetadata,
} from "../github/projects.js";
import { buildIssueUpdatedAtQuery } from "../github/queries.js";
import { getToken } from "../github/auth.js";
import {
  createIssue,
  addProjectItem,
  addSubIssue,
  removeSubIssue,
  updateIssue,
  updateIssueIssueType,
  setIssueState,
  updateProjectItemField,
  clearProjectItemField,
  createGithubMilestone,
  addBlockedByIssue,
  removeBlockedByIssue,
  type UpdateIssueFields,
} from "../github/mutations.js";
import { formatError } from "../util/format.js";

export interface PushResult {
  created: number;
  updated: number;
  skipped: number;
}

function serializeTaskBodyForGithub(task: Task): string | undefined {
  const bodyWithAcceptanceCriteria = serializeAcceptanceCriteriaBody(
    task.body,
    task.acceptance_criteria,
    {
      includeEmptyBlock: task.acceptance_criteria_slot === true,
    },
  );
  const bodyWithRoles = serializeTaskRolesBody(bodyWithAcceptanceCriteria, {
    implementer: task.implementer,
    reviewer: task.reviewer,
  });
  return (
    serializeTaskReviewBody(bodyWithRoles, {
      require_review: task.require_review,
      review_approved_by: task.review_approved_by,
      review_approved_at: task.review_approved_at,
    }) ?? undefined
  );
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

  // repository metadata (labelMap / milestoneMap) の遅延 fetch キャッシュ。
  // draft 作成経路と既存 Issue の metadata 更新経路 (#305) で共有し、
  // metadata 変更がない push では fetch しない (NFR-SYNC-002)
  let repositoryMetadataPromise: Promise<RepositoryMetadata> | null = null;
  const getRepositoryMetadata = (): Promise<RepositoryMetadata> => {
    repositoryMetadataPromise ??= fetchRepositoryMetadata(gql, owner, repo);
    return repositoryMetadataPromise;
  };

  let issueTypeIdByName: Map<string, string> | undefined;
  const usesGithubIssueTypes = Object.values(config.task_types).some((t) => t.github_issue_type);

  const resolveGithubIssueTypeId = async (typeName: string): Promise<string | null | undefined> => {
    const issueTypeName = config.task_types[typeName]?.github_issue_type ?? null;
    if (!issueTypeName) return null;

    if (!issueTypeIdByName) {
      const orgIssueTypes = await fetchOrgIssueTypes(gql, owner);
      issueTypeIdByName = new Map(orgIssueTypes.map((t) => [t.name, t.id]));
    }

    const issueTypeId = issueTypeIdByName.get(issueTypeName);
    if (!issueTypeId) {
      console.warn(
        `  ⚠ Organization Issue Type "${issueTypeName}" が見つからないため type 同期をスキップ (${typeName})`,
      );
      return undefined;
    }
    return issueTypeId;
  };

  // Track which tasks were actually pushed (by their current ID after push)
  const pushedTaskIds = new Set<string>();
  const replacedDraftIds = new Set<string>();
  // Track per-field relationship mutation failures for accurate partial retry
  interface RelationFailure {
    parentFailed: boolean;
    blockedByFailed: boolean;
  }
  interface IssueTypeFailure {
    previousSyncFields: SyncFields | undefined;
  }
  interface MetadataFailure {
    fields: IssueMetadataFieldName[];
    previousSyncFields: SyncFields | undefined;
  }
  const failedRelations = new Map<string, RelationFailure>();
  const failedIssueTypes = new Map<string, IssueTypeFailure>();
  // 未解決名 (label / assignee / milestone) により送信をスキップしたフィールドの記録 (#305)。
  // snapshot 更新時に該当フィールドだけ旧値へロールバックし、次回 push で再試行可能にする
  const failedMetadata = new Map<string, MetadataFailure>();
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
        description: serializeTaskBodyForGithub(task),
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
      getRepositoryMetadata(),
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
      const issueTypeId = await resolveGithubIssueTypeId(task.type);

      // Create GitHub issue
      const { issueId, issueNumber } = await createIssue(gql, repositoryId, {
        title: task.title,
        body: serializeTaskBodyForGithub(task),
        labelIds,
        milestoneId,
        assigneeIds,
        issueTypeId: issueTypeId ?? undefined,
      });

      // Add to project
      const projectItemId = await addProjectItem(gql, syncState.project_node_id, issueId);

      // Update project fields
      const draftFieldUpdates: Promise<unknown>[] = [];
      if (task.start_date && syncState.field_ids[fm.start_date]) {
        draftFieldUpdates.push(
          updateProjectItemField(
            gql,
            syncState.project_node_id,
            projectItemId,
            syncState.field_ids[fm.start_date],
            { date: task.start_date },
          ),
        );
      }
      if (task.end_date && syncState.field_ids[fm.end_date]) {
        draftFieldUpdates.push(
          updateProjectItemField(
            gql,
            syncState.project_node_id,
            projectItemId,
            syncState.field_ids[fm.end_date],
            { date: task.end_date },
          ),
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
          draftFieldUpdates.push(
            updateProjectItemField(
              gql,
              syncState.project_node_id,
              projectItemId,
              syncState.field_ids[fm.type],
              { singleSelectOptionId: typeOptionId },
            ),
          );
        }
      }

      // Set Priority custom field
      const priorityUpdate = buildPriorityFieldUpdate(gql, syncState, fm, projectItemId, task);
      if (priorityUpdate) draftFieldUpdates.push(priorityUpdate);
      const estimateHoursUpdate = buildEstimateHoursFieldUpdate(
        gql,
        syncState,
        fm,
        projectItemId,
        task,
      );
      if (estimateHoursUpdate) draftFieldUpdates.push(estimateHoursUpdate);
      if (draftFieldUpdates.length > 0) {
        await Promise.all(draftFieldUpdates);
      }

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
          const missingParts = [
            !childEntry?.issue_node_id ? `child:${task.id}` : null,
            !parentEntry?.issue_node_id ? `parent:${task.parent}` : null,
          ]
            .filter(Boolean)
            .join(", ");
          console.warn(
            `  ⚠ issue_node_id が取得できないため sub-issue 関係をスキップ (${missingParts})`,
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
                `  ⚠ issue_node_id が取得できないため blocked-by 関係をスキップ (${task.id} ← blocker:${dep.task})`,
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
            `  ⚠ issue_node_id が取得できないため blocked-by 関係をスキップ (task:${task.id} の issue_node_id が欠損, ${task.blocked_by.length} 件)`,
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

  // 既存 Issue の assignees 変更に必要な login を事前収集し、
  // 1 回の fetchUserIds でまとめて解決する (NFR-SYNC-002)。
  // 変更がない場合は fetch 自体を行わない
  const assigneeLoginsToResolve = new Set<string>();
  for (const diff of existingDiffs) {
    if (diff.type === "deleted") continue;
    const previous = syncState.snapshots[diff.id]?.syncFields;
    if (detectIssueMetadataChanges(diff.task, previous).assignees) {
      for (const login of diff.task.assignees) assigneeLoginsToResolve.add(login);
    }
  }
  let updateUserIdMapPromise: Promise<Map<string, string>> | null = null;
  const getUpdateUserIdMap = (): Promise<Map<string, string>> => {
    updateUserIdMapPromise ??= fetchUserIds(gql, [...assigneeLoginsToResolve]);
    return updateUserIdMapPromise;
  };

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
      const snapshot = syncState.snapshots[task.id];
      if (idEntry.issue_node_id) {
        // assignees / labels / milestone は置換セマンティクスのため、
        // snapshot と差分があるフィールドだけを updateIssue に含める (#305)
        const metadataUpdate = await resolveIssueMetadataUpdate(task, snapshot?.syncFields, {
          getRepositoryMetadata,
          getUserIdMap: getUpdateUserIdMap,
        });
        if (metadataUpdate.failedFields.length > 0) {
          failedMetadata.set(task.id, {
            fields: metadataUpdate.failedFields,
            previousSyncFields: snapshot?.syncFields,
          });
        }

        const issueMutations: Promise<unknown>[] = [
          updateIssue(gql, idEntry.issue_node_id, {
            title: task.title,
            body: serializeTaskBodyForGithub(task),
            ...metadataUpdate.fields,
          }),
          setIssueState(gql, idEntry.issue_node_id, task.state),
        ];

        if (usesGithubIssueTypes && snapshot?.syncFields?.type !== task.type) {
          const issueTypeId = await resolveGithubIssueTypeId(task.type);
          if (issueTypeId !== undefined) {
            issueMutations.push(updateIssueIssueType(gql, idEntry.issue_node_id, issueTypeId));
          } else if (issueTypeId === undefined) {
            failedIssueTypes.set(task.id, {
              previousSyncFields: snapshot?.syncFields,
            });
          }
        }

        await Promise.all(issueMutations);
      }

      if (idEntry.project_item_id) {
        const fieldUpdates: Promise<unknown>[] = [];

        const startDateUpdate = buildDateFieldUpdate(
          gql,
          syncState,
          fm.start_date,
          idEntry.project_item_id,
          task,
          "start_date",
        );
        if (startDateUpdate) fieldUpdates.push(startDateUpdate);
        const endDateUpdate = buildDateFieldUpdate(
          gql,
          syncState,
          fm.end_date,
          idEntry.project_item_id,
          task,
          "end_date",
        );
        if (endDateUpdate) fieldUpdates.push(endDateUpdate);
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
        const estimateHoursUpdate = buildEstimateHoursFieldUpdate(
          gql,
          syncState,
          fm,
          idEntry.project_item_id,
          task,
        );
        if (estimateHoursUpdate) fieldUpdates.push(estimateHoursUpdate);

        if (fieldUpdates.length > 0) {
          await Promise.all(fieldUpdates);
        }
      }

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

  const freshIssueMetadata = await fetchFreshIssueMetadata(
    gql,
    owner,
    repo,
    tasksFile,
    pushedTaskIds,
  );

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
      const freshMetadata = freshIssueMetadata.get(id);
      if (freshMetadata) {
        task.updated_at = freshMetadata.updatedAt;
        task.state_reason = freshMetadata.stateReason;
        task.closed_at = freshMetadata.closedAt;
      }
      let syncFields = extractSyncFields(task);

      const issueTypeFailure = failedIssueTypes.get(id);
      if (issueTypeFailure) {
        if (issueTypeFailure.previousSyncFields) {
          syncFields = { ...syncFields, type: issueTypeFailure.previousSyncFields.type };
        } else {
          if (existing) {
            newSnapshots[id] = {
              ...existing,
              synced_at: new Date().toISOString(),
              updated_at: freshMetadata?.updatedAt ?? existing.updated_at,
            };
          } else {
            delete newSnapshots[id];
          }
          continue;
        }
      }

      // 未解決名により送信をスキップした metadata フィールドは snapshot を旧値に
      // 留めることで computeLocalDiff が次回 push でも差分として検出できるようにする (#305)
      const metadataFailure = failedMetadata.get(id);
      if (metadataFailure) {
        if (metadataFailure.previousSyncFields) {
          if (metadataFailure.fields.includes("assignees")) {
            syncFields = { ...syncFields, assignees: metadataFailure.previousSyncFields.assignees };
          }
          if (metadataFailure.fields.includes("labels")) {
            syncFields = { ...syncFields, labels: metadataFailure.previousSyncFields.labels };
          }
          if (metadataFailure.fields.includes("milestone")) {
            syncFields = { ...syncFields, milestone: metadataFailure.previousSyncFields.milestone };
          }
        } else {
          // 旧値が不明 (snapshot なし) の場合は snapshot を進めず次回 push で再試行する
          if (existing) {
            newSnapshots[id] = {
              ...existing,
              synced_at: new Date().toISOString(),
              updated_at: freshMetadata?.updatedAt ?? existing.updated_at,
            };
          } else {
            delete newSnapshots[id];
          }
          continue;
        }
      }

      // If relationship mutations partially failed, roll back only the failed fields
      // to the pre-mutation baseline so computeLocalDiff detects the diff on next push
      const relationFailure = failedRelations.get(id);
      if (relationFailure) {
        const baseline = preRelationBaseline.get(id);
        if (baseline) {
          if (relationFailure.parentFailed) {
            syncFields = { ...syncFields, parent: baseline.parent };
          }
          if (relationFailure.blockedByFailed) {
            syncFields = { ...syncFields, blocked_by: baseline.blocked_by };
          }
        }
      }

      // Hash must match syncFields so diff detection works correctly
      const hasRetryableFailure = Boolean(issueTypeFailure || relationFailure || metadataFailure);
      const snapshotHash = hasRetryableFailure ? hashSyncFields(syncFields) : hashTask(task);

      newSnapshots[id] = {
        hash: snapshotHash,
        synced_at: new Date().toISOString(),
        syncFields,
        updated_at: freshMetadata?.updatedAt ?? existing?.updated_at,
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

interface FreshIssueMetadata {
  updatedAt: string;
  stateReason: string | null;
  closedAt: string | null;
}

async function fetchBatchIssueMetadata(
  gql: typeof graphql,
  owner: string,
  repo: string,
  issueNumbers: number[],
): Promise<Map<number, FreshIssueMetadata>> {
  const result = new Map<number, FreshIssueMetadata>();
  if (issueNumbers.length === 0) return result;

  for (let i = 0; i < issueNumbers.length; i += BATCH_SIZE) {
    const batch = issueNumbers.slice(i, i + BATCH_SIZE);
    try {
      const query = buildIssueUpdatedAtQuery(owner, repo, batch);
      const data = await gql<{
        repository: Record<
          string,
          {
            number: number;
            updatedAt: string;
            stateReason?: string | null;
            closedAt?: string | null;
          } | null
        >;
      }>(query);
      for (let j = 0; j < batch.length; j++) {
        const issue = data.repository[`i${j}`];
        if (issue?.updatedAt) {
          result.set(issue.number, {
            updatedAt: issue.updatedAt,
            stateReason: issue.stateReason ?? null,
            closedAt: issue.closedAt ?? null,
          });
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

async function fetchBatchUpdatedAt(
  gql: typeof graphql,
  owner: string,
  repo: string,
  issueNumbers: number[],
): Promise<Map<number, string>> {
  const metadata = await fetchBatchIssueMetadata(gql, owner, repo, issueNumbers);
  return new Map([...metadata].map(([number, issue]) => [number, issue.updatedAt]));
}

async function fetchFreshIssueMetadata(
  gql: typeof graphql,
  owner: string,
  repo: string,
  tasksFile: TasksFile,
  pushedTaskIds: Set<string>,
): Promise<Map<string, FreshIssueMetadata>> {
  const result = new Map<string, FreshIssueMetadata>();
  const taskById = new Map(tasksFile.tasks.map((t) => [t.id, t]));
  const ids = [...pushedTaskIds].filter((id) => !isDraftTask(id) && !isMilestoneSyntheticTask(id));
  const numberToId = new Map<number, string>();
  for (const id of ids) {
    const task = taskById.get(id);
    if (task?.github_issue) numberToId.set(task.github_issue, id);
  }

  const metadataByNumber = await fetchBatchIssueMetadata(gql, owner, repo, [...numberToId.keys()]);
  for (const [number, metadata] of metadataByNumber) {
    const id = numberToId.get(number);
    if (id) result.set(id, metadata);
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

/**
 * 日付フィールド (start_date / end_date) の ProjectV2 更新 mutation を組み立てる。
 *
 * ローカルの日付が null の場合、snapshot (syncFields) に以前の値が残っているときだけ
 * clearProjectV2ItemFieldValue でリモート側のフィールドをクリアする (#306)。
 * 以前から null の場合は不要な API コールを避けるため何もしない。
 * buildEstimateHoursFieldUpdate と同じクリア判定パターンに従う。
 */
function buildDateFieldUpdate(
  gql: typeof graphql,
  syncState: SyncState,
  fieldName: string,
  projectItemId: string,
  task: Task,
  dateKey: "start_date" | "end_date",
): Promise<unknown> | null {
  const fieldId = syncState.field_ids[fieldName];
  if (!fieldId) return null;
  const localDate = normalizeDateValue(task[dateKey]);
  if (localDate === null) {
    const previousDate = normalizeDateValue(syncState.snapshots[task.id]?.syncFields?.[dateKey]);
    if (previousDate === null) return null;
    return clearProjectItemField(gql, syncState.project_node_id, projectItemId, fieldId);
  }
  return updateProjectItemField(gql, syncState.project_node_id, projectItemId, fieldId, {
    date: localDate,
  });
}

/**
 * 日付値を「クリア意図 (null)」か「設定する値」に正規化する。
 * 空文字は不正値であり GraphQL に日付として送ってはならないため、null と同じ
 * クリア意図として扱う。
 */
function normalizeDateValue(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}

/** updateIssue で送信する Issue metadata フィールドの名前 (#305) */
type IssueMetadataFieldName = "assignees" | "labels" | "milestone";

/** 2 つの文字列配列をソート済み集合として比較する (assignees / labels 用) */
function stringArraysEqualSorted(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

interface IssueMetadataChanges {
  assignees: boolean;
  labels: boolean;
  milestone: boolean;
}

/**
 * snapshot (syncFields) と比較して assignees / labels / milestone に変更があるか判定する (#305)。
 *
 * snapshot が無い場合 (非 draft の added 経路) はリモートの既存値が不明なため、
 * ローカルに値があるフィールドだけを変更ありとして扱う。
 * 空のフィールドを置換セマンティクスで送るとリモート値を意図せず剥がすため送らない。
 */
function detectIssueMetadataChanges(
  task: Task,
  previous: SyncFields | undefined,
): IssueMetadataChanges {
  if (!previous) {
    return {
      assignees: task.assignees.length > 0,
      labels: task.labels.length > 0,
      milestone: task.milestone !== null,
    };
  }
  return {
    assignees: !stringArraysEqualSorted(task.assignees, previous.assignees),
    labels: !stringArraysEqualSorted(task.labels, previous.labels),
    milestone: task.milestone !== previous.milestone,
  };
}

interface IssueMetadataUpdateResult {
  /** updateIssue に渡す解決済みフィールド (変更がないフィールドはキー自体を含めない) */
  fields: Pick<UpdateIssueFields, "assigneeIds" | "labelIds" | "milestoneId">;
  /** 未解決名により送信をスキップしたフィールド */
  failedFields: IssueMetadataFieldName[];
}

/**
 * 既存 Issue の assignees / labels / milestone の変更を updateIssue 用に解決する (#305)。
 *
 * - snapshot と差分があるフィールドだけを対象にする (不要な API 負荷と意図しない置換を避ける)
 * - assigneeIds / labelIds は全置換のため、1 つでも未解決名があるフィールドは
 *   送信をスキップして警告を出す (silent drop するとリモートの値が剥がれる)
 * - milestone のローカル null 化は milestoneId: null で解除として送信する
 * - metadata の fetch は変更があるフィールドの解決に必要な場合だけ行う (NFR-SYNC-002)
 */
async function resolveIssueMetadataUpdate(
  task: Task,
  previous: SyncFields | undefined,
  deps: {
    getRepositoryMetadata: () => Promise<RepositoryMetadata>;
    getUserIdMap: () => Promise<Map<string, string>>;
  },
): Promise<IssueMetadataUpdateResult> {
  const changes = detectIssueMetadataChanges(task, previous);
  const fields: IssueMetadataUpdateResult["fields"] = {};
  const failedFields: IssueMetadataFieldName[] = [];

  // 解除・全削除は ID 解決が不要なため metadata / user の fetch を伴わずに送信する。
  // fetch が必要なのは非空の名前を ID に解決する場合だけであり、クリア操作が
  // 無関係な fetch の失敗に巻き込まれてブロックされることも防ぐ (NFR-SYNC-002)

  if (changes.assignees) {
    if (task.assignees.length === 0) {
      fields.assigneeIds = [];
    } else {
      const userIdMap = await deps.getUserIdMap();
      const unresolved = task.assignees.filter((login) => !userIdMap.has(login));
      if (unresolved.length > 0) {
        console.warn(
          `  ⚠ assignee が解決できないため assignees の更新をスキップ (${task.id}): ${unresolved.join(", ")}`,
        );
        failedFields.push("assignees");
      } else {
        fields.assigneeIds = task.assignees.map((login) => userIdMap.get(login)!);
      }
    }
  }

  if (changes.labels) {
    if (task.labels.length === 0) {
      fields.labelIds = [];
    } else {
      const metadata = await deps.getRepositoryMetadata();
      const unresolved = task.labels.filter((name) => !metadata.labelMap.has(name));
      if (unresolved.length > 0) {
        console.warn(
          `  ⚠ label が解決できないため labels の更新をスキップ (${task.id}): ${unresolved.join(", ")}`,
        );
        failedFields.push("labels");
      } else {
        fields.labelIds = task.labels.map((name) => metadata.labelMap.get(name)!);
      }
    }
  }

  if (changes.milestone) {
    if (task.milestone === null) {
      // ローカルで milestone が解除された場合は null を明示的に送信して解除する
      fields.milestoneId = null;
    } else {
      const metadata = await deps.getRepositoryMetadata();
      const milestoneId = metadata.milestoneMap.get(task.milestone);
      if (milestoneId === undefined) {
        console.warn(
          `  ⚠ milestone が解決できないため milestone の更新をスキップ (${task.id}): ${task.milestone}`,
        );
        failedFields.push("milestone");
      } else {
        fields.milestoneId = milestoneId;
      }
    }
  }

  return { fields, failedFields };
}

function buildEstimateHoursFieldUpdate(
  gql: typeof graphql,
  syncState: SyncState,
  fm: Config["sync"]["field_mapping"],
  projectItemId: string,
  task: Task,
): Promise<unknown> | null {
  const estimateHoursField = fm.estimate_hours ?? DEFAULT_ESTIMATE_HOURS_FIELD;
  const fieldId = syncState.field_ids[estimateHoursField];
  if (!fieldId) return null;
  const estimateHours = parseEstimateHours(task.custom_fields[estimateHoursField]);
  if (estimateHours === null) {
    const previousEstimateHours = parseEstimateHours(
      syncState.snapshots[task.id]?.syncFields?.custom_fields[estimateHoursField],
    );
    if (previousEstimateHours === null) return null;
    return clearProjectItemField(gql, syncState.project_node_id, projectItemId, fieldId);
  }
  return updateProjectItemField(gql, syncState.project_node_id, projectItemId, fieldId, {
    number: estimateHours,
  });
}
