import { useCallback, useEffect, useState } from "react";

/** `/api/sync/status` のレスポンス。 */
export interface SyncStatus {
  last_synced_at: string;
  local_changes: number;
  total_tasks: number;
}

/**
 * `/api/sync/status` を取得する hook。Project Map のヘッダーに同期状態を表示するために使う。
 * `refreshKey` が変化するたびに再取得し、取得に失敗した場合は null を保持する。
 *
 * @param refreshKey - 再取得のトリガー（pull/push 後にインクリメントする想定）
 */
export function useSyncStatus(refreshKey: unknown = 0): {
  status: SyncStatus | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    try {
      Promise.resolve(fetch("/api/sync/status"))
        .then((res) => (res.ok ? res.json() : null))
        .then((data: SyncStatus | null) => {
          if (!cancelled) setStatus(data);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    } catch {
      // fetch 自体が同期的に失敗する環境（テスト等）では同期状態を表示しない
      setStatus(null);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = refresh();
    return cleanup;
  }, [refresh, refreshKey]);

  return { status, refresh };
}
