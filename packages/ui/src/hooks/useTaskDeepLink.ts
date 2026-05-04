import { useEffect, useState } from "react";
import type { Task } from "../types/index.js";

export const SELECTED_TASK_QUERY_KEY = "task";

function readSelectedTaskIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(SELECTED_TASK_QUERY_KEY);
}

function writeSelectedTaskIdToUrl(taskId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (taskId) {
    url.searchParams.set(SELECTED_TASK_QUERY_KEY, taskId);
  } else {
    url.searchParams.delete(SELECTED_TASK_QUERY_KEY);
  }
  window.history.replaceState({}, "", url.toString());
}

export function useTaskDeepLink(tasks: Task[], options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(readSelectedTaskIdFromUrl);

  useEffect(() => {
    if (!enabled || !selectedTaskId) return;
    if (tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(null);
  }, [enabled, selectedTaskId, tasks]);

  useEffect(() => {
    if (!enabled) return;
    writeSelectedTaskIdToUrl(selectedTaskId);
  }, [enabled, selectedTaskId]);

  return { selectedTaskId, setSelectedTaskId } as const;
}
