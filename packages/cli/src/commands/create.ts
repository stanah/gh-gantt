import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { buildDraftTaskId, getNextDraftNumber } from "../github/issues.js";
import type { Task } from "@gh-gantt/shared";

async function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

export const createCommand = new Command("create")
  .description("Create a new draft task locally")
  .option("--title <title>", "Task title")
  .option("--type <type>", "Task type (e.g., task, epic, bug)")
  .option("--body <body>", "Task body/description")
  .option("--start-date <date>", "Start date (YYYY-MM-DD)")
  .option("--end-date <date>", "End date (YYYY-MM-DD)")
  .option("--parent <id>", "Parent task ID")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);

    const config = await configStore.read();
    const tasksFile = await tasksStore.read();

    const typeKeys = Object.keys(config.task_types);
    const { owner, repo } = config.project.github;
    const repoFullName = `${owner}/${repo}`;

    let title = opts.title;
    let type = opts.type;
    let body = opts.body ?? null;
    let startDate = opts.startDate ?? null;
    let endDate = opts.endDate ?? null;
    let parent = opts.parent ?? null;

    // Interactive prompt for missing required fields
    if (!title || !type) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!title) {
          title = await prompt(rl, "Title");
          if (!title) {
            console.error("Title is required.");
            return;
          }
        }

        if (!type) {
          console.log(`Available types: ${typeKeys.join(", ")}`);
          type = await prompt(rl, "Type", "task");
        }

        if (body === null && !opts.body) {
          body = (await prompt(rl, "Body (optional)")) || null;
        }

        if (startDate === null && !opts.startDate) {
          startDate = (await prompt(rl, "Start date (YYYY-MM-DD, optional)")) || null;
        }

        if (endDate === null && !opts.endDate) {
          endDate = (await prompt(rl, "End date (YYYY-MM-DD, optional)")) || null;
        }

        if (parent === null && !opts.parent) {
          parent = (await prompt(rl, "Parent task ID (optional)")) || null;
        }
      } finally {
        rl.close();
      }
    }

    // Validate type
    if (!config.task_types[type]) {
      console.error(`Unknown task type: "${type}". Available: ${typeKeys.join(", ")}`);
      return;
    }

    // Build draft task
    const draftNumber = getNextDraftNumber(tasksFile.tasks);
    const taskId = buildDraftTaskId(repoFullName, draftNumber);

    const labels: string[] = [];
    const taskType = config.task_types[type];
    if (taskType.github_label) {
      labels.push(taskType.github_label);
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: taskId,
      type,
      github_issue: null,
      github_repo: repoFullName,
      parent,
      sub_tasks: [],
      title,
      body,
      state: "open",
      state_reason: null,
      assignees: [],
      labels,
      milestone: null,
      linked_prs: [],
      created_at: now,
      updated_at: now,
      closed_at: null,
      custom_fields: {},
      start_date: startDate,
      end_date: endDate,
      date: null,
      blocked_by: [],
    };

    // Update parent's sub_tasks if parent specified
    if (parent) {
      const parentTask = tasksFile.tasks.find((t) => t.id === parent);
      if (parentTask) {
        if (!parentTask.sub_tasks.includes(taskId)) {
          parentTask.sub_tasks.push(taskId);
        }
      } else {
        console.warn(`Warning: Parent task "${parent}" not found in tasks.`);
      }
    }

    tasksFile.tasks.push(task);
    await tasksStore.write(tasksFile);

    console.log(`Created draft task: ${taskId}`);
    console.log(`  Title: ${title}`);
    console.log(`  Type: ${type}`);
    if (startDate) console.log(`  Start: ${startDate}`);
    if (endDate) console.log(`  End: ${endDate}`);
    if (parent) console.log(`  Parent: ${parent}`);
    console.log();
    console.log('Run "gh-gantt push" to create the GitHub issue.');
  });
