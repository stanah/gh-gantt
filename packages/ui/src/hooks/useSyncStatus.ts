import { useCallback, useEffect, useState } from "react";

/** `/api/sync/status` のレスポンス。 */
export interface SyncStatus {
  last_synced_at: string;
  local_changes: number;
  total_tasks: number;
}

/**
 * `/api/sync/status` を取得する hook。Project Map のヘッダーに同期状態を表示するために使う。
 * `refreshKey` が変化するたび、または `refresh()` 呼び出しで再取得し、取得に失敗した場合は
 * null を保持する。クリーンアップは effect 内に閉じ込め、`refresh` は副作用トリガーのみを行う。
 *
 * @param refreshKey - 再取得のトリガー（pull/push 後に変化させる想定）
 */
export function useSyncStatus(refreshKey: unknown = 0): {
  status: SyncStatus | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch("/api/sync/status");
        const data = res.ok ? ((await res.json()) as SyncStatus) : null;
        if (!cancelled) setStatus(data);
      } catch {
        // fetch が利用できない・失敗する環境（テスト等）では同期状態を表示しない
        if (!cancelled) setStatus(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, tick]);

  return { status, refresh };
}
