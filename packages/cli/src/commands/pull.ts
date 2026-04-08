import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { isDraftTask, isMilestoneSyntheticTask } from "../github/issues.js";
import { fetchAllComments } from "../github/comments.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { CommentsStore } from "../store/comments.js";
import { executePull } from "../sync/pull-executor.js";
import { formatValue } from "../util/format.js";

export const pullCommand = new Command("pull")
  .description("Pull latest changes from GitHub Project")
  .option("--dry-run", "Show changes without applying")
  .option("--with-comments", "Also fetch issue comments")
  .option("--force-comments", "Re-fetch all comments (implies --with-comments)")
  .option(
    "--force",
    "Bypass sync-state quick-skip and force a full re-fetch (use when sync-state looks inconsistent)",
  )
  .option("--json", "Output as JSON")
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
    const {
      result,
      tasksFile: newTasksFile,
      syncState: newSyncState,
    } = await executePull(gql, config, tasksFile, syncState, { force: opts.force });

    // sync-state 整合性検証の findings を表示 (自動修復 ↻ / 情報 ℹ / 警告 ⚠)
    if (!opts.json) {
      for (const finding of result.syncStateFindings) {
        const prefix = finding.autoFixed
          ? "  ↻ 自動修復"
          : finding.level === "info"
            ? "  ℹ"
            : "  ⚠";
        const log = finding.level === "info" ? console.log : console.warn;
        log(`${prefix}: ${finding.message}`);
      }
    }

    if (result.skipped) {
      // Save updated field/option metadata even when no task changes
      await stateStore.write(newSyncState);

      if (!opts.withComments && !opts.forceComments) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                skipped: true,
                dry_run: !!opts.dryRun,
                summary: { added: 0, updated: 0, conflicts: 0, removed: 0 },
                details: [],
                sync_state_findings: result.syncStateFindings,
              },
              null,
              2,
            ),
          );
        } else {
          console.log("No remote changes detected, skipping sub-issues fetch.");
          console.log(`Pull summary: +0 ~0 !0 -0`);
          console.log("Pull complete.");
        }
        return;
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              skipped: true,
              dry_run: !!opts.dryRun,
              summary: { added: 0, updated: 0, conflicts: 0, removed: 0 },
              details: [],
              sync_state_findings: result.syncStateFindings,
            },
            null,
            2,
          ),
        );
      } else {
        console.log("No remote changes detected, but fetching comments as requested.");
        console.log(`Pull summary: +0 ~0 !0 -0`);
        console.log("Pull complete.");
      }
      await fetchAndSaveComments(gql, tasksFile.tasks, projectRoot, opts);
      return;
    }

    if (opts.json) {
      // JSON 出力（dry-run 含む）
      console.log(
        JSON.stringify(
          {
            skipped: false,
            dry_run: !!opts.dryRun,
            summary: {
              added: result.added,
              updated: result.updated,
              conflicts: result.conflicts,
              removed: result.removed,
            },
            details: result.details,
            sync_state_findings: result.syncStateFindings,
          },
          null,
          2,
        ),
      );

      if (!opts.dryRun) {
        await tasksStore.write(newTasksFile);
        await stateStore.write(newSyncState);
        await fetchAndSaveComments(gql, newTasksFile.tasks, projectRoot, opts);
      }
      return;
    }

    console.log(`Fetched items from GitHub`);

    // Dry-run reporting
    if (opts.dryRun) {
      for (const d of result.details) {
        switch (d.type) {
          case "added":
            console.log(`  + ${d.id}: ${d.title}`);
            break;
          case "updated":
            console.log(`  ~ ${d.id}: ${d.title}`);
            break;
          case "removed":
            console.log(`  - ${d.id}: ${d.title}`);
            break;
          case "conflict":
            console.log(`  ! ${d.id}: ${d.title} (${d.conflictFields?.length ?? 0} conflict(s))`);
            for (const c of d.conflictFields ?? []) {
              console.log(
                `      ${c.field}: local=${formatValue(c.local)} remote=${formatValue(c.remote)}`,
              );
            }
            break;
          case "kept-local":
            console.warn(
              `  ⚠ ${d.id}: ${d.title} (locally modified but changed remotely — keeping local)`,
            );
            break;
        }
      }
    }

    console.log(
      `Pull summary: +${result.added} ~${result.updated} !${result.conflicts} -${result.removed}`,
    );

    if (opts.dryRun) {
      console.log("Dry run — no changes applied.");
      return;
    }

    await tasksStore.write(newTasksFile);
    await stateStore.write(newSyncState);

    if (result.hasConflicts) {
      console.warn(
        `\n${result.conflicts} task(s) have conflicts. Run 'gh-gantt resolve' to resolve them.`,
      );
    }

    console.log("Pull complete.");

    await fetchAndSaveComments(gql, newTasksFile.tasks, projectRoot, opts);
  });

async function fetchAndSaveComments(
  gql: Awaited<ReturnType<typeof createGraphQLClient>>,
  tasks: import("@gh-gantt/shared").Task[],
  projectRoot: string,
  opts: { withComments?: boolean; forceComments?: boolean },
): Promise<void> {
  if (!opts.withComments && !opts.forceComments) return;

  try {
    const commentsStore = new CommentsStore(projectRoot);
    const commentsFile = await commentsStore.read();

    const commentItems = tasks
      .filter(
        (t) => t.github_issue !== null && !isDraftTask(t.id) && !isMilestoneSyntheticTask(t.id),
      )
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
    const taskIds = new Set(tasks.map((t) => t.id));
    for (const key of Object.keys(updatedComments.fetched_at)) {
      if (!taskIds.has(key)) {
        delete updatedComments.fetched_at[key];
        delete updatedComments.comments[key];
      }
    }

    await commentsStore.write(updatedComments);
  } catch (err) {
    console.warn(
      `Warning: failed to fetch comments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
