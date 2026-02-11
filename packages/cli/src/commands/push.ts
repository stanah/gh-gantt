import { createInterface } from "node:readline";
import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { computeLocalDiff, estimateApiCalls } from "../sync/diff.js";
import { executePush } from "../sync/push-executor.js";
import { isDraftTask, isMilestoneDraftTask, isMilestoneSyntheticTask } from "../github/issues.js";

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export const pushCommand = new Command("push")
  .description("Push local changes to GitHub Project")
  .option("--dry-run", "Show changes without applying")
  .option("-y, --yes", "Skip confirmation prompt")
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

    // Exclude synthetic milestone tasks (read-only)
    const pushableDiffs = diffs.filter((d) => !isMilestoneSyntheticTask(d.id));

    if (pushableDiffs.length === 0) {
      console.log("No local changes to push.");
      return;
    }

    const milestoneCount = pushableDiffs.filter((d) => d.type !== "deleted" && isMilestoneDraftTask(d.task)).length;
    const draftCount = pushableDiffs.filter((d) => isDraftTask(d.id)).length - milestoneCount;
    const existingCount = pushableDiffs.length - draftCount - milestoneCount;

    console.log(`Found ${pushableDiffs.length} local change(s):`);
    if (milestoneCount > 0) console.log(`  ${milestoneCount} milestone(s) to create`);
    if (draftCount > 0) console.log(`  ${draftCount} draft task(s) to create`);
    if (existingCount > 0) console.log(`  ${existingCount} existing task(s) to update`);

    for (const diff of pushableDiffs) {
      const isMilestone = diff.type !== "deleted" && isMilestoneDraftTask(diff.task);
      const symbol = isMilestone ? "*" : diff.type === "added" ? "+" : diff.type === "modified" ? "~" : "-";
      const tag = isMilestone
        ? ` [milestone${diff.task.date ? `, due: ${diff.task.date}` : ""}]`
        : isDraftTask(diff.id) ? " [draft]" : "";
      const fields = diff.changedFields?.length ? ` [${diff.changedFields.join(", ")}]` : "";
      console.log(`  ${symbol} ${diff.id}: ${diff.task.title ?? "(deleted)"}${tag}${fields}`);
    }

    const estimated = estimateApiCalls(pushableDiffs);
    console.log(`\nEstimated GitHub API calls: ~${estimated}`);

    if (opts.dryRun) {
      console.log("\nDry run — no changes pushed.");
      return;
    }

    if (!opts.yes && process.stdin.isTTY) {
      const confirmed = await confirm("\nProceed with push?");
      if (!confirmed) {
        console.log("Push cancelled.");
        return;
      }
    }

    const gql = await createGraphQLClient();
    const { result, tasksFile: updatedTasksFile, syncState: updatedSyncState } =
      await executePush(gql, config, tasksFile, syncState);

    await tasksStore.write(updatedTasksFile);
    await stateStore.write(updatedSyncState);

    console.log(`Push complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`);
  });
