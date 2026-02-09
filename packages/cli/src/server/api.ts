import { Router, json } from "express";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { hashTask } from "../sync/hash.js";
import { computeLocalDiff } from "../sync/diff.js";
import { mapRemoteItemToTask, mergeRemoteIntoLocal } from "../sync/mapper.js";
import { createGraphQLClient } from "../github/client.js";
import { fetchProject } from "../github/projects.js";
import { fetchAllSubIssueLinks } from "../github/sub-issues.js";
import { applySubIssueLinks } from "../github/issues.js";
import { updateIssue, setIssueState, updateProjectItemField } from "../github/mutations.js";
import type { Task, StatusValue, SyncState } from "@gh-gantt/shared";

export function createApiRouter(projectRoot: string): Router {
  const router = Router();
  router.use(json());

  const configStore = new ConfigStore(projectRoot);
  const tasksStore = new TasksStore(projectRoot);
  const stateStore = new SyncStateStore(projectRoot);

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
      const tasksWithProgress = tasksFile.tasks.map((task) => ({
        ...task,
        _progress: computeProgress(
          task,
          tasksFile.tasks,
          config.statuses.values,
          config.statuses.field_name,
        ),
      }));
      res.json({ tasks: tasksWithProgress, cache: tasksFile.cache });
    } catch (err) {
      res.status(500).json({ error: "Failed to read tasks" });
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

      const updatedTask = { ...tasksFile.tasks[idx], ...updates };
      tasksFile.tasks[idx] = updatedTask;
      await tasksStore.write(tasksFile);

      res.json(updatedTask);
    } catch (err) {
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  // POST /api/sync/pull
  router.post("/api/sync/pull", async (_req, res) => {
    try {
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

      const issueItems = projectData.items
        .filter((i) => i.content)
        .map((i) => ({ number: i.content!.number, repository: i.content!.repository }));
      const subIssueLinks = await fetchAllSubIssueLinks(gql, issueItems);
      const remoteTaskArray = Array.from(remoteTasks.values());
      applySubIssueLinks(remoteTaskArray, subIssueLinks);
      for (const t of remoteTaskArray) remoteTasks.set(t.id, t);

      const localTaskMap = new Map(tasksFile.tasks.map((t) => [t.id, t]));
      const newTasks: Task[] = [];
      let added = 0, updated = 0, removed = 0;

      for (const [id, remoteTask] of remoteTasks) {
        const localTask = localTaskMap.get(id);
        if (!localTask) {
          newTasks.push(remoteTask);
          added++;
        } else {
          const remoteHash = hashTask(remoteTask);
          const snapshotHash = syncState.snapshots[id]?.hash;
          if (remoteHash !== snapshotHash) {
            newTasks.push(mergeRemoteIntoLocal(localTask, remoteTask));
            updated++;
          } else {
            newTasks.push(localTask);
          }
          localTaskMap.delete(id);
        }
      }
      removed = localTaskMap.size;

      const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };
      for (const task of newTasks) {
        newSnapshots[task.id] = { hash: hashTask(task), synced_at: new Date().toISOString() };
      }
      for (const id of localTaskMap.keys()) delete newSnapshots[id];

      await tasksStore.write({ tasks: newTasks, cache: tasksFile.cache });
      await stateStore.write({ ...syncState, last_synced_at: new Date().toISOString(), snapshots: newSnapshots });

      res.json({ added, updated, removed });
    } catch (err) {
      res.status(500).json({ error: "Pull failed: " + (err instanceof Error ? err.message : String(err)) });
    }
  });

  // POST /api/sync/push
  router.post("/api/sync/push", async (_req, res) => {
    try {
      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();

      const diffs = computeLocalDiff(tasksFile.tasks, syncState);
      if (diffs.length === 0) {
        res.json({ pushed: 0, message: "No local changes to push" });
        return;
      }

      const gql = await createGraphQLClient();
      const fm = config.sync.field_mapping;
      let pushed = 0;

      for (const diff of diffs) {
        if (diff.type === "deleted") continue;
        const task = diff.task;
        const idEntry = syncState.id_map[task.id];
        if (!idEntry) continue;

        if (idEntry.issue_node_id) {
          await updateIssue(gql, idEntry.issue_node_id, { title: task.title, body: task.body ?? undefined });
          if (syncState.snapshots[task.id]) {
            await setIssueState(gql, idEntry.issue_node_id, task.state);
          }
        }

        if (task.start_date && syncState.field_ids[fm.start_date]) {
          await updateProjectItemField(gql, syncState.project_node_id, idEntry.project_item_id, syncState.field_ids[fm.start_date], { date: task.start_date });
        }
        if (task.end_date && syncState.field_ids[fm.end_date]) {
          await updateProjectItemField(gql, syncState.project_node_id, idEntry.project_item_id, syncState.field_ids[fm.end_date], { date: task.end_date });
        }
        pushed++;
      }

      const newSnapshots: SyncState["snapshots"] = { ...syncState.snapshots };
      for (const task of tasksFile.tasks) {
        newSnapshots[task.id] = { hash: hashTask(task), synced_at: new Date().toISOString() };
      }
      await stateStore.write({ ...syncState, last_synced_at: new Date().toISOString(), snapshots: newSnapshots });

      res.json({ pushed, total_diffs: diffs.length });
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
