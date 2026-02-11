import { Router, json } from "express";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { CommentsStore } from "../store/comments.js";
import { setParent, removeParent } from "../commands/task/link.js";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import { computeLocalDiff, formatDiffPreview } from "../sync/diff.js";
import { executePush } from "../sync/push-executor.js";
import { mapRemoteItemToTask, mergeRemoteIntoLocal } from "../sync/mapper.js";
import { detectConflicts } from "../sync/conflict.js";
import { createGraphQLClient } from "../github/client.js";
import { fetchProject, fetchRepositoryMetadata } from "../github/projects.js";
import { fetchAllIssueRelationshipLinks } from "../github/sub-issues.js";
import { applySubIssueLinks, applyBlockedByLinks, isDraftTask, isMilestoneSyntheticTask, buildDraftTaskId, getNextDraftNumber, milestoneToTask } from "../github/issues.js";
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
      const normalizedComments: Record<string, Array<{ author: string; body: string; created_at: string }>> = {};
      for (const [key, arr] of Object.entries(commentsFile.comments)) {
        normalizedComments[key] = arr.map((c) => ({ author: c.author, body: c.body, created_at: c.created_at }));
      }
      const mergedCache = {
        ...tasksFile.cache,
        comments: { ...(tasksFile.cache.comments ?? {}), ...normalizedComments },
      };
      const tasksWithProgress = tasksFile.tasks.map((task) => ({
        ...task,
        _progress: computeProgress(
          task,
          tasksFile.tasks,
          config.statuses.values,
          config.statuses.field_name,
        ),
      }));
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
      res.status(500).json({ error: "Failed to create task: " + (err instanceof Error ? err.message : String(err)) });
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

      const oldTask = tasksFile.tasks[idx];
      const updatedTask = { ...oldTask, ...updates };

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
        Object.assign(updatedTask, dateUpdates);
      }

      // Prevent start > end regardless of how dates were changed
      if (updatedTask.start_date && updatedTask.end_date && updatedTask.start_date > updatedTask.end_date) {
        res.status(400).json({ error: `start_date (${updatedTask.start_date}) must not be after end_date (${updatedTask.end_date})` });
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
        res.status(400).json({ error: "Task not found", code: "TASK_NOT_FOUND" });
        return;
      }

      if (newParentId === taskId) {
        res.status(400).json({ error: "Cannot set a task as its own parent", code: "SELF_REFERENCE" });
        return;
      }

      if (newParentId != null) {
        const parent = tasksFile.tasks.find((t) => t.id === newParentId);
        if (!parent) {
          res.status(400).json({ error: "Parent task not found", code: "TASK_NOT_FOUND" });
          return;
        }

        // Cycle detection: walk up from newParentId, check we don't reach taskId
        const taskMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));
        let current: string | null = newParentId;
        while (current) {
          if (current === taskId) {
            res.status(400).json({ error: "This operation would create a cycle", code: "CYCLE_DETECTED" });
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

        tasksFile.tasks = setParent(tasksFile.tasks, taskId, newParentId);
      } else {
        tasksFile.tasks = removeParent(tasksFile.tasks, taskId);
      }

      await tasksStore.write(tasksFile);

      const tasksWithProgress = tasksFile.tasks.map((t) => ({
        ...t,
        _progress: computeProgress(
          t,
          tasksFile.tasks,
          config.statuses.values,
          config.statuses.field_name,
        ),
      }));
      res.json({ tasks: tasksWithProgress });
    } catch (err) {
      res.status(500).json({ error: "Failed to reparent task: " + (err instanceof Error ? err.message : String(err)) });
    }
  });

  // POST /api/sync/pull
  router.post("/api/sync/pull", async (req, res) => {
    try {
      const { force } = req.body ?? {};
      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();

      const gql = await createGraphQLClient();
      const { owner, project_number } = config.project.github;
      const projectData = await fetchProject(gql, owner, project_number);

      const remoteTasks = new Map<string, Task>();
      for (const item of projectData.items) {
        const task = mapRemoteItemToTask(item, config);
        if (task) remoteTasks.set(task.id, task);
      }

      // Fetch native GitHub Milestones and inject synthetic tasks
      // (before early-return check so milestone changes are detected)
      const { owner: repoOwner, repo: repoName } = config.project.github;
      const repoFullName = `${repoOwner}/${repoName}`;
      const repoMetadata = await fetchRepositoryMetadata(gql, repoOwner, repoName);
      for (const m of repoMetadata.milestones) {
        if (!m.dueOn) continue;
        const syntheticTask = milestoneToTask(m, repoFullName);
        remoteTasks.set(syntheticTask.id, syntheticTask);
      }

      // Quick check: skip sub-issues fetch if no remote changes
      const localNonDraft = tasksFile.tasks.filter((t) => !isDraftTask(t.id));
      const localIds = new Set(localNonDraft.map((t) => t.id));
      const remoteIds = new Set(remoteTasks.keys());
      const sameIdSets = localIds.size === remoteIds.size && [...localIds].every((id) => remoteIds.has(id));
      if (sameIdSets) {
        let changed = false;
        for (const [id, remote] of remoteTasks) {
          const snap = syncState.snapshots[id];
          if (!snap?.updated_at) { changed = true; break; }
          if (remote.updated_at !== snap.updated_at) { changed = true; break; }
          if (isMilestoneSyntheticTask(id) && !snap.hash) { changed = true; break; }
        }
        if (!changed) {
          res.json({ added: 0, updated: 0, removed: 0 });
          return;
        }
      }

      const issueItems = projectData.items
        .filter((i) => i.content)
        .map((i) => ({ number: i.content!.number, repository: i.content!.repository }));
      const { subIssueLinks, blockedByLinks } = await fetchAllIssueRelationshipLinks(gql, issueItems);
      const remoteTaskArray = Array.from(remoteTasks.values());
      applySubIssueLinks(remoteTaskArray, subIssueLinks);
      applyBlockedByLinks(remoteTaskArray, blockedByLinks);
      for (const t of remoteTaskArray) remoteTasks.set(t.id, t);

      const remoteTaskArrayWithMilestones = Array.from(remoteTasks.values());
      const conflicts = detectConflicts(tasksFile.tasks, remoteTaskArrayWithMilestones, syncState);
      if (conflicts.length > 0 && !force) {
        res.status(409).json({
          conflicts: conflicts.map((c) => ({ taskId: c.taskId, title: c.title })),
          message: `${conflicts.length} task(s) have conflicting changes. Local and remote were both modified since last sync.`,
        });
        return;
      }

      const typeFieldConfigured = !!config.sync.field_mapping.type;
      const localTaskMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));
      const newTasks: Task[] = [];
      let added = 0, updated = 0, removed = 0;

      for (const [id, remoteTask] of remoteTasks) {
        const localTask = localTaskMap.get(id);
        if (!localTask) {
          newTasks.push(remoteTask);
          added++;
        } else {
          const currentRemoteHash = hashTask(remoteTask);
          const prevRemoteHash = syncState.snapshots[id]?.remoteHash ?? syncState.snapshots[id]?.hash;
          if (currentRemoteHash !== prevRemoteHash) {
            newTasks.push(mergeRemoteIntoLocal(localTask, remoteTask, { typeFieldConfigured }));
            updated++;
          } else {
            newTasks.push(localTask);
          }
          localTaskMap.delete(id);
        }
      }
      for (const [id, localTask] of localTaskMap) {
        if (isDraftTask(id)) {
          newTasks.push(localTask);
        } else {
          removed++;
        }
      }

      const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };
      for (const task of newTasks) {
        const remoteTask = remoteTasks.get(task.id);
        newSnapshots[task.id] = {
          hash: hashTask(task),
          synced_at: new Date().toISOString(),
          updated_at: task.updated_at,
          remoteHash: remoteTask ? hashTask(remoteTask) : undefined,
          syncFields: extractSyncFields(task),
        };
      }
      for (const id of localTaskMap.keys()) {
        if (!isDraftTask(id)) delete newSnapshots[id];
      }

      await tasksStore.write({ tasks: newTasks, cache: tasksFile.cache });
      await stateStore.write({ ...syncState, last_synced_at: new Date().toISOString(), snapshots: newSnapshots });

      res.json({ added, updated, removed });
    } catch (err) {
      res.status(500).json({ error: "Pull failed: " + (err instanceof Error ? err.message : String(err)) });
    }
  });

  // POST /api/sync/push
  router.post("/api/sync/push", async (req, res) => {
    try {
      const { dry_run } = req.body ?? {};
      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();

      const diffs = computeLocalDiff(tasksFile.tasks, syncState);
      if (diffs.length === 0) {
        if (dry_run) {
          res.json(formatDiffPreview([]));
          return;
        }
        res.json({ created: 0, updated: 0, skipped: 0, message: "No local changes to push" });
        return;
      }

      if (dry_run) {
        res.json(formatDiffPreview(diffs));
        return;
      }

      const config = await configStore.read();
      const gql = await createGraphQLClient();
      const { result, tasksFile: updatedTasksFile, syncState: updatedSyncState } =
        await executePush(gql, config, tasksFile, syncState);

      await tasksStore.write(updatedTasksFile);
      await stateStore.write(updatedSyncState);

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Push failed: " + (err instanceof Error ? err.message : String(err)) });
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
  allTasks: Task[],
  statusValues: Record<string, StatusValue>,
  statusFieldName: string,
): number {
  if (task.state === "closed") return 100;

  const statusName = task.custom_fields[statusFieldName] as string | undefined;
  if (statusName && statusValues[statusName]?.done) return 100;

  if (task.sub_tasks.length > 0) {
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    let total = 0;
    let done = 0;
    for (const childId of task.sub_tasks) {
      const child = taskMap.get(childId);
      if (child) {
        total++;
        done += computeProgress(child, allTasks, statusValues, statusFieldName) / 100;
      }
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }

  return 0;
}
