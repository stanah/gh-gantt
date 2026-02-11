import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { computeLocalDiff } from "../sync/diff.js";
import { executePush } from "../sync/push-executor.js";
import { isDraftTask } from "../github/issues.js";

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

    const draftCount = diffs.filter((d) => isDraftTask(d.id)).length;
    const existingCount = diffs.length - draftCount;

    console.log(`Found ${diffs.length} local change(s):`);
    if (draftCount > 0) console.log(`  ${draftCount} draft task(s) to create`);
    if (existingCount > 0) console.log(`  ${existingCount} existing task(s) to update`);

    for (const diff of diffs) {
      const symbol = diff.type === "added" ? "+" : diff.type === "modified" ? "~" : "-";
      const draft = isDraftTask(diff.id) ? " [draft]" : "";
      const fields = diff.changedFields?.length ? ` [${diff.changedFields.join(", ")}]` : "";
      console.log(`  ${symbol} ${diff.id}: ${diff.task.title ?? "(deleted)"}${draft}${fields}`);
    }

    if (opts.dryRun) {
      console.log("Dry run — no changes pushed.");
      return;
    }

    const gql = await createGraphQLClient();
    const { result, tasksFile: updatedTasksFile, syncState: updatedSyncState } =
      await executePush(gql, config, tasksFile, syncState);

    await tasksStore.write(updatedTasksFile);
    await stateStore.write(updatedSyncState);

    console.log(`Push complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`);
  });
