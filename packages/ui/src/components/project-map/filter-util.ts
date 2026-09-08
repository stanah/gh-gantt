import type {
  BoardColumnId,
  HierarchyNode,
  Task as SharedTask,
  TaskReadiness,
} from "@gh-gantt/shared";

/**
 * Project Map のフィルタ状態。Gantt ビューの TypeFilter / hideClosed とは独立に保持する。
 * 配列は「選択中の値」で、空配列は絞り込みなし（All）を意味する。
 */
export interface ProjectMapFilterState {
  /** タイトル / issue 番号の部分一致検索。 */
  search: string;
  /** 選択中の readiness 列（複数選択）。空なら全列。 */
  readiness: BoardColumnId[];
  /** Done 列のタスクを除外するか。readiness の選択とは独立に効く。 */
  excludeDone: boolean;
  /** 選択中のタスクタイプ（複数選択）。空なら全タイプ。 */
  types: string[];
  /**
   * 選択中のマイルストーン名（複数選択）。空なら全件。
   * {@link MILESTONE_NONE_KEY} は「自身にも祖先にもマイルストーンが無い」タスクを表す。
   */
  milestones: string[];
  /** マイルストーン型（`display: "milestone"`）のタスクを Dependency Map のノードとして表示するか。 */
  showMilestoneTypes: boolean;
}

/** マイルストーン絞り込みで「(なし)」を表すキー。マイルストーン名と衝突しない値にする。 */
export const MILESTONE_NONE_KEY = "__none__";

/** 絞り込みなしの初期フィルタ状態を返す。 */
export function createDefaultProjectMapFilter(): ProjectMapFilterState {
  return {
    search: "",
    readiness: [],
    excludeDone: false,
    types: [],
    milestones: [],
    showMilestoneTypes: false,
  };
}

/**
 * タスクがフィルタ条件（検索文字列・readiness 列・Done 除外・タスクタイプ・マイルストーン）に
 * 一致するか判定する。検索はタイトルと issue 番号を対象とし、大文字小文字を無視する。
 *
 * @param inheritedMilestone - 祖先から継承して解決済みのマイルストーン
 *   （shared の `resolveInheritedMilestones` の結果）。未指定なら task.milestone をそのまま使う
 */
export function taskMatchesFilter(
  task: SharedTask,
  readiness: TaskReadiness | undefined,
  filter: ProjectMapFilterState,
  inheritedMilestone?: string | null,
): boolean {
  const column = readiness?.column;
  if (filter.excludeDone && column === "done") return false;
  if (filter.readiness.length > 0 && (column == null || !filter.readiness.includes(column))) {
    return false;
  }
  if (filter.types.length > 0 && !filter.types.includes(task.type)) return false;
  if (filter.milestones.length > 0) {
    const milestone = inheritedMilestone === undefined ? task.milestone : inheritedMilestone;
    if (!filter.milestones.includes(milestone ?? MILESTONE_NONE_KEY)) return false;
  }
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
