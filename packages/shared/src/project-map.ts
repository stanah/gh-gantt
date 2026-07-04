import type { Task, Config, StatusValue, StatusCategory, GroupingFacet } from "./types.js";
import {
  calculateCriticalPath,
  detectCycles,
  dependencyEdgeKey,
  type CriticalPathResult,
} from "./dependency-graph.js";

/**
 * Project Board の列 ID。
 * `ready_now` は依存解除済みで今すぐ着手できるタスク。
 */
export type BoardColumnId = "ready_now" | "in_progress" | "review" | "blocked" | "done" | "backlog";

/** Project Board の列の表示順。 */
export const BOARD_COLUMN_ORDER: readonly BoardColumnId[] = [
  "ready_now",
  "in_progress",
  "review",
  "blocked",
  "done",
  "backlog",
] as const;

/** タスクが現在その列に分類された主たる理由。 */
export type ReadinessReason =
  | "already_done"
  | "needs_review"
  | "in_progress"
  | "blocked_by_open_dependency"
  | "ready"
  | "backlog";

/** Next Actions の推薦カテゴリ。 */
export type NextActionCategory =
  | "unlocker"
  | "critical"
  | "risk"
  | "review_waiting"
  | "quick_win"
  | "ready";

/** 依存サブグラフ上のノードが選択タスクから見てどの向きにあるか。 */
export type DependencyDirection = "upstream" | "selected" | "downstream";

/**
 * 1 タスクの実行可能性（readiness）と Board 列分類の評価結果。
 */
export interface TaskReadiness {
  taskId: string;
  /** 分類された Board 列。 */
  column: BoardColumnId;
  /** 分類の主たる理由。 */
  reason: ReadinessReason;
  /** 今すぐ着手できるか（`ready_now` 相当）。 */
  isReady: boolean;
  /** 未完了の依存があり着手できないか。 */
  isBlocked: boolean;
  /** 完了済みか（closed または status.done）。 */
  isDone: boolean;
  /** クリティカルパス上か。 */
  isCritical: boolean;
  /** risk / spike / external ラベルを持つか。 */
  isRisky: boolean;
  /** このタスクをブロックしている未完了の上流タスク ID。 */
  blockingTaskIds: string[];
  /** このタスクの完了で解除される下流の未完了タスク数。 */
  downstreamUnlockCount: number;
}

/** System Tree の階層ノード。 */
export interface HierarchyNode {
  task: Task;
  depth: number;
  children: HierarchyNode[];
}

/** 依存サブグラフのノード。 */
export interface DependencyGraphNode {
  task: Task;
  direction: DependencyDirection;
  /** 選択タスクからの距離（選択は 0、上流/下流は 1, 2, ...）。 */
  depth: number;
}

/** 依存サブグラフのエッジ（`from` が `to` をブロックする）。 */
export interface DependencyGraphEdge {
  from: string;
  to: string;
  /** クリティカルパス上のエッジか。 */
  isCritical: boolean;
  /** ブロッカー（from）が未完了で解除されていないか。 */
  isUnresolved: boolean;
}

/** 選択タスク周辺に絞った依存サブグラフ。 */
export interface DependencySubgraph {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
}

/** Next Actions の 1 候補。 */
export interface NextAction {
  task: Task;
  score: number;
  category: NextActionCategory;
  /** 推薦理由を表す 1 行の日本語ラベル。 */
  reason: string;
}

/** Project Map UI が消費する派生ビュー一式。 */
export interface ProjectMapViewModel {
  hierarchy: HierarchyNode[];
  boardColumns: Record<BoardColumnId, Task[]>;
  readinessById: Record<string, TaskReadiness>;
  nextActions: NextAction[];
  criticalPath: CriticalPathResult;
  /** 循環依存など、表示はするが注意が必要な事象。 */
  warnings: string[];
}

/** {@link buildProjectMapViewModel} のオプション。 */
export interface ProjectMapOptions {
  /** Next Actions の最大件数（既定 5）。 */
  nextActionsLimit?: number;
}

const RISK_LABELS = new Set(["risk", "spike", "external"]);
const PRIORITY_WEIGHT: Record<string, number> = { critical: 10, high: 6, medium: 3, low: 1 };
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function getStatusValue(task: Task, config: Config): StatusValue | undefined {
  const name = task.custom_fields[config.statuses.field_name];
  if (typeof name !== "string") return undefined;
  return config.statuses.values[name];
}

function getStatusCategory(task: Task, config: Config): StatusCategory | undefined {
  return getStatusValue(task, config)?.category;
}

/**
 * 正規化済みの優先度（critical/high/medium/low）を返す。設定が無い・値が不正なら null。
 */
export function getNormalizedPriority(task: Task, config: Config): string | null {
  const field = config.sync?.field_mapping?.priority;
  if (!field) return null;
  const raw = task.custom_fields[field];
  if (typeof raw !== "string") return null;
  const level = raw.toLowerCase();
  return level in PRIORITY_WEIGHT ? level : null;
}

/** field_mapping.estimate_hours で指定されたカスタムフィールドから見積り時間を取得する。 */
export function getEstimateHours(task: Task, config: Config): number | null {
  const field = config.sync?.field_mapping?.estimate_hours;
  if (!field) return null;
  const raw = task.custom_fields[field];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * タスクが完了済みか判定する。`state === "closed"` または status.done が true。
 */
export function isTaskDone(task: Task, config: Config): boolean {
  if (task.state === "closed") return true;
  return Boolean(getStatusValue(task, config)?.done);
}

/**
 * レビュー待ちか判定する。status.category が `in_review`、または
 * `require_review` が true で未承認の場合に true。
 */
export function needsReview(task: Task, config: Config): boolean {
  if (getStatusCategory(task, config) === "in_review") return true;
  return Boolean(task.require_review && !task.review_approved_by);
}

/**
 * risk / spike / external ラベルを持つか判定する。
 */
export function isRiskyTask(task: Task): boolean {
  return task.labels.some((l) => RISK_LABELS.has(l.toLowerCase()));
}

/**
 * このタスクをブロックしている未完了の上流タスク ID を返す。
 * 上流タスクが集合に存在しない場合も未解決として扱う。
 */
export function getBlockingTaskIds(
  task: Task,
  taskById: Map<string, Task>,
  config: Config,
): string[] {
  const ids: string[] = [];
  for (const dep of task.blocked_by) {
    const upstream = taskById.get(dep.task);
    if (!upstream || !isTaskDone(upstream, config)) ids.push(dep.task);
  }
  return ids;
}

/**
 * すべての上流依存が完了しているか（着手可能か）を判定する。
 */
export function isDependencyCleared(
  task: Task,
  taskById: Map<string, Task>,
  config: Config,
): boolean {
  return getBlockingTaskIds(task, taskById, config).length === 0;
}

/**
 * このタスクの完了で解除される下流の未完了タスク数を数える。
 * reverse `blocked_by` を辿り、到達可能な未完了タスクを重複なく数える。
 */
export function calculateDownstreamUnlockCount(
  taskId: string,
  taskById: Map<string, Task>,
  reverseEdges: Map<string, string[]>,
  config: Config,
): number {
  const visited = new Set<string>();
  const queue = [...(reverseEdges.get(taskId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    for (const child of reverseEdges.get(next) ?? []) {
      if (!visited.has(child)) queue.push(child);
    }
  }
  let count = 0;
  for (const id of visited) {
    const t = taskById.get(id);
    if (t && !isTaskDone(t, config)) count += 1;
  }
  return count;
}

/** reverse `blocked_by` 隣接リスト（ブロッカー ID -> それに依存する下流 ID 群）を作る。 */
function buildReverseEdges(tasks: Task[]): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.blocked_by) {
      const list = reverse.get(dep.task);
      if (list) list.push(task.id);
      else reverse.set(dep.task, [task.id]);
    }
  }
  return reverse;
}

function classifyColumn(
  task: Task,
  taskById: Map<string, Task>,
  config: Config,
): { column: BoardColumnId; reason: ReadinessReason } {
  if (isTaskDone(task, config)) return { column: "done", reason: "already_done" };
  if (needsReview(task, config)) return { column: "review", reason: "needs_review" };

  const status = getStatusValue(task, config);
  const category = status?.category;
  if (category === "in_progress" || status?.starts_work) {
    return { column: "in_progress", reason: "in_progress" };
  }

  const blockingIds = getBlockingTaskIds(task, taskById, config);
  if (blockingIds.length > 0 || category === "blocked") {
    return { column: "blocked", reason: "blocked_by_open_dependency" };
  }

  // 依存解除済み。明示的に backlog に置かれたものはパーク扱い、それ以外は着手可能。
  if (category === "backlog") return { column: "backlog", reason: "backlog" };
  return { column: "ready_now", reason: "ready" };
}

/**
 * 全タスクの readiness（Board 列分類・依存・下流解除数）を評価する。
 * 依存解決は `allTasks` 全体に対して行う。
 */
export function buildReadiness(
  tasks: Task[],
  config: Config,
  criticalTaskIds: Set<string>,
): Record<string, TaskReadiness> {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const reverseEdges = buildReverseEdges(tasks);
  const result: Record<string, TaskReadiness> = {};
  for (const task of tasks) {
    const { column, reason } = classifyColumn(task, taskById, config);
    const blockingTaskIds = getBlockingTaskIds(task, taskById, config);
    result[task.id] = {
      taskId: task.id,
      column,
      reason,
      isReady: column === "ready_now",
      isBlocked: column === "blocked",
      isDone: column === "done",
      isCritical: criticalTaskIds.has(task.id),
      isRisky: isRiskyTask(task),
      blockingTaskIds,
      downstreamUnlockCount: calculateDownstreamUnlockCount(
        task.id,
        taskById,
        reverseEdges,
        config,
      ),
    };
  }
  return result;
}

/**
 * 指定したタスク群を Board 列ごとにグルーピングする。
 * 依存解決は `allTasks`（既定は同じ集合）に対して行う。
 */
export function buildBoardColumns(
  tasks: Task[],
  config: Config,
  allTasks: Task[] = tasks,
): Record<BoardColumnId, Task[]> {
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  const columns: Record<BoardColumnId, Task[]> = {
    ready_now: [],
    in_progress: [],
    review: [],
    blocked: [],
    done: [],
    backlog: [],
  };
  for (const task of tasks) {
    const { column } = classifyColumn(task, taskById, config);
    columns[column].push(task);
  }
  return columns;
}

/**
 * `parent` / `sub_tasks` から System Tree の階層を構築する。
 * 親が存在しない（または未解決の）タスクをルートとし、循環は visited で防ぐ。
 */
export function buildTaskHierarchy(tasks: Task[]): HierarchyNode[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const childIds = new Set<string>();
  for (const task of tasks) {
    for (const childId of task.sub_tasks) {
      if (taskById.has(childId)) childIds.add(childId);
    }
  }

  const build = (task: Task, depth: number, visited: Set<string>): HierarchyNode => {
    visited.add(task.id);
    const children: HierarchyNode[] = [];
    for (const childId of task.sub_tasks) {
      if (visited.has(childId)) continue;
      const child = taskById.get(childId);
      if (child) children.push(build(child, depth + 1, visited));
    }
    return { task, depth, children };
  };

  const roots: HierarchyNode[] = [];
  const visited = new Set<string>();
  for (const task of tasks) {
    const parentResolved = task.parent != null && taskById.has(task.parent);
    const isRoot = !parentResolved && !childIds.has(task.id);
    if (isRoot && !visited.has(task.id)) roots.push(build(task, 0, visited));
  }
  // 親解決済みだが循環等で未到達のタスクを取りこぼさない。
  for (const task of tasks) {
    if (!visited.has(task.id)) roots.push(build(task, 0, visited));
  }
  return roots;
}

/** 指定タスクとその全子孫（sub_tasks 経由）の ID 集合を返す。 */
export function collectSubtreeIds(rootId: string, taskById: Map<string, Task>): Set<string> {
  const ids = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (ids.has(id)) continue;
    const task = taskById.get(id);
    if (!task) continue;
    ids.add(id);
    for (const childId of task.sub_tasks) {
      if (!ids.has(childId)) queue.push(childId);
    }
  }
  return ids;
}

/**
 * 選択タスク（とその子孫）を中心に、上流 / 下流 N 階層に絞った依存サブグラフを返す。
 * `selectedTaskId` が null の場合は、依存を 1 件以上持つ全タスクを返す。
 */
export function buildDependencySubgraph(
  selectedTaskId: string | null,
  tasks: Task[],
  config: Config,
  criticalEdgeKeys: Set<string>,
  depth = 2,
): DependencySubgraph {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const reverseEdges = buildReverseEdges(tasks);
  const nodeDir = new Map<string, { direction: DependencyDirection; depth: number }>();

  if (selectedTaskId == null || !taskById.has(selectedTaskId)) {
    // 選択なし: 依存に関与する全タスクを selected 扱いで返す。
    for (const task of tasks) {
      if (task.blocked_by.length > 0 || (reverseEdges.get(task.id)?.length ?? 0) > 0) {
        nodeDir.set(task.id, { direction: "selected", depth: 0 });
      }
    }
  } else {
    const core = collectSubtreeIds(selectedTaskId, taskById);
    for (const id of core) nodeDir.set(id, { direction: "selected", depth: 0 });

    // 上流: blocked_by を辿る
    let frontier = [...core];
    for (let d = 1; d <= depth; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const task = taskById.get(id);
        if (!task) continue;
        for (const dep of task.blocked_by) {
          if (!taskById.has(dep.task)) continue;
          if (!nodeDir.has(dep.task)) {
            nodeDir.set(dep.task, { direction: "upstream", depth: d });
            next.push(dep.task);
          }
        }
      }
      frontier = next;
    }

    // 下流: reverse edges を辿る
    frontier = [...core];
    for (let d = 1; d <= depth; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const childId of reverseEdges.get(id) ?? []) {
          if (!taskById.has(childId)) continue;
          if (!nodeDir.has(childId)) {
            nodeDir.set(childId, { direction: "downstream", depth: d });
            next.push(childId);
          }
        }
      }
      frontier = next;
    }
  }

  const nodes: DependencyGraphNode[] = [];
  for (const [id, info] of nodeDir) {
    const task = taskById.get(id);
    if (task) nodes.push({ task, direction: info.direction, depth: info.depth });
  }

  const edges: DependencyGraphEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.task.blocked_by) {
      if (!nodeDir.has(dep.task)) continue;
      const upstream = taskById.get(dep.task);
      edges.push({
        from: dep.task,
        to: node.task.id,
        isCritical: criticalEdgeKeys.has(dependencyEdgeKey(dep.task, node.task.id)),
        isUnresolved: !upstream || !isTaskDone(upstream, config),
      });
    }
  }

  return { nodes, edges };
}

function nextActionCategory(
  readiness: TaskReadiness,
  task: Task,
  config: Config,
): NextActionCategory {
  if (readiness.downstreamUnlockCount >= 2) return "unlocker";
  if (readiness.isCritical) return "critical";
  if (readiness.isRisky) return "risk";
  if (needsReview(task, config)) return "review_waiting";
  const estimate = getEstimateHours(task, config);
  if (estimate != null && estimate <= 2) return "quick_win";
  return "ready";
}

function nextActionReason(category: NextActionCategory, readiness: TaskReadiness): string {
  switch (category) {
    case "unlocker":
      return `${readiness.downstreamUnlockCount}件の下流タスクを解除`;
    case "critical":
      return "クリティカルパス上";
    case "risk":
      return "高リスク";
    case "review_waiting":
      return "レビュー待ち";
    case "quick_win":
      return "すぐ終わる";
    default:
      return "着手可能";
  }
}

/**
 * 次に着手すべきタスクをスコア順に推薦する。
 * 候補は open かつ未完了のタスク。スコア同点時は priority → updated_at(新しい順) → title で安定ソートする。
 */
export function buildNextActions(
  tasks: Task[],
  config: Config,
  readinessById: Record<string, TaskReadiness>,
  limit = 5,
): NextAction[] {
  const candidates: Array<{ action: NextAction; rank: number; updatedAt: number; title: string }> =
    [];
  for (const task of tasks) {
    const readiness = readinessById[task.id];
    if (!readiness || readiness.isDone || task.state === "closed") continue;
    // 子タスクを持つ親（epic / feature 等のコンテナ）は直接の着手対象ではないため除外する。
    if (task.sub_tasks.length > 0) continue;

    const priority = getNormalizedPriority(task, config);
    const estimate = getEstimateHours(task, config);
    const score =
      (readiness.isReady ? 20 : 0) +
      (priority ? PRIORITY_WEIGHT[priority] : 0) +
      readiness.downstreamUnlockCount * 3 +
      (readiness.isCritical ? 8 : 0) +
      (readiness.isRisky ? 5 : 0) -
      (estimate != null ? estimate / 8 : 0);

    const category = nextActionCategory(readiness, task, config);
    candidates.push({
      action: { task, score, category, reason: nextActionReason(category, readiness) },
      rank: priority ? PRIORITY_RANK[priority] : 99,
      updatedAt: Date.parse(task.updated_at) || 0,
      title: task.title,
    });
  }

  candidates.sort((a, b) => {
    if (b.action.score !== a.action.score) return b.action.score - a.action.score;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.title.localeCompare(b.title);
  });

  return candidates.slice(0, limit).map((c) => c.action);
}

/**
 * 既存 `Task[]` と `Config` から Project Map UI 用の派生ビュー一式を組み立てる。
 *
 * @param tasks - 全タスク
 * @param config - gantt 設定
 * @param options - Next Actions 件数などのオプション
 * @returns 階層・Board・readiness・Next Actions・クリティカルパス・警告
 */
export function buildProjectMapViewModel(
  tasks: Task[],
  config: Config,
  options: ProjectMapOptions = {},
): ProjectMapViewModel {
  const criticalPath = calculateCriticalPath(tasks);
  const criticalTaskIds = new Set(criticalPath.criticalTaskIds);
  const readinessById = buildReadiness(tasks, config, criticalTaskIds);
  const hierarchy = buildTaskHierarchy(tasks);
  const boardColumns = buildBoardColumns(tasks, config);
  const nextActions = buildNextActions(tasks, config, readinessById, options.nextActionsLimit ?? 5);

  const warnings: string[] = [];
  const cycles = detectCycles(tasks);
  if (cycles.length > 0) {
    warnings.push(
      `循環依存を ${cycles.length} 件検出しました: ${cycles.map((c) => c.join(" → ")).join(" / ")}`,
    );
  }

  return { hierarchy, boardColumns, readinessById, nextActions, criticalPath, warnings };
}

// ---------------------------------------------------------------------------
// Group by 軸セレクタ / 多ファセット分類 (FR-VIS-025)
// ---------------------------------------------------------------------------

/**
 * Project Map の Group by 軸。`label:<facetKey>` は config.grouping.facets で定義された
 * 名前空間ラベル facet を表す（多対多）。`hierarchy` は分解構造（既定）。
 */
export type GroupDimension =
  | "hierarchy"
  | "type"
  | "milestone"
  | "assignee"
  | "status"
  | "priority"
  | `label:${string}`;

/** Group by の 1 グループ。 */
export interface TaskGroup {
  key: string;
  label: string;
  taskIds: string[];
}

/** {@link groupTasks} の結果。 */
export interface GroupingResult {
  dimension: GroupDimension;
  groups: TaskGroup[];
  /** 1 タスクが複数グループに所属しうる軸（ラベル facet / 担当者）か。 */
  multiMembership: boolean;
}

/** Group by ドロップダウンに出す選択肢。 */
export interface GroupDimensionOption {
  value: GroupDimension;
  label: string;
}

const GROUP_NONE_KEY = "__none__";
const GROUP_NONE_LABEL = "(なし)";
const GROUP_ALL_KEY = "__all__";

const PRIORITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** ラベル facet の既定区切り文字。`namespace:value` の `:`。 */
export const DEFAULT_FACET_SEPARATOR = ":";

/**
 * タスク群のラベルから `namespace<sep>value` 規約のラベルを走査し、
 * distinct な namespace を facet 軸候補として返す（設定不要の自動検出）。
 *
 * 区切りが先頭・末尾にあるラベル（`:foo` / `foo:`）は namespace とみなさない。
 *
 * @param tasks - 走査対象のタスク
 * @param separator - 区切り文字（既定 `:`）
 * @returns namespace 昇順の facet 配列（label/key は namespace、prefix は `namespace<sep>`）
 */
export function detectLabelFacets(
  tasks: Task[],
  separator: string = DEFAULT_FACET_SEPARATOR,
): GroupingFacet[] {
  const namespaces = new Set<string>();
  for (const task of tasks) {
    for (const label of task.labels) {
      const idx = label.indexOf(separator);
      if (idx > 0 && idx < label.length - separator.length) {
        namespaces.add(label.slice(0, idx));
      }
    }
  }
  return [...namespaces].sort().map((ns) => ({ key: ns, label: ns, label_prefix: ns + separator }));
}

/**
 * Group by 軸の選択肢を組み立てる。
 * 組み込み軸（階層 / タイプ / ステータス / 優先度 / 担当者 / マイルストーン）に加え、
 * `config.grouping.facets`（明示定義）と、タスクのラベルから {@link detectLabelFacets} で
 * 自動検出した namespace facet をマージして `label:<key>` 軸として並べる。
 * 同じ key は config の定義（カスタムラベル）を優先する。
 *
 * @param config - gantt 設定
 * @param tasks - 自動検出に使うタスク（省略時は config の facets のみ）
 */
export function getGroupDimensions(config: Config, tasks: Task[] = []): GroupDimensionOption[] {
  const options: GroupDimensionOption[] = [
    { value: "hierarchy", label: "階層" },
    { value: "type", label: "タイプ" },
    { value: "status", label: "ステータス" },
    { value: "priority", label: "優先度" },
    { value: "assignee", label: "担当者" },
    { value: "milestone", label: "マイルストーン" },
  ];
  const configFacets = config.grouping?.facets ?? [];
  const configKeys = new Set(configFacets.map((f) => f.key));
  // key だけでなく label_prefix も突き合わせ、設定済み prefix を別 namespace として
  // 二重に自動検出しないようにする（例: key=component, prefix=system: と system:ui）。
  const configPrefixes = new Set(configFacets.map((f) => f.label_prefix));
  const autoFacets = detectLabelFacets(tasks).filter(
    (f) => !configKeys.has(f.key) && !configPrefixes.has(f.label_prefix),
  );
  for (const facet of [...configFacets, ...autoFacets]) {
    options.push({ value: `label:${facet.key}`, label: facet.label });
  }
  return options;
}

/** 1 タスクが指定軸で属するグループ（複数可）を {key,label} の配列で返す。 */
function resolveGroupAssignments(
  task: Task,
  dimension: GroupDimension,
  config: Config,
): Array<{ key: string; label: string }> {
  if (dimension === "type") {
    const label = config.task_types[task.type]?.label ?? task.type;
    return [{ key: `type:${task.type}`, label }];
  }
  if (dimension === "milestone") {
    return task.milestone ? [{ key: `ms:${task.milestone}`, label: task.milestone }] : [];
  }
  if (dimension === "assignee") {
    return task.assignees.map((a) => ({ key: `assignee:${a}`, label: a }));
  }
  if (dimension === "status") {
    const name = task.custom_fields[config.statuses.field_name];
    return typeof name === "string" && name.length > 0
      ? [{ key: `status:${name}`, label: name }]
      : [];
  }
  if (dimension === "priority") {
    const p = getNormalizedPriority(task, config);
    return p ? [{ key: `priority:${p}`, label: PRIORITY_LABEL[p] ?? p }] : [];
  }
  if (dimension.startsWith("label:")) {
    const facetKey = dimension.slice("label:".length);
    const facet = config.grouping?.facets?.find((f) => f.key === facetKey);
    // config に明示定義が無い軸は、自動検出の規約として `<key><sep>` を prefix とする。
    const prefix = facet?.label_prefix ?? `${facetKey}${DEFAULT_FACET_SEPARATOR}`;
    return task.labels
      .filter((l) => l.startsWith(prefix))
      .map((l) => {
        const value = l.slice(prefix.length);
        return { key: `${facetKey}:${value}`, label: value };
      });
  }
  return [];
}

function isMultiMembershipDimension(dimension: GroupDimension): boolean {
  return dimension === "assignee" || dimension.startsWith("label:");
}

/**
 * タスク群を指定した軸でグルーピングする。
 *
 * - `hierarchy`: グルーピングせず単一グループ（UI 側で親子ツリーを描く）。
 * - 単一値軸（type/milestone/status/priority）: 各タスクは 1 グループ。
 * - 多対多軸（assignee / `label:<facet>`）: タスクは複数グループに重複所属しうる。
 * - 値を持たないタスクは末尾の「(なし)」グループに入る。
 *
 * グループの並びは出現順を保つ（「(なし)」は常に末尾）。
 *
 * @param tasks - 対象タスク
 * @param dimension - Group by 軸
 * @param config - gantt 設定（facet 定義・status/priority フィールドの解決に使用）
 * @returns グルーピング結果
 */
export function groupTasks(
  tasks: Task[],
  dimension: GroupDimension,
  config: Config,
): GroupingResult {
  if (dimension === "hierarchy") {
    return {
      dimension,
      groups: [{ key: GROUP_ALL_KEY, label: "すべて", taskIds: tasks.map((t) => t.id) }],
      multiMembership: false,
    };
  }

  const order: string[] = [];
  const byKey = new Map<string, TaskGroup>();
  const ensure = (key: string, label: string): TaskGroup => {
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, taskIds: [] };
      byKey.set(key, group);
      order.push(key);
    }
    return group;
  };

  for (const task of tasks) {
    const assignments = resolveGroupAssignments(task, dimension, config);
    if (assignments.length === 0) {
      ensure(GROUP_NONE_KEY, GROUP_NONE_LABEL).taskIds.push(task.id);
    } else {
      for (const a of assignments) ensure(a.key, a.label).taskIds.push(task.id);
    }
  }

  const groups = order.filter((k) => k !== GROUP_NONE_KEY).map((k) => byKey.get(k)!);
  const none = byKey.get(GROUP_NONE_KEY);
  if (none) groups.push(none);

  return { dimension, groups, multiMembership: isMultiMembershipDimension(dimension) };
}
