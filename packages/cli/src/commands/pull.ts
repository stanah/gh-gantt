import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { fetchProject, fetchRepositoryMetadata } from "../github/projects.js";
import { fetchAllIssueRelationshipLinks } from "../github/sub-issues.js";
import { fetchAllComments } from "../github/comments.js";
import { applySubIssueLinks, applyBlockedByLinks, isDraftTask, isMilestoneSyntheticTask, milestoneToTask } from "../github/issues.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { CommentsStore } from "../store/comments.js";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import { threeWayMerge } from "../sync/three-way-merge.js";
import { applyConflictMarkers } from "../sync/conflict-marker.js";
import { mapRemoteItemToTask } from "../sync/mapper.js";
import { formatValue } from "../util/format.js";

export const pullCommand = new Command("pull")
  .description("Pull latest changes from GitHub Project")
  .option("--dry-run", "Show changes without applying")
  .option("--with-comments", "Also fetch issue comments")
  .option("--force-comments", "Re-fetch all comments (implies --with-comments)")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

    // Guard: Unresolved conflicts must be resolved before next pull
    if (tasksFile.has_conflicts) {
      console.error("未解決のコンフリクトがあります。先に resolve してください");
      process.exit(1);
    }

    const gql = await createGraphQLClient();
    const { owner, project_number } = config.project.github;
    const projectData = await fetchProject(gql, owner, project_number);

    console.log(`Fetched ${projectData.items.length} items from GitHub`);

    // Map remote items to tasks
    const remoteTasks = new Map<string, import("@gh-gantt/shared").Task>();
    for (const item of projectData.items) {
      const task = mapRemoteItemToTask(item, config);
      if (task) remoteTasks.set(task.id, task);
    }

    // Fetch native GitHub Milestones and inject synthetic tasks
    const { owner: repoOwner, repo: repoName } = config.project.github;
    const repoFullName = `${repoOwner}/${repoName}`;
    const repoMetadata = await fetchRepositoryMetadata(gql, repoOwner, repoName);
    for (const m of repoMetadata.milestones) {
      if (!m.dueOn) continue;
      const syntheticTask = milestoneToTask(m, repoFullName);
      remoteTasks.set(syntheticTask.id, syntheticTask);
    }

    // Quick check: skip sub-issues fetch if no remote changes
    const localNonDraft = tasksFile.tasks.filter((t) => !isDraftTask(t.id));
    const localIds = new Set(localNonDraft.map((t) => t.id));
    const remoteIds = new Set(remoteTasks.keys());
    const sameIdSets = localIds.size === remoteIds.size && [...localIds].every((id) => remoteIds.has(id));
    if (sameIdSets) {
      let changed = false;
      for (const [id, remote] of remoteTasks) {
        const snap = syncState.snapshots[id];
        if (!snap?.updated_at) { changed = true; break; }
        if (remote.updated_at !== snap.updated_at) { changed = true; break; }
        if (isMilestoneSyntheticTask(id) && !snap.hash) { changed = true; break; }
      }
      if (!changed) {
        if (!opts.withComments && !opts.forceComments) {
          console.log("No remote changes detected, skipping sub-issues fetch.");
          console.log(`Pull summary: +0 ~0 !0 -0`);
          console.log("Pull complete.");
          return;
        }
        console.log("No remote changes detected, but fetching comments as requested.");
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

    const mergedTasks: import("@gh-gantt/shared").Task[] = [];

    // Process remote tasks — 3-way merge
    for (const [id, remoteTask] of remoteTasks) {
      const localTask = localTaskMap.get(id);
      if (!localTask) {
        // New task from remote
        if (opts.dryRun) {
          console.log(`  + ${id}: ${remoteTask.title}`);
        }
        mergedTasks.push(remoteTask);
        added++;
      } else {
        const snapshot = syncState.snapshots[id];
        const remoteHash = hashTask(remoteTask);
        const snapshotRemoteHash = snapshot?.remoteHash ?? snapshot?.hash;

        if (remoteHash === snapshotRemoteHash) {
          // Remote unchanged since last sync → keep local
          mergedTasks.push(localTask);
        } else if (!snapshot || !snapshot.syncFields) {
          // No snapshot or no syncFields → fall back to remote
          if (opts.dryRun) {
            console.log(`  ~ ${id}: ${remoteTask.title}`);
          }
          mergedTasks.push(remoteTask);
          updated++;
        } else {
          // 3-way merge
          const localFields = extractSyncFields(localTask);
          const remoteFields = extractSyncFields(remoteTask);
          const { merged, conflicts } = threeWayMerge(snapshot.syncFields, localFields, remoteFields);

          const mergedTask: import("@gh-gantt/shared").Task = { ...localTask, ...merged };
          // Always update read-only fields from remote
          mergedTask.created_at = remoteTask.created_at;
          mergedTask.updated_at = remoteTask.updated_at;
          mergedTask.closed_at = remoteTask.closed_at;
          mergedTask.state_reason = remoteTask.state_reason;
          mergedTask.linked_prs = remoteTask.linked_prs;

          if (conflicts.length > 0) {
            const marked = applyConflictMarkers(mergedTask, conflicts);
            mergedTasks.push(marked as unknown as import("@gh-gantt/shared").Task);
            hasConflictsFlag = true;
            conflictCount++;
            if (opts.dryRun) {
              console.log(`  ! ${id}: ${remoteTask.title} (${conflicts.length} conflict(s))`);
              for (const c of conflicts) {
                console.log(`      ${c.field}: local=${formatValue(c.current)} remote=${formatValue(c.incoming)}`);
              }
            }
          } else {
            mergedTasks.push(mergedTask);
            // Only count as updated if something actually changed
            const localHash = hashTask(localTask);
            const mergedHash = hashTask(mergedTask);
            if (localHash !== mergedHash) {
              if (opts.dryRun) {
                console.log(`  ~ ${id}: ${remoteTask.title}`);
              }
              updated++;
            }
          }
        }
        localTaskMap.delete(id);
      }
    }

    // Tasks that exist locally but not remotely
    for (const [id, localTask] of localTaskMap) {
      if (isDraftTask(id)) {
        mergedTasks.push(localTask);
        continue;
      }
      // Check if local task was modified since last sync (delete/modify conflict)
      const snapshot = syncState.snapshots[id];
      if (snapshot) {
        const localHash = hashTask(localTask);
        if (localHash !== snapshot.hash) {
          // Local changed but remote deleted → keep with warning
          console.warn(`  ⚠ ${id}: ${localTask.title} (locally modified but removed from remote — keeping)`);
          mergedTasks.push(localTask);
          continue;
        }
      }
      // Local unchanged → remove
      if (opts.dryRun) {
        console.log(`  - ${id}: ${localTask.title}`);
      }
      removed++;
    }

    console.log(`Pull summary: +${added} ~${updated} !${conflictCount} -${removed}`);

    if (opts.dryRun) {
      console.log("Dry run — no changes applied.");
      return;
    }

    // Update snapshots
    const newSnapshots = { ...syncState.snapshots };
    for (const task of mergedTasks) {
      const remoteTask = remoteTasks.get(task.id);
      const remoteHash = remoteTask ? hashTask(remoteTask) : undefined;
      const existing = syncState.snapshots[task.id];

      // Check if this task has conflicts (was marked)
      const isConflicted = hasConflictsFlag && remoteTask && existing?.syncFields && (() => {
        const localFields = extractSyncFields(task);
        const remoteFields = extractSyncFields(remoteTask);
        const { conflicts } = threeWayMerge(existing.syncFields!, localFields, remoteFields);
        return conflicts.length > 0;
      })();

      // Check if this task has unpushed local changes
      const hasLocalChanges = existing && hashTask(task) !== existing.hash;

      if (isConflicted || hasLocalChanges) {
        // Conflicted or has unpushed local changes:
        // Update remoteHash only, preserve hash so local changes remain pushable
        newSnapshots[task.id] = {
          ...(existing ?? { hash: hashTask(task), synced_at: new Date().toISOString() }),
          remoteHash,
        };
      } else if (existing && remoteHash === (existing.remoteHash ?? existing.hash)) {
        // Unchanged remote → preserve existing snapshot
        newSnapshots[task.id] = { ...existing, remoteHash };
      } else {
        // Conflict-free merged with no local changes, or new task → full snapshot update
        newSnapshots[task.id] = {
          hash: hashTask(task),
          synced_at: new Date().toISOString(),
          updated_at: task.updated_at,
          syncFields: extractSyncFields(task),
          remoteHash,
        };
      }
    }
    // Remove snapshots for deleted tasks
    for (const id of localTaskMap.keys()) {
      delete newSnapshots[id];
    }

    // Update option_ids from latest project data
    const optionIds: Record<string, Record<string, string>> = {};
    for (const field of projectData.fields) {
      if (field.options && field.options.length > 0) {
        const optMap: Record<string, string> = {};
        for (const opt of field.options) {
          optMap[opt.name] = opt.id;
        }
        optionIds[field.name] = optMap;
      }
    }

    await tasksStore.write({
      tasks: mergedTasks,
      cache: tasksFile.cache,
      ...(hasConflictsFlag ? { has_conflicts: true } : {}),
    });
    await stateStore.write({
      ...syncState,
      last_synced_at: new Date().toISOString(),
      snapshots: newSnapshots,
      option_ids: optionIds,
    });

    if (hasConflictsFlag) {
      console.warn(`\n${conflictCount} task(s) have conflicts. Run 'gh-gantt resolve' to resolve them.`);
    }

    console.log("Pull complete.");

    // Fetch comments if requested
    if (opts.withComments || opts.forceComments) {
      try {
        const commentsStore = new CommentsStore(projectRoot);
        const commentsFile = await commentsStore.read();

        const commentItems = mergedTasks
          .filter((t) => t.github_issue !== null && !isDraftTask(t.id) && !isMilestoneSyntheticTask(t.id))
          .map((t) => {
            const [owner, repo] = t.github_repo.split("/");
            return { taskId: t.id, owner, repo, issueNumber: t.github_issue! };
          });

        const updatedComments = await fetchAllComments(
          gql,
          commentItems,
          commentsFile,
          (data) => commentsStore.write(data),
          { force: !!opts.forceComments },
        );

        // Clean up comments for deleted tasks
        const taskIds = new Set(mergedTasks.map((t) => t.id));
        for (const key of Object.keys(updatedComments.fetched_at)) {
          if (!taskIds.has(key)) {
            delete updatedComments.fetched_at[key];
            delete updatedComments.comments[key];
          }
        }

        await commentsStore.write(updatedComments);
      } catch (err) {
        console.warn(`Warning: failed to fetch comments: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
