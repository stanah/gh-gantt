import { Command } from "commander";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { buildDraftTaskId, getNextDraftNumber } from "../github/issues.js";
import { ACCEPTANCE_CRITERIA_END_MARKER, ACCEPTANCE_CRITERIA_START_MARKER } from "@gh-gantt/shared";
import type { Task, TaskTemplates } from "@gh-gantt/shared";

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

export interface TaskTemplateValues {
  title: string;
  type: string;
  body: string | null;
}

export type TaskTemplatePathResolution =
  | { ok: true; templatePath: string; templateRoot: string; projectRoot: string }
  | { ok: false; message: string };

function isPathInside(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveTaskTemplatePath(
  projectRoot: string,
  taskTemplates: TaskTemplates | undefined,
  templateName: string,
): TaskTemplatePathResolution {
  const trimmedName = templateName.trim();
  if (trimmedName.length === 0) {
    return { ok: false, message: "Template name is required." };
  }
  if (!taskTemplates) {
    return { ok: false, message: "task_templates is not configured." };
  }

  const resolvedProjectRoot = resolve(projectRoot);
  const templateRoot = resolve(resolvedProjectRoot, taskTemplates.path);
  if (!isPathInside(resolvedProjectRoot, templateRoot)) {
    return { ok: false, message: "task_templates.path must stay within the project root." };
  }

  const templateFile = taskTemplates.mapping?.[trimmedName] ?? `${trimmedName}.md`;
  if (isAbsolute(templateFile)) {
    return { ok: false, message: "task_templates.mapping must use relative paths." };
  }

  const templatePath = resolve(templateRoot, templateFile);
  if (!isPathInside(templateRoot, templatePath)) {
    return { ok: false, message: "Template path must stay within task_templates.path." };
  }

  return { ok: true, templatePath, templateRoot, projectRoot: resolvedProjectRoot };
}

export async function resolveExistingTaskTemplatePath(
  projectRoot: string,
  taskTemplates: TaskTemplates | undefined,
  templateName: string,
): Promise<TaskTemplatePathResolution> {
  const resolved = resolveTaskTemplatePath(projectRoot, taskTemplates, templateName);
  if (!resolved.ok) {
    return resolved;
  }

  let realProjectRoot: string;
  let realTemplateRoot: string;
  let realTemplatePath: string;
  try {
    [realProjectRoot, realTemplateRoot, realTemplatePath] = await Promise.all([
      realpath(resolved.projectRoot),
      realpath(resolved.templateRoot),
      realpath(resolved.templatePath),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Failed to resolve template path: ${message}` };
  }

  if (!isPathInside(realProjectRoot, realTemplateRoot)) {
    return { ok: false, message: "task_templates.path must stay within the project root." };
  }
  if (!isPathInside(realTemplateRoot, realTemplatePath)) {
    return { ok: false, message: "Template path must stay within task_templates.path." };
  }

  return resolved;
}

export function renderTaskTemplate(template: string, values: TaskTemplateValues): string {
  const acceptanceCriteriaSlot = [
    ACCEPTANCE_CRITERIA_START_MARKER,
    "## 受入基準",
    "",
    ACCEPTANCE_CRITERIA_END_MARKER,
  ].join("\n");

  return template
    .replaceAll("{{title}}", values.title)
    .replaceAll("{{type}}", values.type)
    .replaceAll("{{body}}", values.body ?? "")
    .replaceAll("{{acceptance_criteria}}", acceptanceCriteriaSlot);
}

export function createCreateCommand(): Command {
  return new Command("create")
    .description("Create a new draft task locally")
    .option("--title <title>", "Task title")
    .option("--type <type>", "Task type (e.g., task, epic, bug)")
    .option("--body <body>", "Task body/description")
    .option("--template <name>", "Task body template name")
    .option("--start-date <date>", "Start date (YYYY-MM-DD)")
    .option("--end-date <date>", "End date (YYYY-MM-DD)")
    .option("--parent <id>", "Parent task ID")
    .option("--require-review", "Require reviewer approval before close")
    .option("--json", "Output as JSON")
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
              process.exitCode = 1;
              return;
            }
          }

          if (!type) {
            console.log(`Available types: ${typeKeys.join(", ")}`);
            type = await prompt(rl, "Type", "task");
          }

          if (body === null && !opts.body && !opts.template) {
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
        process.exitCode = 1;
        return;
      }

      if (opts.template) {
        const resolution = await resolveExistingTaskTemplatePath(
          projectRoot,
          config.task_templates,
          opts.template,
        );
        if (!resolution.ok) {
          console.error(resolution.message);
          process.exitCode = 1;
          return;
        }

        let template: string;
        try {
          template = await readFile(resolution.templatePath, "utf-8");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Failed to read template "${opts.template}": ${message}`);
          process.exitCode = 1;
          return;
        }

        body = renderTaskTemplate(template, { title, type, body });
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
        acceptance_criteria: [],
        acceptance_criteria_slot: body?.includes(ACCEPTANCE_CRITERIA_START_MARKER) === true,
        implementer: null,
        reviewer: null,
        require_review: opts.requireReview === true,
        review_approved_by: null,
        review_approved_at: null,
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

      if (opts.json) {
        console.log(JSON.stringify({ task }, null, 2));
      } else {
        console.log(`Created draft task: ${taskId}`);
        console.log(`  Title: ${title}`);
        console.log(`  Type: ${type}`);
        if (startDate) console.log(`  Start: ${startDate}`);
        if (endDate) console.log(`  End: ${endDate}`);
        if (parent) console.log(`  Parent: ${parent}`);
        console.log();
        console.log('Run "gh-gantt push" to create the GitHub issue.');
      }
    });
}

export const createCommand = createCreateCommand();
