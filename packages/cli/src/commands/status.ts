import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { fetchProject } from "../github/projects.js";
import { isDraftTask } from "../github/issues.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { computeLocalDiff } from "../sync/diff.js";
import { detectConflicts, type ConflictFieldDetail } from "../sync/conflict.js";
import { formatValue } from "../util/format.js";
import { mapRemoteItemToTask } from "../sync/mapper.js";
import { hashTask } from "../sync/hash.js";
import type { Task } from "@gh-gantt/shared";

export const statusCommand = new Command("status")
  .description("Show sync status between local and remote")
  .action(async () => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

    // Compute local diff
    const localDiffs = computeLocalDiff(tasksFile.tasks, syncState);

    // Fetch remote and compute remote diff
    const gql = await createGraphQLClient();
    const { owner, project_number } = config.project.github;
    const projectData = await fetchProject(gql, owner, project_number);

    const remoteTasks: Task[] = [];
    for (const item of projectData.items) {
      const task = mapRemoteItemToTask(item, config);
      if (task) remoteTasks.push(task);
    }

    // Compute remote changes
    let remoteChanged = 0;
    for (const remote of remoteTasks) {
      const snapshot = syncState.snapshots[remote.id];
      if (!snapshot || hashTask(remote) !== snapshot.hash) {
        remoteChanged++;
      }
    }

    // Detect conflicts
    const conflicts = detectConflicts(tasksFile.tasks, remoteTasks, syncState);

    // Print status
    console.log(`Last synced: ${syncState.last_synced_at}`);
    console.log(`Local tasks: ${tasksFile.tasks.length}`);
    console.log(`Remote tasks: ${remoteTasks.length}`);
    console.log();

    if (localDiffs.length > 0) {
      console.log("Local changes:");
      for (const diff of localDiffs) {
        const symbol = diff.type === "added" ? "+" : diff.type === "modified" ? "~" : "-";
        console.log(`  ${symbol} ${diff.id}: ${diff.task.title ?? "(deleted)"}`);
      }
    } else {
      console.log("No local changes.");
    }

    console.log();

    if (remoteChanged > 0) {
      console.log(`Remote changes: ${remoteChanged} task(s) modified`);
    } else {
      console.log("No remote changes.");
    }

    if (conflicts.length > 0) {
      console.log();
      console.log(`Conflicts (${conflicts.length}):`);
      for (const c of conflicts) {
        console.log(`  ! ${c.taskId}: ${c.title}`);
        for (const d of c.fieldDetails) {
          const isLocal = c.localChangedFields.includes(d.field);
          const isRemote = c.remoteChangedFields.includes(d.field);
          const tag = `[${isLocal ? "L" : " "}${isRemote ? "R" : " "}]`;
          if (isLocal && isRemote) {
            console.log(`      ${tag} ${d.field}: local=${formatValue(d.local)} remote=${formatValue(d.remote)} \u2190 ${formatValue(d.snapshot)}`);
          } else {
            console.log(`      ${tag} ${d.field}: ${formatValue(isLocal ? d.local : d.remote)} \u2190 ${formatValue(d.snapshot)}`);
          }
        }
      }
      console.log();
      console.log(`Strategy: ${config.sync.conflict_strategy}`);
    }

    // Draft tasks
    const draftTasks = tasksFile.tasks.filter((t) => isDraftTask(t.id));
    if (draftTasks.length > 0) {
      console.log();
      console.log(`Draft tasks (${draftTasks.length}):`);
      for (const t of draftTasks) {
        console.log(`  * ${t.id}: ${t.title} [${t.type}]`);
      }
      if (config.sync.auto_create_issues) {
        console.log('  Run "gh-gantt push" to create GitHub issues.');
      } else {
        console.log('  Set "auto_create_issues: true" in config to enable push.');
      }
    }
  });
