import { Router, json } from "express";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { CommentsStore } from "../store/comments.js";
import { setParent, removeParent } from "../commands/task/link.js";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import { computeLocalDiff, formatDiffPreview } from "../sync/diff.js";
import { executePush } from "../sync/push-executor.js";
import { executePull } from "../sync/pull-executor.js";
import { createGraphQLClient } from "../github/client.js";
import {
  isDraftTask,
  isMilestoneSyntheticTask,
  buildDraftTaskId,
  getNextDraftNumber,
} from "../github/issues.js";
import type { Task, StatusValue, SyncState } from "@gh-gantt/shared";
import { computeStatusDateUpdates } from "@gh-gantt/shared";

export function createApiRouter(projectRoot: string): Router {
  const router = Router();
  router.use(json());

  const configStore = new ConfigStore(projectRoot);
  const tasksStore = new TasksStore(projectRoot);
  const stateStore = new SyncStateStore(projectRoot);
  const commentsStore = new CommentsStore(projectRoot);

  // GET /api/config
  router.get("/api/config", async (_req, res) => {
    try {
      const config = await configStore.read();
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: "Failed to read config" });
    }
  });

  // GET /api/tasks
  router.get("/api/tasks", async (_req, res) => {
    try {
      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const commentsFile = await commentsStore.read();
      const normalizedComments: Record<
        string,
        Array<{ author: string; body: string; created_at: string }>
      > = {};
      for (const [key, arr] of Object.entries(commentsFile.comments)) {
        normalizedComments[key] = arr.map((c) => ({
          author: c.author,
          body: c.body,
          created_at: c.created_at,
        }));
      }
      const mergedCache = {
        ...tasksFile.cache,
        comments: { ...tasksFile.cache.comments, ...normalizedComments },
      };
      const tasksWithProgress = attachProgress(
        tasksFile.tasks,
        config.statuses.values,
        config.statuses.field_name,
      );
      res.json({ tasks: tasksWithProgress, cache: mergedCache });
    } catch (err) {
      res.status(500).json({ error: "Failed to read tasks" });
    }
  });

  // POST /api/tasks — create a draft task
  router.post("/api/tasks", async (req, res) => {
    try {
      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const { title, type, body, start_date, end_date, parent } = req.body;

      if (!title || !type) {
        res.status(400).json({ error: "title and type are required" });
        return;
      }

      if (!config.task_types[type]) {
        res.status(400).json({ error: `Unknown task type: "${type}"` });
        return;
      }

      const { owner, repo } = config.project.github;
      const repoFullName = `${owner}/${repo}`;
      const draftNumber = getNextDraftNumber(tasksFile.tasks);
      const taskId = buildDraftTaskId(repoFullName, draftNumber);

      const labels: string[] = [];
      const taskType = config.task_types[type];
      if (taskType.github_label) labels.push(taskType.github_label);

      const now = new Date().toISOString();
      const task: Task = {
        id: taskId,
        type,
        github_issue: null,
        github_repo: repoFullName,
        parent: parent ?? null,
        sub_tasks: [],
        title,
        body: body ?? null,
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
        start_date: start_date ?? null,
        end_date: end_date ?? null,
        date: null,
        blocked_by: [],
      };

      if (parent) {
        const parentTask = tasksFile.tasks.find((t) => t.id === parent);
        if (parentTask && !parentTask.sub_tasks.includes(taskId)) {
          parentTask.sub_tasks.push(taskId);
        }
      }

      tasksFile.tasks.push(task);
      await tasksStore.write(tasksFile);

      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({
        error: "Failed to create task: " + (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // PATCH /api/tasks/:id
  router.patch("/api/tasks/:id", async (req, res) => {
    try {
      const taskId = decodeURIComponent(req.params.id);
      const updates = req.body;
      const tasksFile = await tasksStore.read();
      const idx = tasksFile.tasks.findIndex((t) => t.id === taskId);

      if (idx === -1) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const UPDATABLE_FIELDS = [
        "title",
        "body",
        "state",
        "state_reason",
        "assignees",
        "labels",
        "milestone",
        "custom_fields",
        "start_date",
        "end_date",
        "date",
        "parent",
        "sub_tasks",
        "blocked_by",
      ] as const;

      const oldTask = tasksFile.tasks[idx];
      const safeUpdates: Partial<Task> = {};
      for (const key of UPDATABLE_FIELDS) {
        if (key in updates) {
          (safeUpdates as Record<string, unknown>)[key] = updates[key];
        }
      }
      const updatedTask = { ...oldTask, ...safeUpdates };

      // Auto-update dates on status transition
      const config = await configStore.read();
      const statusField = config.statuses.field_name;
      const oldStatus = oldTask.custom_fields[statusField] as string | undefined;
      const newStatus = updatedTask.custom_fields[statusField] as string | undefined;
      if (newStatus && oldStatus !== newStatus) {
        const dateUpdates = computeStatusDateUpdates(oldStatus, newStatus, config.statuses.values, {
          start_date: updatedTask.start_date,
          end_date: updatedTask.end_date,
        });
        if (dateUpdates.start_date && !safeUpdates.start_date)
          updatedTask.start_date = dateUpdates.start_date;
        if (dateUpdates.end_date && !safeUpdates.end_date)
          updatedTask.end_date = dateUpdates.end_date;
      }

      // Prevent start > end regardless of how dates were changed
      if (
        updatedTask.start_date &&
        updatedTask.end_date &&
        updatedTask.start_date > updatedTask.end_date
      ) {
        res.status(400).json({
          error: `start_date (${updatedTask.start_date}) must not be after end_date (${updatedTask.end_date})`,
        });
        return;
      }

      tasksFile.tasks[idx] = updatedTask;
      await tasksStore.write(tasksFile);

      res.json(updatedTask);
    } catch (err) {
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  // POST /api/tasks/:id/reparent
  router.post("/api/tasks/:id/reparent", async (req, res) => {
    try {
      const taskId = decodeURIComponent(req.params.id);
      const { newParentId } = req.body;

      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const task = tasksFile.tasks.find((t) => t.id === taskId);

      if (!task) {
        res.status(404).json({ error: "Task not found", code: "TASK_NOT_FOUND" });
        return;
      }

      if (newParentId === taskId) {
        res
          .status(400)
          .json({ error: "Cannot set a task as its own parent", code: "SELF_REFERENCE" });
        return;
      }

      if (newParentId != null) {
        const parent = tasksFile.tasks.find((t) => t.id === newParentId);
        if (!parent) {
          res.status(404).json({ error: "Parent task not found", code: "TASK_NOT_FOUND" });
          return;
        }

        // Cycle detection: walk up from newParentId, check we don't reach taskId
        const taskMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));
        let current: string | null = newParentId;
        while (current) {
          if (current === taskId) {
            res
              .status(400)
              .json({ error: "This operation would create a cycle", code: "CYCLE_DETECTED" });
            return;
          }
          const t = taskMap.get(current);
          current = t?.parent ?? null;
        }

        // Type hierarchy validation
        const allowed = config.type_hierarchy[parent.type];
        if (allowed && allowed.length > 0 && !allowed.includes(task.type)) {
          res.status(400).json({
            error: `Cannot place "${task.type}" under "${parent.type}"`,
            code: "TYPE_HIERARCHY_VIOLATION",
          });
          return;
        }

        const parentResult = setParent(tasksFile.tasks, taskId, newParentId);
        if (parentResult.error) {
          res.status(400).json({ error: parentResult.error });
          return;
        }
        tasksFile.tasks = parentResult.tasks!;
      } else {
        tasksFile.tasks = removeParent(tasksFile.tasks, taskId);
      }

      await tasksStore.write(tasksFile);

      const tasksWithProgress = attachProgress(
        tasksFile.tasks,
        config.statuses.values,
        config.statuses.field_name,
      );
      res.json({ tasks: tasksWithProgress });
    } catch (err) {
      res.status(500).json({
        error: "Failed to reparent task: " + (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // POST /api/sync/pull
  router.post("/api/sync/pull", async (req, res) => {
    try {
      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();

      // Guard: Unresolved conflicts must be resolved before next pull
      if (tasksFile.has_conflicts) {
        res.status(409).json({
          message: "未解決のコンフリクトがあります。先に resolve してください",
        });
        return;
      }

      const gql = await createGraphQLClient();
      const {
        result,
        tasksFile: newTasksFile,
        syncState: newSyncState,
      } = await executePull(gql, config, tasksFile, syncState);

      if (result.skipped) {
        await stateStore.write(newSyncState);
        res.json({ added: 0, updated: 0, removed: 0, conflicts: 0 });
        return;
      }

      await tasksStore.write(newTasksFile);
      await stateStore.write(newSyncState);

      res.json({
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        conflicts: result.conflicts,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Pull failed: " + (err instanceof Error ? err.message : String(err)) });
    }
  });

  // POST /api/sync/push
  router.post("/api/sync/push", async (req, res) => {
    try {
      const { dry_run, force } = req.body ?? {};
      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();

      // Guard: unresolved conflicts (not skippable with force)
      if (tasksFile.has_conflicts) {
        res.status(409).json({
          message: "未解決のコンフリクトがあります。先に resolve してください",
        });
        return;
      }

      const diffs = computeLocalDiff(tasksFile.tasks, syncState);
      if (diffs.length === 0) {
        if (dry_run) {
          res.json(formatDiffPreview([]));
          return;
        }
        res.json({ created: 0, updated: 0, skipped: 0, message: "No local changes to push" });
        return;
      }

      const config = await configStore.read();

      if (dry_run) {
        res.json(formatDiffPreview(diffs, { autoCreateIssues: config.sync.auto_create_issues }));
        return;
      }
      const gql = await createGraphQLClient();
      const {
        result,
        tasksFile: updatedTasksFile,
        syncState: updatedSyncState,
      } = await executePush(gql, config, tasksFile, syncState, {
        force,
        saveProgress: async (tf, ss) => {
          await tasksStore.write(tf);
          await stateStore.write(ss);
        },
      });

      await tasksStore.write(updatedTasksFile);
      await stateStore.write(updatedSyncState);

      res.json(result);
    } catch (err) {
      res
        .status(500)
        .json({ error: "Push failed: " + (err instanceof Error ? err.message : String(err)) });
    }
  });

  // GET /api/sync/status
  router.get("/api/sync/status", async (_req, res) => {
    try {
      const syncState = await stateStore.read();
      const tasksFile = await tasksStore.read();
      const localChanges = tasksFile.tasks.filter((task) => {
        const snapshot = syncState.snapshots[task.id];
        return !snapshot || hashTask(task) !== snapshot.hash;
      });
      res.json({
        last_synced_at: syncState.last_synced_at,
        local_changes: localChanges.length,
        total_tasks: tasksFile.tasks.length,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to get sync status" });
    }
  });

  return router;
}

function computeProgress(
  task: Task,
  taskMap: Map<string, Task>,
  statusValues: Record<string, StatusValue>,
  statusFieldName: string,
  visited: Set<string> = new Set(),
): number {
  if (task.state === "closed") return 100;

  const statusName = task.custom_fields[statusFieldName] as string | undefined;
  if (statusName && statusValues[statusName]?.done) return 100;

  if (task.sub_tasks.length > 0) {
    visited.add(task.id);
    let total = 0;
    let done = 0;
    for (const childId of task.sub_tasks) {
      if (visited.has(childId)) continue;
      const child = taskMap.get(childId);
      if (child) {
        total++;
        visited.add(childId);
        done += computeProgress(child, taskMap, statusValues, statusFieldName, visited) / 100;
      }
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }

  return 0;
}

function attachProgress(
  tasks: Task[],
  statusValues: Record<string, StatusValue>,
  statusFieldName: string,
): Array<Task & { _progress: number }> {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => ({
    ...task,
    _progress: computeProgress(task, taskMap, statusValues, statusFieldName),
  }));
}
