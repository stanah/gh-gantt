import { Command } from "commander";
import type { SyncState, Task, TasksFile } from "@gh-gantt/shared";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { resolveTaskId } from "../util/task-id.js";
import { createGraphQLClient } from "../github/client.js";
import { executePull } from "../sync/pull-executor.js";

export interface TaskDeletionRepair {
  parentCleared: string[];
  subTaskRemoved: string[];
  blockedByRemoved: string[];
}

export type TaskDeletionPlan =
  | {
      ok: true;
      taskId: string;
      task: Task;
      issueNumber: number;
      issueNodeId: string;
      owner: string;
      repo: string;
      repair: TaskDeletionRepair;
    }
  | { ok: false; error: string };

export interface DeleteGithubIssueInput {
  owner: string;
  repo: string;
  issueNumber: number;
  issueNodeId: string;
}

export interface ForcePullInput {
  tasksFile: TasksFile;
  syncState: SyncState;
}

export interface TaskDeletionInput {
  tasksFile: TasksFile;
  syncState: SyncState;
  taskId: string;
  yes: boolean;
  now?: string;
  deleteGithubIssue: (input: DeleteGithubIssueInput) => Promise<void>;
  forcePull: (input: ForcePullInput) => Promise<{ tasksFile: TasksFile; syncState: SyncState }>;
}

export type TaskDeletionResult =
  | {
      ok: true;
      taskId: string;
      issueNumber: number;
      repair: TaskDeletionRepair;
      tasksFile: TasksFile;
      syncState: SyncState;
    }
  | { ok: false; error: string };

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseGithubRepo(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) return null;
  return { owner, repo };
}

export async function deleteGithubIssueWithGraphQL(input: DeleteGithubIssueInput): Promise<void> {
  const gql = await createGraphQLClient();
  await gql<{ deleteIssue: { clientMutationId: string | null } }>(
    `mutation DeleteIssue($issueId: ID!) {
      deleteIssue(input: { issueId: $issueId }) {
        clientMutationId
      }
    }`,
    { issueId: input.issueNodeId },
  );
}

export function planTaskDeletion(
  tasksFile: TasksFile,
  syncState: SyncState,
  taskId: string,
): TaskDeletionPlan {
  if (tasksFile.has_conflicts) {
    return { ok: false, error: "未解決のコンフリクトがあります。先に resolve してください" };
  }

  const task = tasksFile.tasks.find((t) => t.id === taskId);
  if (!task) {
    return { ok: false, error: `Task not found: ${taskId}` };
  }

  if (task.id.startsWith("milestone:")) {
    return {
      ok: false,
      error: "milestone task は delete できません。GitHub Issue の task を指定してください",
    };
  }

  if (task.id.includes("#draft-")) {
    return {
      ok: false,
      error: "draft task は delete できません。push 前の draft は discard を使ってください",
    };
  }

  if (task.github_issue === null) {
    return {
      ok: false,
      error: "GitHub Issue のない task は delete できません",
    };
  }

  const repo = parseGithubRepo(task.github_repo);
  if (!repo) {
    return { ok: false, error: `GitHub repository が不正です: ${task.github_repo}` };
  }

  const issueNodeId = syncState.id_map[taskId]?.issue_node_id;
  if (!issueNodeId) {
    return {
      ok: false,
      error: `sync-state に issue_node_id がありません: ${taskId}`,
    };
  }

  const repair: TaskDeletionRepair = {
    parentCleared: [],
    subTaskRemoved: [],
    blockedByRemoved: [],
  };

  for (const other of tasksFile.tasks) {
    if (other.id === taskId) continue;
    if (other.parent === taskId) {
      repair.parentCleared.push(other.id);
    }
    if (other.sub_tasks.includes(taskId)) {
      repair.subTaskRemoved.push(other.id);
    }
    if (other.blocked_by.some((dep) => dep.task === taskId)) {
      repair.blockedByRemoved.push(other.id);
    }
  }

  return {
    ok: true,
    taskId,
    task,
    issueNumber: task.github_issue,
    issueNodeId,
    owner: repo.owner,
    repo: repo.repo,
    repair,
  };
}

export function applyTaskDeletion(
  tasksFile: TasksFile,
  syncState: SyncState,
  plan: Extract<TaskDeletionPlan, { ok: true }>,
  now = new Date().toISOString(),
): { tasksFile: TasksFile; syncState: SyncState } {
  const nextTasks = tasksFile.tasks
    .filter((task) => task.id !== plan.taskId)
    .map((task) => {
      const parent = task.parent === plan.taskId ? null : task.parent;
      const sub_tasks = task.sub_tasks.filter((id) => id !== plan.taskId);
      const blocked_by = task.blocked_by.filter((dep) => dep.task !== plan.taskId);
      const changed =
        parent !== task.parent ||
        sub_tasks.length !== task.sub_tasks.length ||
        blocked_by.length !== task.blocked_by.length;

      if (!changed) return task;
      return { ...task, parent, sub_tasks, blocked_by, updated_at: now };
    });

  const nextIdMap = { ...syncState.id_map };
  delete nextIdMap[plan.taskId];
  const nextSnapshots = { ...syncState.snapshots };
  delete nextSnapshots[plan.taskId];

  return {
    tasksFile: { ...tasksFile, tasks: nextTasks },
    syncState: { ...syncState, id_map: nextIdMap, snapshots: nextSnapshots },
  };
}

export async function executeTaskDeletion(input: TaskDeletionInput): Promise<TaskDeletionResult> {
  if (!input.yes) {
    return { ok: false, error: "GitHub Issue を削除するには --yes を指定してください" };
  }

  const plan = planTaskDeletion(input.tasksFile, input.syncState, input.taskId);
  if (!plan.ok) return plan;

  try {
    await input.deleteGithubIssue({
      owner: plan.owner,
      repo: plan.repo,
      issueNumber: plan.issueNumber,
      issueNodeId: plan.issueNodeId,
    });
  } catch (err) {
    return { ok: false, error: `GitHub Issue の削除に失敗しました: ${formatError(err)}` };
  }

  const cleaned = applyTaskDeletion(input.tasksFile, input.syncState, plan, input.now);

  let pulled: { tasksFile: TasksFile; syncState: SyncState };
  try {
    pulled = await input.forcePull(cleaned);
  } catch (err) {
    return { ok: false, error: `削除後の再同期に失敗しました: ${formatError(err)}` };
  }

  if (pulled.tasksFile.tasks.some((task) => task.id === plan.taskId)) {
    return { ok: false, error: `削除後の再同期で対象 task が再出現しました: ${plan.taskId}` };
  }
  if (pulled.syncState.id_map[plan.taskId] || pulled.syncState.snapshots[plan.taskId]) {
    return {
      ok: false,
      error: `削除後の再同期で sync-state に対象 task が残っています: ${plan.taskId}`,
    };
  }
  const danglingReferences = findReferences(pulled.tasksFile.tasks, plan.taskId);
  if (danglingReferences.length > 0) {
    return {
      ok: false,
      error: `削除後の再同期で対象 task への参照が残っています: ${danglingReferences.join(", ")}`,
    };
  }

  return {
    ok: true,
    taskId: plan.taskId,
    issueNumber: plan.issueNumber,
    repair: plan.repair,
    tasksFile: pulled.tasksFile,
    syncState: pulled.syncState,
  };
}

function findReferences(tasks: Task[], taskId: string): string[] {
  const refs: string[] = [];
  for (const task of tasks) {
    if (task.parent === taskId) refs.push(`${task.id}.parent`);
    if (task.sub_tasks.includes(taskId)) refs.push(`${task.id}.sub_tasks`);
    if (task.blocked_by.some((dep) => dep.task === taskId)) refs.push(`${task.id}.blocked_by`);
  }
  return refs;
}

export function createDeleteCommand(): Command {
  return new Command("delete")
    .description("Delete a GitHub Issue task and reconcile the local mirror")
    .argument("<id>", "Task ID (e.g. 6, #6, owner/repo#6)")
    .option("--yes", "Confirm GitHub Issue deletion without prompting")
    .option("--json", "Output deletion result as JSON")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      const projectRoot = process.cwd();
      const configStore = new ConfigStore(projectRoot);
      const tasksStore = new TasksStore(projectRoot);
      const stateStore = new SyncStateStore(projectRoot);

      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();
      const taskId = resolveTaskId(id, config);
      const result = await executeTaskDeletion({
        tasksFile,
        syncState,
        taskId,
        yes: opts.yes === true,
        deleteGithubIssue: deleteGithubIssueWithGraphQL,
        forcePull: async ({ tasksFile: cleanedTasksFile, syncState: cleanedSyncState }) => {
          const gql = await createGraphQLClient();
          const pulled = await executePull(gql, config, cleanedTasksFile, cleanedSyncState, {
            force: true,
            fullFetch: true,
          });
          return { tasksFile: pulled.tasksFile, syncState: pulled.syncState };
        },
      });

      if (!result.ok) {
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.error(result.error);
        }
        process.exitCode = 1;
        return;
      }

      await tasksStore.write(result.tasksFile);
      await stateStore.write(result.syncState);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              task_id: result.taskId,
              issue_number: result.issueNumber,
              repair: result.repair,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`Deleted GitHub Issue: #${result.issueNumber}`);
      console.log(`Removed task from mirror: ${result.taskId}`);
      console.log(
        `Repaired references: parent=${result.repair.parentCleared.length}, sub_tasks=${result.repair.subTaskRemoved.length}, blocked_by=${result.repair.blockedByRemoved.length}`,
      );
      console.log("Force pull verification complete.");
    });
}

export const deleteCommand = createDeleteCommand();
