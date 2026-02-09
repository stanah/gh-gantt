import { useState, useCallback, useMemo, useEffect } from "react";
import type { TaskType } from "../types/index.js";

export function useTypeFilter(taskTypes: Record<string, TaskType>) {
  const allTypes = useMemo(() => Object.keys(taskTypes), [taskTypes]);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(allTypes));

  // Sync enabled set when taskTypes changes (e.g. after async config load)
  useEffect(() => {
    if (allTypes.length > 0) {
      setEnabled((prev) => {
        if (prev.size === 0) return new Set(allTypes);
        return prev;
      });
    }
  }, [allTypes]);

  const toggle = useCallback((typeName: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(typeName)) next.delete(typeName);
      else next.add(typeName);
      return next;
    });
  }, []);

  const enableAll = useCallback(() => setEnabled(new Set(allTypes)), [allTypes]);

  return { enabled, toggle, enableAll };
}
