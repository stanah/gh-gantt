import { useState, useCallback } from "react";

export type DisplayOption = "issueId" | "assignees";

export function useDisplayOptions() {
  const [enabled, setEnabled] = useState<Set<DisplayOption>>(() => new Set<DisplayOption>(["issueId"]));

  const toggle = useCallback((opt: DisplayOption) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(opt)) next.delete(opt);
      else next.add(opt);
      return next;
    });
  }, []);

  return { displayOptions: enabled, toggleDisplayOption: toggle };
}

export function formatIssueId(taskId: string): string {
  const hash = taskId.indexOf("#");
  if (hash === -1) return "";
  const suffix = taskId.substring(hash + 1);
  if (suffix.startsWith("draft-")) return "D-" + suffix.slice(6);
  return "#" + suffix;
}
