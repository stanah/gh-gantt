import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { computeLocalDiff } from "../sync/diff.js";
import { hashTask } from "../sync/hash.js";
import { updateIssue, setIssueState, updateProjectItemField } from "../github/mutations.js";
import type { Task, SyncState } from "@gh-gantt/shared";

export const pushCommand = new Command("push")
  .description("Push local changes to GitHub Project")
  .option("--dry-run", "Show changes without applying")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

    const diffs = computeLocalDiff(tasksFile.tasks, syncState);

    if (diffs.length === 0) {
      console.log("No local changes to push.");
      return;
    }

    console.log(`Found ${diffs.length} local change(s):`);
    for (const diff of diffs) {
      const symbol = diff.type === "added" ? "+" : diff.type === "modified" ? "~" : "-";
      console.log(`  ${symbol} ${diff.id}: ${diff.task.title ?? "(deleted)"}`);
    }

    if (opts.dryRun) {
      console.log("Dry run — no changes pushed.");
      return;
    }

    const gql = await createGraphQLClient();
    const fm = config.sync.field_mapping;

    for (const diff of diffs) {
      if (diff.type === "deleted") {
        console.log(`  Skipping deleted task ${diff.id} (GitHub issues not deleted)`);
        continue;
      }

      const task = diff.task;
      const idEntry = syncState.id_map[task.id];
      if (!idEntry) {
        console.log(`  Skipping ${task.id}: no id mapping found`);
        continue;
      }

      if (diff.type === "modified" || diff.type === "added") {
        // Update issue fields
        if (idEntry.issue_node_id) {
          await updateIssue(gql, idEntry.issue_node_id, {
            title: task.title,
            body: task.body ?? undefined,
          });

          // Update state if changed
          const snapshot = syncState.snapshots[task.id];
          if (snapshot) {
            await setIssueState(gql, idEntry.issue_node_id, task.state);
          }
        }

        // Update project field values
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

        console.log(`  Pushed ${task.id}`);
      }
    }

    // Update snapshots
    const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };
    for (const task of tasksFile.tasks) {
      newSnapshots[task.id] = {
        hash: hashTask(task),
        synced_at: new Date().toISOString(),
      };
    }

    await stateStore.write({
      ...syncState,
      last_synced_at: new Date().toISOString(),
      snapshots: newSnapshots,
    });

    console.log("Push complete.");
  });
