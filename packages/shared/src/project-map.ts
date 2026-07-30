import { z } from "zod";
import type { Task, Config, StatusValue, StatusCategory, GroupingFacet } from "./types.js";
import {
  calculateCriticalPath,
  detectCycles,
  dependencyEdgeKey,
  type CriticalPathResult,
} from "./dependency-graph.js";
import {
  RUN_GRAPH_ATTEMPT_STATES,
  RUN_GRAPH_NODE_STATES,
  RUN_GRAPH_ROLES,
  RUN_GRAPH_RUN_STATES,
  RunGraphActorSchema,
  RunGraphArtifactSchema,
  RunGraphEvidenceSchema,
  type RunGraphBoundedCollection,
  type GraphContract,
  type RunGraphActor,
  type RunGraphAttemptState,
  type RunGraphNodeState,
  type RunGraphRunState,
  type RunGraphView,
} from "./run-graph.js";

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
// planned-vs-actual Run Graph overlay (FR-VIS-026)
// ---------------------------------------------------------------------------

/** Project Map が operator 向けに正規化する Run / Node の表示状態。 */
export type ProjectMapRunDisplayState =
  | "active"
  | "queued"
  | "running"
  | "retrying"
  | "waiting_human"
  | "failed"
  | "completed"
  | "cancelled";

export type ProjectMapRunDeviationKind =
  | "unexpected_node"
  | "unexpected_edge"
  | "skip"
  | "retry"
  | "fallback"
  | "cancel";

export interface ProjectMapRunMetric {
  known: boolean;
  value: number | null;
  unit: "ms" | "token" | "currency";
}

export interface ProjectMapRunSummary {
  runId: string;
  taskId: string;
  state: RunGraphRunState;
  displayState: ProjectMapRunDisplayState;
  currentNodeId: string | null;
  currentContractNodeId: string | null;
  waitReason: string | null;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  attemptCount: number;
  deepLink: string;
}

export interface ProjectMapPlannedNode {
  id: string;
  role: string;
}

export interface ProjectMapPlannedEdge {
  id: string;
  from: string;
  to: string;
  conditions: string[];
}

export interface ProjectMapActualNode {
  id: string;
  contractNodeId: string;
  state: RunGraphNodeState;
  displayState: ProjectMapRunDisplayState;
  actor: RunGraphActor;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  attemptCount: number;
  artifactCount: number;
  evidenceCount: number;
  isPlanned: boolean;
  deepLink: string;
}

export interface ProjectMapActualAttempt {
  id: string;
  nodeId: string;
  ordinal: number;
  state: RunGraphAttemptState;
  actor: RunGraphActor;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  artifactCount: number;
  evidenceCount: number;
}

export interface ProjectMapActualTransition {
  fromNodeId: string;
  toNodeId: string;
  fromContractNodeId: string;
  toContractNodeId: string;
  isPlanned: boolean;
}

export interface ProjectMapRunDeviation {
  id: string;
  kind: ProjectMapRunDeviationKind;
  nodeId: string | null;
  transition: { fromNodeId: string; toNodeId: string } | null;
  reason: string;
}

export interface ProjectMapSelectedRun {
  runId: string;
  taskId: string;
  state: RunGraphRunState;
  displayState: ProjectMapRunDisplayState;
  waitReason: string | null;
  selectedNodeId: string | null;
  deepLink: string;
  planned: {
    nodes: RunGraphBoundedCollection<ProjectMapPlannedNode>;
    edges: RunGraphBoundedCollection<ProjectMapPlannedEdge>;
  };
  actual: {
    nodes: ProjectMapActualNode[];
    transitions: ProjectMapActualTransition[];
    attempts: ProjectMapActualAttempt[];
    nodesTruncated: boolean;
    attemptsTruncated: boolean;
  };
  deviations: ProjectMapRunDeviation[];
  metrics: {
    duration: ProjectMapRunMetric;
    tokens: ProjectMapRunMetric;
    cost: ProjectMapRunMetric;
    latency: ProjectMapRunMetric;
  };
  artifacts: RunGraphView["artifacts"];
  evidence: RunGraphView["evidence"];
}

export interface ProjectMapRunGraphViewModel {
  schemaVersion: "1";
  taskId: string | null;
  runs: {
    total: number;
    limit: number;
    truncated: boolean;
    items: ProjectMapRunSummary[];
  };
  selectedRun: ProjectMapSelectedRun | null;
}

export interface ProjectMapRunGraphInput {
  taskId: string | null;
  contract: GraphContract | null;
  runViews: RunGraphView[];
  selectedRunId?: string | null;
  selectedNodeId?: string | null;
  limit?: number;
  totalRuns?: number;
}

const ProjectMapRunDisplayStateSchema = z.enum([
  "active",
  "queued",
  "running",
  "retrying",
  "waiting_human",
  "failed",
  "completed",
  "cancelled",
]);

const ProjectMapRunDeviationKindSchema = z.enum([
  "unexpected_node",
  "unexpected_edge",
  "skip",
  "retry",
  "fallback",
  "cancel",
]);

const ProjectMapRunMetricSchema = z
  .object({
    known: z.boolean(),
    value: z.number().nullable(),
    unit: z.enum(["ms", "token", "currency"]),
  })
  .strict();

function projectMapBoundedCollectionSchema<T extends z.ZodType>(itemSchema: T) {
  return z
    .object({
      total: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(50),
      truncated: z.boolean(),
      items: z.array(itemSchema).max(50),
    })
    .strict()
    .superRefine((collection, context) => {
      if (
        collection.items.length > collection.limit ||
        collection.items.length > collection.total
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items"],
          message: "items は limit と total 以下である必要があります",
        });
      }
    });
}

const ProjectMapRunSummarySchema = z
  .object({
    runId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(500),
    state: z.enum(RUN_GRAPH_RUN_STATES),
    displayState: ProjectMapRunDisplayStateSchema,
    currentNodeId: z.string().min(1).max(200).nullable(),
    currentContractNodeId: z.string().min(1).nullable(),
    waitReason: z.string().min(1).max(2000).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    nodeCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    deepLink: z.string().min(1),
  })
  .strict();

const ProjectMapPlannedNodeSchema = z
  .object({ id: z.string().min(1), role: z.enum(RUN_GRAPH_ROLES) })
  .strict();

const ProjectMapPlannedEdgeSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    conditions: z.array(z.string().min(1)).min(1),
  })
  .strict();

const ProjectMapActualNodeSchema = z
  .object({
    id: z.string().min(1).max(200),
    contractNodeId: z.string().min(1),
    state: z.enum(RUN_GRAPH_NODE_STATES),
    displayState: ProjectMapRunDisplayStateSchema,
    actor: RunGraphActorSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().nonnegative().nullable(),
    attemptCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative(),
    isPlanned: z.boolean(),
    deepLink: z.string().min(1),
  })
  .strict();

const ProjectMapActualAttemptSchema = z
  .object({
    id: z.string().min(1).max(200),
    nodeId: z.string().min(1).max(200),
    ordinal: z.number().int().positive(),
    state: z.enum(RUN_GRAPH_ATTEMPT_STATES),
    actor: RunGraphActorSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().nonnegative().nullable(),
    artifactCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative(),
  })
  .strict();

const ProjectMapActualTransitionSchema = z
  .object({
    fromNodeId: z.string().min(1).max(200),
    toNodeId: z.string().min(1).max(200),
    fromContractNodeId: z.string().min(1),
    toContractNodeId: z.string().min(1),
    isPlanned: z.boolean(),
  })
  .strict();

const ProjectMapRunDeviationSchema = z
  .object({
    id: z.string().min(1),
    kind: ProjectMapRunDeviationKindSchema,
    nodeId: z.string().min(1).max(200).nullable(),
    transition: z
      .object({
        fromNodeId: z.string().min(1).max(200),
        toNodeId: z.string().min(1).max(200),
      })
      .strict()
      .nullable(),
    reason: z.string().min(1),
  })
  .strict();

/** UI/agent API が共用する planned-vs-actual response の strict runtime schema。 */
export const ProjectMapRunGraphViewModelSchema: z.ZodType<ProjectMapRunGraphViewModel> = z
  .object({
    schemaVersion: z.literal("1"),
    taskId: z.string().min(1).max(500).nullable(),
    runs: projectMapBoundedCollectionSchema(ProjectMapRunSummarySchema),
    selectedRun: z
      .object({
        runId: z.string().min(1).max(200),
        taskId: z.string().min(1).max(500),
        state: z.enum(RUN_GRAPH_RUN_STATES),
        displayState: ProjectMapRunDisplayStateSchema,
        waitReason: z.string().min(1).max(2000).nullable(),
        selectedNodeId: z.string().min(1).max(200).nullable(),
        deepLink: z.string().min(1),
        planned: z
          .object({
            nodes: projectMapBoundedCollectionSchema(ProjectMapPlannedNodeSchema),
            edges: projectMapBoundedCollectionSchema(ProjectMapPlannedEdgeSchema),
          })
          .strict(),
        actual: z
          .object({
            nodes: z.array(ProjectMapActualNodeSchema).max(50),
            transitions: z.array(ProjectMapActualTransitionSchema).max(50),
            attempts: z.array(ProjectMapActualAttemptSchema).max(50),
            nodesTruncated: z.boolean(),
            attemptsTruncated: z.boolean(),
          })
          .strict(),
        deviations: z.array(ProjectMapRunDeviationSchema).max(200),
        metrics: z
          .object({
            duration: ProjectMapRunMetricSchema,
            tokens: ProjectMapRunMetricSchema,
            cost: ProjectMapRunMetricSchema,
            latency: ProjectMapRunMetricSchema,
          })
          .strict(),
        artifacts: projectMapBoundedCollectionSchema(RunGraphArtifactSchema),
        evidence: projectMapBoundedCollectionSchema(RunGraphEvidenceSchema),
      })
      .strict()
      .nullable(),
  })
  .strict();

function runTaskId(view: RunGraphView): string {
  return `${view.task.owner}/${view.task.repo}#${view.task.issueNumber}`;
}

function finiteDuration(start: string, end: string): number | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

function runDisplayState(state: RunGraphRunState): ProjectMapRunDisplayState {
  switch (state) {
    case "pending":
      return "queued";
    case "running":
    case "paused":
      return "active";
    default:
      return state;
  }
}

function nodeDisplayState(state: RunGraphNodeState, retrying: boolean): ProjectMapRunDisplayState {
  if (retrying && (state === "pending" || state === "ready" || state === "running")) {
    return "retrying";
  }
  switch (state) {
    case "pending":
    case "ready":
      return "queued";
    case "paused":
      return "running";
    default:
      return state;
  }
}

function isTerminalState(state: string): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "succeeded" ||
    state === "timed_out" ||
    state === "stalled"
  );
}

function plannedPathLength(from: string, to: string, edges: GraphContract["edges"]): number | null {
  if (from === to) return 0;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const queue: Array<{ id: string; distance: number }> = [{ id: from, distance: 0 }];
  const visited = new Set([from]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const target of outgoing.get(current.id) ?? []) {
      if (target === to) return current.distance + 1;
      if (target === "terminal" || visited.has(target)) continue;
      visited.add(target);
      queue.push({ id: target, distance: current.distance + 1 });
    }
  }
  return null;
}

function boundedWithFocus<T>(
  items: T[],
  limit: number,
  matchesFocus: ((item: T) => boolean) | null,
): RunGraphBoundedCollection<T> {
  const head = items.slice(0, limit);
  const focused = matchesFocus ? items.filter(matchesFocus).slice(0, limit) : [];
  const focusedSet = new Set(focused);
  const companions = head.filter((item) => !focusedSet.has(item)).slice(0, limit - focused.length);
  const selected = new Set([...focused, ...companions]);
  const boundedItems = items.filter((item) => selected.has(item));
  return {
    total: items.length,
    limit,
    truncated: items.length > boundedItems.length,
    items: boundedItems,
  };
}

function runDeepLink(taskId: string, runId: string, nodeId?: string | null): string {
  const pairs: Array<[string, string]> = [
    ["view", "project-map"],
    ["task", taskId],
    ["run", runId],
  ];
  if (nodeId) pairs.push(["node", nodeId]);
  return `?${pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&")}`;
}

function buildRunSummary(view: RunGraphView): ProjectMapRunSummary {
  const taskId = runTaskId(view);
  return {
    runId: view.runId,
    taskId,
    state: view.state,
    displayState: runDisplayState(view.state),
    currentNodeId: view.currentNode?.id ?? null,
    currentContractNodeId: view.currentNode?.contractNodeId ?? null,
    waitReason: view.waitReason,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    nodeCount: view.nodes.total,
    attemptCount: view.attempts.total,
    deepLink: runDeepLink(taskId, view.runId, view.currentNode?.id),
  };
}

function buildSelectedRun(
  view: RunGraphView,
  contract: GraphContract | null,
  requestedNodeId: string | null,
  limit: number,
): ProjectMapSelectedRun {
  const taskId = runTaskId(view);
  const contractNodes = new Map((contract?.nodes ?? []).map((node) => [node.id, node]));
  const actualNodeById = new Map(view.nodes.items.map((node) => [node.id, node]));
  const selectedNodeId =
    requestedNodeId && actualNodeById.has(requestedNodeId)
      ? requestedNodeId
      : (view.currentNode?.id ?? null);
  const selectedContractNodeId = selectedNodeId
    ? (actualNodeById.get(selectedNodeId)?.contractNodeId ?? null)
    : null;
  const firstOccurrence = new Map<string, string>();
  for (const node of view.nodes.items) {
    if (!firstOccurrence.has(node.contractNodeId))
      firstOccurrence.set(node.contractNodeId, node.id);
  }

  const actualNodes: ProjectMapActualNode[] = view.nodes.items.map((node) => {
    const attempts = view.attempts.items.filter((attempt) => attempt.nodeId === node.id);
    const retrying =
      firstOccurrence.get(node.contractNodeId) !== node.id || attempts.some((a) => a.ordinal > 1);
    return {
      id: node.id,
      contractNodeId: node.contractNodeId,
      state: node.state,
      displayState: nodeDisplayState(node.state, retrying),
      actor: node.actor,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      endedAt: isTerminalState(node.state) ? node.updatedAt : null,
      durationMs: finiteDuration(node.createdAt, node.updatedAt),
      attemptCount: attempts.length,
      artifactCount: view.artifacts.items.filter((item) => item.nodeId === node.id).length,
      evidenceCount: view.evidence.items.filter((item) => item.nodeId === node.id).length,
      isPlanned: contractNodes.has(node.contractNodeId),
      deepLink: runDeepLink(taskId, view.runId, node.id),
    };
  });

  const actualAttempts: ProjectMapActualAttempt[] = view.attempts.items.map((attempt) => ({
    id: attempt.id,
    nodeId: attempt.nodeId,
    ordinal: attempt.ordinal,
    state: attempt.state,
    actor: attempt.actor,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    endedAt: isTerminalState(attempt.state) ? attempt.updatedAt : null,
    durationMs: finiteDuration(attempt.createdAt, attempt.updatedAt),
    artifactCount: view.artifacts.items.filter((item) => item.producerAttemptId === attempt.id)
      .length,
    evidenceCount: view.evidence.items.filter((item) => item.producerAttemptId === attempt.id)
      .length,
  }));

  const plannedEdgeKeys = new Set(
    (contract?.edges ?? []).map((edge) => `${edge.from}->${edge.to}`),
  );
  const transitions: ProjectMapActualTransition[] = [];
  const deviations = new Map<string, ProjectMapRunDeviation>();

  for (const node of view.nodes.items) {
    const hasRetriedAttempt = view.attempts.items.some(
      (attempt) => attempt.nodeId === node.id && attempt.ordinal > 1,
    );
    if (!contractNodes.has(node.contractNodeId)) {
      const id = `unexpected-node:${node.id}`;
      deviations.set(id, {
        id,
        kind: "unexpected_node",
        nodeId: node.id,
        transition: null,
        reason: `planned にない node ${node.contractNodeId}`,
      });
    }
    if (firstOccurrence.get(node.contractNodeId) !== node.id || hasRetriedAttempt) {
      const id = `retry:${node.id}`;
      deviations.set(id, {
        id,
        kind: "retry",
        nodeId: node.id,
        transition: null,
        reason: `${node.contractNodeId} を再試行`,
      });
    }
    if (node.state === "cancelled") {
      const id = `cancel:${node.id}`;
      deviations.set(id, {
        id,
        kind: "cancel",
        nodeId: node.id,
        transition: null,
        reason: `${node.contractNodeId} が cancelled`,
      });
    }
    if (!node.previousNodeId) continue;
    const previous = actualNodeById.get(node.previousNodeId);
    if (!previous) continue;
    const edgeKey = `${previous.contractNodeId}->${node.contractNodeId}`;
    const isPlanned = plannedEdgeKeys.has(edgeKey);
    transitions.push({
      fromNodeId: previous.id,
      toNodeId: node.id,
      fromContractNodeId: previous.contractNodeId,
      toContractNodeId: node.contractNodeId,
      isPlanned,
    });
    if (!isPlanned) {
      const id = `unexpected-edge:${previous.id}->${node.id}`;
      deviations.set(id, {
        id,
        kind: "unexpected_edge",
        nodeId: node.id,
        transition: { fromNodeId: previous.id, toNodeId: node.id },
        reason: `planned にない edge ${edgeKey}`,
      });
    }
    const contractEdges = contract?.edges ?? [];
    const returnsToVisitedNode = firstOccurrence.get(node.contractNodeId) !== node.id;
    const reversePathLength = plannedPathLength(
      node.contractNodeId,
      previous.contractNodeId,
      contractEdges,
    );
    const forwardPathLength = plannedPathLength(
      previous.contractNodeId,
      node.contractNodeId,
      contractEdges,
    );
    if (returnsToVisitedNode || (!isPlanned && reversePathLength != null)) {
      const id = `fallback:${previous.id}->${node.id}`;
      deviations.set(id, {
        id,
        kind: "fallback",
        nodeId: node.id,
        transition: { fromNodeId: previous.id, toNodeId: node.id },
        reason: `${previous.contractNodeId} から ${node.contractNodeId} へ戻った`,
      });
    } else if (!isPlanned && forwardPathLength != null && forwardPathLength > 1) {
      const id = `skip:${previous.id}->${node.id}`;
      deviations.set(id, {
        id,
        kind: "skip",
        nodeId: node.id,
        transition: { fromNodeId: previous.id, toNodeId: node.id },
        reason: `${previous.contractNodeId} と ${node.contractNodeId} の間の planned node を skip`,
      });
    }
  }

  if (view.state === "cancelled") {
    deviations.set(`cancel:${view.runId}`, {
      id: `cancel:${view.runId}`,
      kind: "cancel",
      nodeId: view.currentNode?.id ?? null,
      transition: null,
      reason: `run ${view.runId} が cancelled`,
    });
  }

  const duration = finiteDuration(view.createdAt, view.updatedAt);
  const plannedNodes = (contract?.nodes ?? []).map((node) => ({ id: node.id, role: node.role }));
  const plannedEdges = (contract?.edges ?? []).map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    conditions: [edge.condition],
  }));
  return {
    runId: view.runId,
    taskId,
    state: view.state,
    displayState: runDisplayState(view.state),
    waitReason: view.waitReason,
    selectedNodeId,
    deepLink: runDeepLink(taskId, view.runId, selectedNodeId),
    planned: {
      nodes: boundedWithFocus(
        plannedNodes,
        limit,
        selectedContractNodeId ? (node) => node.id === selectedContractNodeId : null,
      ),
      edges: boundedWithFocus(
        plannedEdges,
        limit,
        selectedContractNodeId
          ? (edge) => edge.from === selectedContractNodeId || edge.to === selectedContractNodeId
          : null,
      ),
    },
    actual: {
      nodes: actualNodes,
      transitions,
      attempts: actualAttempts,
      nodesTruncated: view.nodes.truncated,
      attemptsTruncated: view.attempts.truncated,
    },
    deviations: [...deviations.values()],
    metrics: {
      duration: { known: duration != null, value: duration, unit: "ms" },
      tokens: { known: false, value: null, unit: "token" },
      cost: { known: false, value: null, unit: "currency" },
      latency: { known: false, value: null, unit: "ms" },
    },
    artifacts: view.artifacts,
    evidence: view.evidence,
  };
}

/**
 * Graph Contract と bounded RunGraphView から Project Map/API 共通の overlay を導出する。
 * runner log 本文は受け取らず、bounded entity/reference だけを返す。
 */
export function buildProjectMapRunGraphViewModel(
  input: ProjectMapRunGraphInput,
): ProjectMapRunGraphViewModel {
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const sortedViews = [...input.runViews].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.runId.localeCompare(right.runId),
  );
  const summaries = sortedViews.map(buildRunSummary);
  const totalRuns = Math.max(input.totalRuns ?? summaries.length, summaries.length);
  const selectedView = input.selectedRunId
    ? (sortedViews.find((view) => view.runId === input.selectedRunId) ?? null)
    : (sortedViews[0] ?? null);
  let items = summaries.slice(0, limit);
  if (selectedView && !items.some((summary) => summary.runId === selectedView.runId)) {
    const selectedSummary = summaries.find((summary) => summary.runId === selectedView.runId);
    if (selectedSummary) {
      items = [
        selectedSummary,
        ...items.filter((summary) => summary.runId !== selectedView.runId),
      ].slice(0, limit);
    }
  }
  return {
    schemaVersion: "1",
    taskId: input.taskId,
    runs: {
      total: totalRuns,
      limit,
      truncated: totalRuns > items.length,
      items,
    },
    selectedRun: selectedView
      ? buildSelectedRun(selectedView, input.contract, input.selectedNodeId ?? null, limit)
      : null,
  };
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
