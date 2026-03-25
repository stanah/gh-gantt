import { useState, useMemo, useCallback, useEffect } from "react";
import type { Task } from "../types/index.js";

export const UNASSIGNED = "__unassigned__";
export const NO_PRIORITY = "__no_priority__";
export const NO_LABEL = "__no_label__";
const ASSIGNEES_QUERY_KEY = "assignees";
const PRIORITIES_QUERY_KEY = "priorities";
const LABELS_QUERY_KEY = "labels";

export interface TaskFilterState {
  hideClosed: boolean;
  selectedAssignee: string | null;
  searchQuery: string;
  selectedPriorities: string[];
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

function parsePrioritiesFromQuery(search: string): string[] {
  const params = new URLSearchParams(search);
  const raw = params.get(PRIORITIES_QUERY_KEY);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
}

function parseLabelsFromQuery(search: string): string[] {
  const params = new URLSearchParams(search);
  return params.getAll(LABELS_QUERY_KEY).filter((v) => v.length > 0);
}

export function useTaskFilter(tasks: Task[]) {
  const [hideClosed, setHideClosed] = useState(true);
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return parseAssigneesFromQuery(window.location.search);
  });
  const [selectedPriorities, setSelectedPriorities] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return parsePrioritiesFromQuery(window.location.search);
  });
  const [selectedLabels, setSelectedLabels] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return parseLabelsFromQuery(window.location.search);
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

  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      for (const l of t.labels) {
        set.add(l);
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
    if (selectedPriorities.length === 0) {
      url.searchParams.delete(PRIORITIES_QUERY_KEY);
    } else {
      url.searchParams.set(PRIORITIES_QUERY_KEY, selectedPriorities.join(","));
    }
    url.searchParams.delete(LABELS_QUERY_KEY);
    for (const label of selectedLabels) {
      url.searchParams.append(LABELS_QUERY_KEY, label);
    }
    window.history.replaceState({}, "", url.toString());
  }, [selectedAssignees, selectedPriorities, selectedLabels]);

  return {
    hideClosed,
    toggleHideClosed,
    selectedAssignee,
    setSelectedAssignee,
    selectedAssignees,
    setSelectedAssignees,
    allAssignees,
    selectedPriorities,
    setSelectedPriorities,
    allLabels,
    selectedLabels,
    setSelectedLabels,
    searchQuery,
    setSearchQuery,
  };
}
