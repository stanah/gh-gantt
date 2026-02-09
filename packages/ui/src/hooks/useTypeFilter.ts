import { useState, useCallback, useMemo } from "react";
import type { TaskType } from "../types/index.js";

export function useTypeFilter(taskTypes: Record<string, TaskType>) {
  const allTypes = useMemo(() => Object.keys(taskTypes), [taskTypes]);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(allTypes));

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
