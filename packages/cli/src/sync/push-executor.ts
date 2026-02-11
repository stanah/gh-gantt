import type { graphql } from "@octokit/graphql";
import type { Config, Task, SyncState, TasksFile, TaskType } from "@gh-gantt/shared";
import { computeLocalDiff } from "./diff.js";
import { hashTask, extractSyncFields } from "./hash.js";
import { isDraftTask, isMilestoneSyntheticTask, buildTaskId } from "../github/issues.js";
import { fetchRepositoryId, fetchRepositoryMetadata, fetchUserIds } from "../github/projects.js";
import {
  createIssue,
  addProjectItem,
  addSubIssue,
  updateIssue,
  setIssueState,
  updateProjectItemField,
} from "../github/mutations.js";

export interface PushResult {
  created: number;
  updated: number;
  skipped: number;
}

export function replaceTaskIdReferences(
  tasks: Task[],
  oldId: string,
  newId: string,
): void {
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
): Promise<{ result: PushResult; tasksFile: TasksFile; syncState: SyncState }> {
  const diffs = computeLocalDiff(tasksFile.tasks, syncState);
  const result: PushResult = { created: 0, updated: 0, skipped: 0 };

  if (diffs.length === 0) {
    return { result, tasksFile, syncState };
  }

  const fm = config.sync.field_mapping;
  const { owner, repo } = config.project.github;

  // Filter out synthetic milestone tasks (read-only, managed by pull)
  const nonSyntheticDiffs = diffs.filter((d) => !isMilestoneSyntheticTask(d.id));

  // Separate draft tasks from existing tasks
  const draftDiffs = nonSyntheticDiffs.filter((d) => isDraftTask(d.id));
  const existingDiffs = nonSyntheticDiffs.filter((d) => !isDraftTask(d.id));

  // Process draft tasks (create issues) if auto_create_issues is enabled
  if (config.sync.auto_create_issues && draftDiffs.length > 0) {
    const repositoryId = await fetchRepositoryId(gql, owner, repo);

    // Resolve labels, milestones, and assignees in bulk
    const metadata = await fetchRepositoryMetadata(gql, owner, repo);
    const allAssignees = new Set<string>();
    for (const d of draftDiffs) {
      if (d.type !== "deleted") {
        for (const a of d.task.assignees) allAssignees.add(a);
      }
    }
    const userIdMap = await fetchUserIds(gql, [...allAssignees]);
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
      const projectItemId = await addProjectItem(
        gql,
        syncState.project_node_id,
        issueId,
      );

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
        const typeOptionId = resolveTypeOptionId(task.type, config.task_types, fm.type, syncState.option_ids);
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

      createdTaskIds.push(newId);
      result.created++;
    }

    // Set up sub-issue relationships for newly created issues
    for (const id of createdTaskIds) {
      const task = tasksFile.tasks.find((t) => t.id === id);
      if (!task?.parent) continue;
      const childEntry = syncState.id_map[task.id];
      const parentEntry = syncState.id_map[task.parent];
      if (!childEntry?.issue_node_id || !parentEntry?.issue_node_id) continue;

      try {
        await addSubIssue(gql, parentEntry.issue_node_id, childEntry.issue_node_id);
      } catch {
        // Sub-issues API may not be available; skip silently
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
        await updateIssue(gql, idEntry.issue_node_id, {
          title: task.title,
          body: task.body ?? undefined,
        });

        if (syncState.snapshots[task.id]) {
          await setIssueState(gql, idEntry.issue_node_id, task.state);
        }
      }

      if (task.start_date && syncState.field_ids[fm.start_date]) {
        await updateProjectItemField(
          gql,
          syncState.project_node_id,
          idEntry.project_item_id,
          syncState.field_ids[fm.start_date],
          { date: task.start_date },
        );
      }
      if (task.end_date && syncState.field_ids[fm.end_date]) {
        await updateProjectItemField(
          gql,
          syncState.project_node_id,
          idEntry.project_item_id,
          syncState.field_ids[fm.end_date],
          { date: task.end_date },
        );
      }

      // Update Type custom field if configured
      if (fm.type && syncState.field_ids[fm.type]) {
        const typeOptionId = resolveTypeOptionId(task.type, config.task_types, fm.type, syncState.option_ids);
        if (typeOptionId) {
          await updateProjectItemField(
            gql,
            syncState.project_node_id,
            idEntry.project_item_id,
            syncState.field_ids[fm.type],
            { singleSelectOptionId: typeOptionId },
          );
        }
      }

      result.updated++;
    }
  }

  // Update snapshots
  const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };
  for (const task of tasksFile.tasks) {
    newSnapshots[task.id] = {
      hash: hashTask(task),
      synced_at: new Date().toISOString(),
      syncFields: extractSyncFields(task),
    };
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
