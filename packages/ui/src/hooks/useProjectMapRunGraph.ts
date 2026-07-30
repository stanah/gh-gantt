import { useEffect, useState } from "react";
import {
  ProjectMapRunGraphViewModelSchema,
  type ProjectMapRunGraphViewModel,
} from "@gh-gantt/shared";

/** 選択中 task/run/node の bounded planned-vs-actual overlay を取得する。 */
export function useProjectMapRunGraph(
  taskId: string | null,
  runId: string | null,
  nodeId: string | null,
  enabled = true,
) {
  const [viewModel, setViewModel] = useState<ProjectMapRunGraphViewModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !taskId) {
      setViewModel(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({ taskId, limit: "20" });
    if (runId) params.set("runId", runId);
    if (nodeId) params.set("nodeId", nodeId);
    setLoading(true);
    setError(null);

    void fetch(`/api/project-map/run-graph?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Run Graph の取得に失敗しました");
        }
        const parsed = ProjectMapRunGraphViewModelSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Run Graph 応答の検証に失敗しました");
        return parsed.data;
      })
      .then((payload) => {
        if (!controller.signal.aborted) setViewModel(payload);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setViewModel(null);
        setError(reason instanceof Error ? reason.message : "Run Graph の取得に失敗しました");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, nodeId, runId, taskId]);

  return { viewModel, loading, error } as const;
}
