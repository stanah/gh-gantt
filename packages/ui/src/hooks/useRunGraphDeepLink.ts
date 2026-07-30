import { useCallback, useEffect, useState } from "react";

export const SELECTED_RUN_QUERY_KEY = "run";
export const SELECTED_RUN_NODE_QUERY_KEY = "node";

function readSelection(): { runId: string | null; nodeId: string | null } {
  if (typeof window === "undefined") return { runId: null, nodeId: null };
  const params = new URL(window.location.href).searchParams;
  return {
    runId: params.get(SELECTED_RUN_QUERY_KEY),
    nodeId: params.get(SELECTED_RUN_NODE_QUERY_KEY),
  };
}

function updateUrl(runId: string | null, nodeId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (runId) {
    url.searchParams.set(SELECTED_RUN_QUERY_KEY, runId);
    url.searchParams.set("view", "project-map");
  } else {
    url.searchParams.delete(SELECTED_RUN_QUERY_KEY);
  }
  if (nodeId) url.searchParams.set(SELECTED_RUN_NODE_QUERY_KEY, nodeId);
  else url.searchParams.delete(SELECTED_RUN_NODE_QUERY_KEY);
  window.history.replaceState({}, "", url.toString());
}

/** run/node 選択を URL query と同期し、再読込可能な deep link にする。 */
export function useRunGraphDeepLink() {
  const initial = readSelection();
  const [selectedRunId, setRunId] = useState<string | null>(initial.runId);
  const [selectedNodeId, setNodeId] = useState<string | null>(initial.nodeId);

  useEffect(() => {
    const handlePopState = () => {
      const selection = readSelection();
      setRunId(selection.runId);
      setNodeId(selection.nodeId);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const setSelectedRunId = useCallback((runId: string | null) => {
    setRunId(runId);
    setNodeId(null);
    updateUrl(runId, null);
  }, []);

  const setSelectedNodeId = useCallback((nodeId: string | null, displayedRunId?: string | null) => {
    setNodeId(nodeId);
    const runId = readSelection().runId ?? displayedRunId ?? null;
    setRunId(runId);
    updateUrl(runId, nodeId);
  }, []);

  const clearRunSelection = useCallback(() => {
    setRunId(null);
    setNodeId(null);
    updateUrl(null, null);
  }, []);

  return {
    selectedRunId,
    selectedNodeId,
    setSelectedRunId,
    setSelectedNodeId,
    clearRunSelection,
  } as const;
}
