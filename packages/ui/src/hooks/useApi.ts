import { useState, useEffect, useCallback } from "react";
import type { Config, TasksResponse, Task } from "../types/index.js";

export function useApi() {
  const [config, setConfig] = useState<Config | null>(null);
  const [tasksResponse, setTasksResponse] = useState<TasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [configRes, tasksRes] = await Promise.all([
        fetch("/api/config"),
        fetch("/api/tasks"),
      ]);

      if (!configRes.ok || !tasksRes.ok) {
        throw new Error("Failed to fetch data from API");
      }

      const configData = await configRes.json();
      const tasksData = await tasksRes.json();

      setConfig(configData);
      setTasksResponse(tasksData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const updateTask = useCallback(async (taskId: string, updates: Partial<Task>) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error("Failed to update task");
    const updated = await res.json();
    setTasksResponse((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, ...updated } : t)),
      };
    });
    return updated;
  }, []);

  return {
    config,
    tasks: tasksResponse?.tasks ?? [],
    cache: tasksResponse?.cache ?? { comments: {}, reactions: {} },
    loading,
    error,
    refresh: fetchData,
    updateTask,
  };
}
