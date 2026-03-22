import { useState, useMemo, useCallback, useEffect } from "react";
import type { Task } from "../types/index.js";

export const UNASSIGNED = "__unassigned__";
export const NO_PRIORITY = "__no_priority__";
const ASSIGNEES_QUERY_KEY = "assignees";

export interface TaskFilterState {
  hideClosed: boolean;
  selectedAssignee: string | null;
  searchQuery: string;
}

function parseAssigneesFromQuery(search: string): string[] {
  const params = new URLSearchParams(search);
  const raw = params.get(ASSIGNEES_QUERY_KEY);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function encodeAssignees(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.join(",");
}

export function useTaskFilter(tasks: Task[]) {
  const [hideClosed, setHideClosed] = useState(true);
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return parseAssigneesFromQuery(window.location.search);
  });
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

  const selectedAssignee = useMemo(() => encodeAssignees(selectedAssignees), [selectedAssignees]);

  const setSelectedAssignee = useCallback((value: string | null) => {
    if (!value) {
      setSelectedAssignees([]);
      return;
    }
    setSelectedAssignees(
      value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    );
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (selectedAssignees.length === 0) {
      url.searchParams.delete(ASSIGNEES_QUERY_KEY);
    } else {
      url.searchParams.set(ASSIGNEES_QUERY_KEY, selectedAssignees.join(","));
    }
    window.history.replaceState({}, "", url.toString());
  }, [selectedAssignees]);

  return {
    hideClosed,
    toggleHideClosed,
    selectedAssignee,
    setSelectedAssignee,
    selectedAssignees,
    setSelectedAssignees,
    allAssignees,
    searchQuery,
    setSearchQuery,
  };
}
