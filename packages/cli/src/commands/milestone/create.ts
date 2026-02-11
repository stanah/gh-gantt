import { Command } from "commander";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import { buildDraftTaskId, getNextDraftNumber } from "../../github/issues.js";
import type { Task } from "@gh-gantt/shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const milestoneCreateCommand = new Command("create")
  .description("Create a local milestone")
  .argument("<title>", "Milestone title")
  .option("--due-date <date>", "Due date (YYYY-MM-DD)")
  .option("--description <text>", "Milestone description")
  .action(async (title: string, opts) => {
    try {
      const projectRoot = process.cwd();
      const configStore = new ConfigStore(projectRoot);
      const tasksStore = new TasksStore(projectRoot);

      const config = await configStore.read();
      const tasksFile = await tasksStore.read();

      if (opts.dueDate && !DATE_RE.test(opts.dueDate)) {
        console.error(`Invalid date format: "${opts.dueDate}". Use YYYY-MM-DD.`);
        process.exitCode = 1;
        return;
      }

      const { owner, repo } = config.project.github;
      const repoFullName = `${owner}/${repo}`;
      const draftNumber = getNextDraftNumber(tasksFile.tasks);
      const taskId = buildDraftTaskId(repoFullName, draftNumber);

      const now = new Date().toISOString();
      const task: Task = {
        id: taskId,
        type: "milestone",
        github_issue: null,
        github_repo: repoFullName,
        parent: null,
        sub_tasks: [],
        title,
        body: opts.description ?? null,
        state: "open",
        state_reason: null,
        assignees: [],
        labels: [],
        milestone: null,
        linked_prs: [],
        created_at: now,
        updated_at: now,
        closed_at: null,
        custom_fields: {},
        start_date: null,
        end_date: null,
        date: opts.dueDate ?? null,
        blocked_by: [],
      };

      tasksFile.tasks.push(task);
      await tasksStore.write(tasksFile);

      console.log(`Created milestone: ${taskId}`);
      console.log(`  Title: ${title}`);
      if (opts.dueDate) console.log(`  Due: ${opts.dueDate}`);
      if (opts.description) console.log(`  Description: ${opts.description}`);
    } catch (err) {
      console.error("Failed to create milestone:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
