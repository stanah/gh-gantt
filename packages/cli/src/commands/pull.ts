import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { fetchProject } from "../github/projects.js";
import { fetchAllSubIssueLinks } from "../github/sub-issues.js";
import { applySubIssueLinks, isDraftTask } from "../github/issues.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { hashTask } from "../sync/hash.js";
import { mapRemoteItemToTask, mergeRemoteIntoLocal } from "../sync/mapper.js";

export const pullCommand = new Command("pull")
  .description("Pull latest changes from GitHub Project")
  .option("--dry-run", "Show changes without applying")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

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

    // Fetch and apply sub-issue links
    const issueItems = projectData.items
      .filter((i) => i.content)
      .map((i) => ({ number: i.content!.number, repository: i.content!.repository }));
    const subIssueLinks = await fetchAllSubIssueLinks(gql, issueItems);
    const remoteTaskArray = Array.from(remoteTasks.values());
    applySubIssueLinks(remoteTaskArray, subIssueLinks);
    for (const t of remoteTaskArray) remoteTasks.set(t.id, t);

    const localTaskMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));

    let added = 0;
    let updated = 0;
    let removed = 0;

    const newTasks: import("@gh-gantt/shared").Task[] = [];

    // Process remote tasks
    for (const [id, remoteTask] of remoteTasks) {
      const localTask = localTaskMap.get(id);
      if (!localTask) {
        // New task from remote
        if (opts.dryRun) {
          console.log(`  + ${id}: ${remoteTask.title}`);
        }
        newTasks.push(remoteTask);
        added++;
      } else {
        const remoteHash = hashTask(remoteTask);
        const snapshotHash = syncState.snapshots[id]?.hash;

        if (remoteHash !== snapshotHash) {
          // Remote changed since last sync
          const merged = mergeRemoteIntoLocal(localTask, remoteTask);
          if (opts.dryRun) {
            console.log(`  ~ ${id}: ${remoteTask.title}`);
          }
          newTasks.push(merged);
          updated++;
        } else {
          // No remote changes, keep local version
          newTasks.push(localTask);
        }
        localTaskMap.delete(id);
      }
    }

    // Tasks that exist locally but not remotely
    for (const [id, localTask] of localTaskMap) {
      if (isDraftTask(id)) {
        newTasks.push(localTask);
        continue;
      }
      if (opts.dryRun) {
        console.log(`  - ${id}: ${localTask.title}`);
      }
      removed++;
      // Don't include removed tasks
    }

    console.log(`Pull summary: +${added} ~${updated} -${removed}`);

    if (opts.dryRun) {
      console.log("Dry run — no changes applied.");
      return;
    }

    // Update snapshots
    const newSnapshots = { ...syncState.snapshots };
    for (const task of newTasks) {
      newSnapshots[task.id] = {
        hash: hashTask(task),
        synced_at: new Date().toISOString(),
      };
    }
    // Remove snapshots for deleted tasks
    for (const id of localTaskMap.keys()) {
      delete newSnapshots[id];
    }

    await tasksStore.write({ tasks: newTasks, cache: tasksFile.cache });
    await stateStore.write({
      ...syncState,
      last_synced_at: new Date().toISOString(),
      snapshots: newSnapshots,
    });

    console.log("Pull complete.");
  });
