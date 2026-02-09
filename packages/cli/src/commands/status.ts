import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { fetchProject } from "../github/projects.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { computeLocalDiff } from "../sync/diff.js";
import { detectConflicts } from "../sync/conflict.js";
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
      }
      console.log();
      console.log(`Strategy: ${config.sync.conflict_strategy}`);
    }
  });
