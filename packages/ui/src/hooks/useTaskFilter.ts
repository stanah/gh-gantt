import { useState, useMemo, useCallback } from "react";
import type { Task } from "../types/index.js";

export const UNASSIGNED = "__unassigned__";

export interface TaskFilterState {
  hideClosed: boolean;
  selectedAssignee: string | null;
}

export function useTaskFilter(tasks: Task[]) {
  const [hideClosed, setHideClosed] = useState(true);
  const [selectedAssignee, setSelectedAssignee] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const toggleHideClosed = useCallback(() => {
    setHideClosed((prev) => !prev);
  }, []);

  const allAssignees = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      for (const a of t.assignees) {
        set.add(a);
      }
    }
    return [...set].sort();
  }, [tasks]);

  return {
    hideClosed,
    toggleHideClosed,
    selectedAssignee,
    setSelectedAssignee,
    allAssignees,
    searchQuery,
    setSearchQuery,
  };
}
