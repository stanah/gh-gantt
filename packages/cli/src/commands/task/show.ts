import { Command } from "commander";
import { withProjectStorage } from "../../store/project-storage.js";
import { resolveTaskId } from "../../util/task-id.js";
import { isMilestoneSyntheticTask } from "../../github/issues.js";
import {
  normalizeAcceptanceCriteria,
  parseAcceptanceCriteriaBody,
  parseTaskRolesBody,
} from "@gh-gantt/shared";
import type { Comment, CommentsFile, Task } from "@gh-gantt/shared";

/**
 * show が表示対象 task について解決したコメント情報。
 * `fetched_at` が null のときは `pull --with-comments` 未実行でコメント未取得を表す。
 */
export interface TaskComments {
  fetched_at: string | null;
  comments: Comment[] | null;
}

const NOT_FETCHED_MESSAGE = "not fetched. Run `gh-gantt pull --with-comments` to fetch";

/** commentsStore の内容から task のコメントを作成日時の昇順で取り出す。 */
export function resolveTaskComments(task: Task, commentsFile: CommentsFile): TaskComments {
  const fetchedAt = commentsFile.fetched_at[task.id];
  if (!fetchedAt) {
    return { fetched_at: null, comments: null };
  }
  const comments = [...(commentsFile.comments[task.id] ?? [])].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  return { fetched_at: fetchedAt, comments };
}

/** --json 出力: task のフィールドを維持したまま comments / comments_fetched_at を追加する。 */
export function buildShowJson(
  task: Task,
  taskComments: TaskComments,
): Task & { comments: Comment[] | null; comments_fetched_at: string | null } {
  return {
    ...task,
    comments: taskComments.comments,
    comments_fetched_at: taskComments.fetched_at,
  };
}

function formatComments(taskComments: TaskComments): string[] {
  if (taskComments.comments === null) {
    return [`Comments:   ${NOT_FETCHED_MESSAGE}`];
  }
  const lines = [
    "",
    `--- Comments (${taskComments.comments.length}) ---`,
    `(fetched at ${taskComments.fetched_at})`,
  ];
  taskComments.comments.forEach((comment, index) => {
    const edited =
      comment.updated_at !== comment.created_at ? ` (edited ${comment.updated_at})` : "";
    lines.push(
      "",
      `[${index + 1}] ${comment.author}  ${comment.created_at}${edited}`,
      comment.body,
    );
  });
  return lines;
}

export function formatTask(task: Task, taskComments?: TaskComments): string {
  if (isMilestoneSyntheticTask(task.id)) {
    return formatMilestone(task);
  }
  const parsedRoles = parseTaskRolesBody(task.body);
  const parsedBody = parseAcceptanceCriteriaBody(parsedRoles.body);
  const implementer = task.implementer ?? parsedRoles.implementer;
  const reviewer = task.reviewer ?? parsedRoles.reviewer;
  const storedAcceptanceCriteria = normalizeAcceptanceCriteria(task.acceptance_criteria);
  const acceptanceCriteria =
    storedAcceptanceCriteria.length > 0 ? storedAcceptanceCriteria : parsedBody.acceptance_criteria;
  const lines: string[] = [
    `ID:         ${task.id}`,
    `Title:      ${task.title}`,
    `Type:       ${task.type}`,
    `State:      ${task.state}`,
    `Assignees:  ${task.assignees.length > 0 ? task.assignees.join(", ") : "-"}`,
    `Implementer:${implementer ? ` ${implementer}` : " -"}`,
    `Reviewer:   ${reviewer ? reviewer : "-"}`,
    `Review required: ${task.require_review === true ? "yes" : "no"}`,
    `Review approved: ${task.review_approved_by ? `${task.review_approved_by} (${task.review_approved_at ?? "-"})` : "-"}`,
    `Labels:     ${task.labels.length > 0 ? task.labels.join(", ") : "-"}`,
    `Milestone:  ${task.milestone ?? "-"}`,
    `Start:      ${task.start_date ?? "-"}`,
    `End:        ${task.end_date ?? "-"}`,
    `Date:       ${task.date ?? "-"}`,
    `Parent:     ${task.parent ?? "-"}`,
    `Sub-tasks:  ${task.sub_tasks.length > 0 ? task.sub_tasks.join(", ") : "-"}`,
    `Blocked by: ${task.blocked_by.length > 0 ? task.blocked_by.map((d) => d.task).join(", ") : "-"}`,
    `Acceptance Criteria:`,
    ...(acceptanceCriteria.length > 0
      ? acceptanceCriteria.map((criterion, index) => {
          const marker = criterion.checked ? "x" : " ";
          return `  ${index + 1}. [${marker}] ${criterion.description}`;
        })
      : ["  -"]),
    `Created:    ${task.created_at}`,
    `Updated:    ${task.updated_at}`,
  ];
  if (parsedBody.body) {
    lines.push("", "--- Body ---", parsedBody.body);
  }
  if (taskComments) {
    lines.push(...formatComments(taskComments));
  }
  return lines.join("\n");
}

function formatMilestone(task: Task): string {
  const lines: string[] = [
    `ID:         ${task.id}`,
    `Title:      ${task.title}`,
    `Type:       milestone`,
    `State:      ${task.state}`,
    `Due Date:   ${task.date ?? "-"}`,
  ];
  if (task.body) {
    lines.push("", "--- Description ---", task.body);
  }
  return lines.join("\n");
}

export function createTaskShowCommand(): Command {
  return new Command("show")
    .description("Show task details")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts) => {
      try {
        const projectRoot = process.cwd();
        await withProjectStorage(
          projectRoot,
          { mode: "read", scope: "shared-cache" },
          async ({ configStore, tasksStore, commentsStore }) => {
            const config = await configStore.read();
            const tasksFile = await tasksStore.read();

            const resolvedId = resolveTaskId(id, config);
            const task = tasksFile.tasks.find((t) => t.id === resolvedId);

            if (!task) {
              console.error(`Task not found: ${resolvedId}`);
              process.exitCode = 1;
              return;
            }

            // milestone の synthetic task は Issue ではないためコメントを持たない
            const taskComments = isMilestoneSyntheticTask(task.id)
              ? undefined
              : resolveTaskComments(task, await commentsStore.read());

            if (opts.json) {
              console.log(
                JSON.stringify(taskComments ? buildShowJson(task, taskComments) : task, null, 2),
              );
            } else {
              console.log(formatTask(task, taskComments));
            }
          },
        );
      } catch (err) {
        console.error("Failed to show task:", err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

export const taskShowCommand = createTaskShowCommand();
