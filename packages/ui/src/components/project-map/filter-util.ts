import type { HierarchyNode, Task as SharedTask, TaskReadiness } from "@gh-gantt/shared";
import type { ProjectMapFilterState } from "./ProjectMapToolbar.js";

/**
 * タスクがフィルタ条件（検索文字列・readiness 列）に一致するか判定する。
 * 検索はタイトルと issue 番号を対象とし、大文字小文字を無視する。
 */
export function taskMatchesFilter(
  task: SharedTask,
  readiness: TaskReadiness | undefined,
  filter: ProjectMapFilterState,
): boolean {
  if (filter.readiness && readiness?.column !== filter.readiness) return false;
  const q = filter.search.trim().toLowerCase();
  if (q.length === 0) return true;
  if (task.title.toLowerCase().includes(q)) return true;
  if (task.github_issue != null && `#${task.github_issue}`.includes(q)) return true;
  return false;
}

/**
 * 階層を絞り込む。ノード自身が一致するか、子孫に一致があるノードを残す
 * （一致ノードの祖先は文脈として保持される）。
 */
export function filterHierarchy(nodes: HierarchyNode[], matchedIds: Set<string>): HierarchyNode[] {
  const result: HierarchyNode[] = [];
  for (const node of nodes) {
    const children = filterHierarchy(node.children, matchedIds);
    if (matchedIds.has(node.task.id) || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}
