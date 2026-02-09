import { Router, json } from "express";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { hashTask } from "../sync/hash.js";
import type { Task, StatusValue } from "@gh-gantt/shared";

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
