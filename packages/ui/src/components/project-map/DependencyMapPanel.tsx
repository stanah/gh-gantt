import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Handle,
  Panel,
  Position,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import {
  buildDependencySubgraph,
  pruneDependencySubgraph,
  type DependencyType,
  type LinkedPullRequestRef,
  type Task as SharedTask,
  type TaskReadiness,
} from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { PanelHeader, PanelEmpty } from "./ProjectMapLayout.js";
import { boardColumnColor } from "./ReadinessBadge.js";
import { AssigneeAvatars } from "./AssigneeAvatars.js";
import { LinkedPrBadge } from "./LinkedPrBadge.js";
import {
  computeInitialViewport,
  layoutDependencyGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type DependencyMapLayout,
} from "./dependency-map-layout.js";

interface DependencyMapPanelProps {
  tasks: SharedTask[];
  /**
   * ツールバーのフィルタに一致したタスク ID。指定するとサブグラフからそれ以外のノードを取り除き、
   * 除外ノードを経由する依存はノード上の省略記号で途切れを示す。省略 / null なら全ノードを表示する。
   */
  visibleTaskIds?: ReadonlySet<string> | null;
  /** マイルストーン型（display: "milestone"）のタスク ID。ひし形マークと破線枠で通常ノードと区別する。 */
  milestoneTaskIds?: ReadonlySet<string>;
  readinessById: Record<string, TaskReadiness>;
  config: Config;
  criticalEdgeKeys: string[];
  warnings: string[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/** タスクノードが保持する描画データ。 */
interface TaskNodeData extends Record<string, unknown> {
  title: string;
  /** readiness 列に対応する色 (左のバーと枠線)。 */
  color: string;
  /** 担当者の GitHub login。空ならアバター領域を作らない。 */
  assignees: string[];
  /** 関連 PR。状態を持つ PR が無ければバッジを作らない。 */
  linkedPrs: LinkedPullRequestRef[];
  isSelected: boolean;
  /** マイルストーン型のタスクか（ひし形マーク + 破線枠で描く）。 */
  isMilestone: boolean;
  /** フィルタで除外された上流の件数（0 なら省略記号を出さない）。 */
  hiddenUpstream: number;
  /** フィルタで除外された下流の件数（0 なら省略記号を出さない）。 */
  hiddenDownstream: number;
  onSelect: (taskId: string) => void;
  /** このタスクを選択したうえで「選択中心」モードへ切り替える。 */
  onFocus: (taskId: string) => void;
}

/**
 * Dependency Map の表示範囲。
 * - `all`: 依存に関与する全タスクを表示する (既定)。選択はノードの強調にだけ使う
 * - `focus`: 選択タスク (とその子孫) を中心に上流 / 下流 2 階層へ絞り込む
 */
export type DependencyMapScope = "all" | "focus";

/** エッジが保持する描画データ。 */
interface DependencyEdgeData extends Record<string, unknown> {
  points: { x: number; y: number }[];
  kind: DependencyEdgeKind;
  stroke: string;
  strokeWidth: number;
  dasharray: string | undefined;
  isCritical: boolean;
  isUnresolved: boolean;
  /** 依存タイプ (finish-to-start 以外) と lag のラベル。無ければ null。 */
  label: string | null;
}

type TaskFlowNode = Node<TaskNodeData, "task">;
type DependencyFlowEdge = Edge<DependencyEdgeData, "dependency">;

const SELECTED_BORDER = "var(--color-selected-fg, #1a73e8)";
const DANGER = "var(--color-danger, #e74c3c)";

/**
 * エッジの関係種別。ブロック (解決済み / 未解決)、クリティカルパス、親子の 4 系統を
 * 色と線種の組み合わせで区別する (色覚に配慮して色だけに頼らない)。
 */
export type DependencyEdgeKind = "blocked" | "unresolved" | "critical" | "parent";

/** 関係種別ごとの線の見た目。凡例と描画で共用する。 */
export interface DependencyEdgeStyle {
  label: string;
  stroke: string;
  strokeWidth: number;
  /** 破線 / 点線のパターン。実線なら undefined。 */
  dasharray?: string;
}

/** 依存エッジの基本線幅 (px)。1px では背景から浮かず追いづらいため太めにする。 */
const EDGE_BASE_WIDTH = 2;
/** クリティカルパスの線幅 (px)。 */
const EDGE_CRITICAL_WIDTH = 3.5;
/** 未解決の依存を示す破線パターン。 */
const DASH_UNRESOLVED = "7 4";
/** 親子関係を示す点線パターン。 */
const DASH_PARENT = "2 3";

/**
 * 関係種別ごとの色・線種・線幅を 1 箇所で定義する。
 * - ブロック (解決済み): 実線、テキスト補助色 (ライト / ダーク両方で背景と十分なコントラストがある)
 * - ブロック (未解決): 破線、danger トークン
 * - クリティカルパス: 太い実線、config の `gantt.colors.critical_path` (未解決なら太い破線)
 * - 親子: 点線、Gantt の親ハイライトと同じ parent トークン
 * critical_path が danger と同じ赤に設定されていても、線種と線幅で未解決との区別がつく。
 */
export function dependencyEdgeStyles(
  criticalColor: string,
): Record<DependencyEdgeKind, DependencyEdgeStyle> {
  return {
    blocked: {
      label: "ブロック (解決済み)",
      stroke: "var(--color-text-secondary, #666)",
      strokeWidth: EDGE_BASE_WIDTH,
    },
    unresolved: {
      label: "ブロック (未解決)",
      stroke: DANGER,
      strokeWidth: EDGE_BASE_WIDTH,
      dasharray: DASH_UNRESOLVED,
    },
    critical: {
      label: "クリティカルパス",
      stroke: criticalColor,
      strokeWidth: EDGE_CRITICAL_WIDTH,
    },
    parent: {
      label: "親子",
      stroke: "var(--color-highlight-parent-border, #8957e5)",
      strokeWidth: 1.5,
      dasharray: DASH_PARENT,
    },
  };
}

/** 凡例の表示順。 */
const EDGE_KIND_ORDER: DependencyEdgeKind[] = ["blocked", "unresolved", "critical", "parent"];

/** 依存タイプの略号。finish-to-start は既定なので表示しない。 */
const DEPENDENCY_TYPE_ABBR: Record<DependencyType, string | null> = {
  "finish-to-start": null,
  "start-to-start": "SS",
  "finish-to-finish": "FF",
  "start-to-finish": "SF",
};

/**
 * 依存タイプと lag をエッジ上のラベルにする。finish-to-start かつ lag 0 なら null。
 * 例: "SS", "+3d", "FF -2d"。線種は関係種別に使うため、依存タイプはラベルで表す。
 */
export function dependencyEdgeLabel(type: DependencyType, lag: number): string | null {
  const parts: string[] = [];
  const abbr = DEPENDENCY_TYPE_ABBR[type];
  if (abbr) parts.push(abbr);
  if (lag !== 0) parts.push(`${lag > 0 ? "+" : ""}${lag}d`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** ハンドルは経路計算に使わないため不可視にする。 */
const hiddenHandleStyle: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  pointerEvents: "none",
};

/** ノード本体。Enter / Space で選択を親へ伝える (クリックは onNodeClick 経由)。 */
function TaskNode({ id, data }: NodeProps<TaskFlowNode>) {
  return (
    <div
      data-node={id}
      data-milestone={data.isMilestone ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-label={data.title}
      aria-pressed={data.isSelected}
      title={data.title}
      // クリックは React Flow の onNodeClick で受ける (ノード wrapper の pointer-events を有効化するため)
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        data.onSelect(id);
      }}
      style={{
        boxSizing: "border-box",
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 8px 0 0",
        borderRadius: 4,
        borderStyle: data.isMilestone ? "dashed" : "solid",
        borderWidth: data.isSelected ? 2.5 : 1.5,
        borderColor: data.isSelected ? SELECTED_BORDER : data.color,
        background: "var(--color-surface, #fff)",
        color: "var(--color-text)",
        fontSize: 11,
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={hiddenHandleStyle}
      />
      {data.isMilestone ? (
        // マイルストーン型は左バーの代わりにひし形マークで示す
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            marginLeft: 6,
            flexShrink: 0,
            background: data.color,
            transform: "rotate(45deg)",
          }}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{ alignSelf: "stretch", width: 4, flexShrink: 0, background: data.color }}
        />
      )}
      {/* アバターと PR バッジはタイトルの左に置く。右端は省略記号とフォーカス操作 */}
      <AssigneeAvatars assignees={data.assignees} />
      <LinkedPrBadge linkedPrs={data.linkedPrs} />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {data.title}
      </span>
      {(data.hiddenUpstream > 0 || data.hiddenDownstream > 0) && (
        <HiddenNeighborMark upstream={data.hiddenUpstream} downstream={data.hiddenDownstream} />
      )}
      <button
        type="button"
        data-node-focus={id}
        aria-label={`${data.title} を中心に表示`}
        title="このタスクを中心に表示"
        // クリックは onNodeClick (選択のみ) に伝播させず、フォーカス操作だけを行う
        onClick={(e) => {
          e.stopPropagation();
          data.onFocus(id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
        style={{
          flexShrink: 0,
          width: 16,
          height: 16,
          padding: 0,
          border: 0,
          borderRadius: 3,
          background: "transparent",
          color: "var(--color-text-muted)",
          fontSize: 11,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ◎
      </button>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={hiddenHandleStyle}
      />
    </div>
  );
}

/**
 * フィルタで除外されたノードへ続く依存が途切れていることを示す省略記号。
 * 上流側は「⋯→」、下流側は「→⋯」で向きを示し、title と data 属性に件数を持つ。
 */
function HiddenNeighborMark({ upstream, downstream }: { upstream: number; downstream: number }) {
  const parts: string[] = [];
  if (upstream > 0) parts.push(`除外された上流 ${upstream} 件`);
  if (downstream > 0) parts.push(`除外された下流 ${downstream} 件`);
  return (
    <span
      data-hidden-upstream={upstream > 0 ? upstream : undefined}
      data-hidden-downstream={downstream > 0 ? downstream : undefined}
      title={`フィルタで${parts.join(" / ")}が非表示`}
      aria-label={parts.join(" / ")}
      style={{
        flexShrink: 0,
        fontSize: 9,
        lineHeight: 1,
        padding: "1px 3px",
        borderRadius: 3,
        border: "1px dashed var(--color-text-muted, #8b949e)",
        color: "var(--color-text-muted, #8b949e)",
        whiteSpace: "nowrap",
      }}
    >
      {upstream > 0 ? "⋯→" : ""}
      {downstream > 0 ? "→⋯" : ""}
    </span>
  );
}

/**
 * dagre の経路点をそのまま折れ線 (角を丸めたパス) として描画するエッジ。
 * 依存タイプ / lag のラベルがあれば経路の中点に添える。
 */
// 上流が左・下流が右の配置で向きが読めるため、矢印 (markerEnd) は付けない
function DependencyEdge({ id, data }: EdgeProps<DependencyFlowEdge>) {
  if (!data) return null;
  const path = buildRoundedPath(data.points);
  const mid = data.label ? polylineMidpoint(data.points) : null;
  return (
    <g data-edge-group={id}>
      <path
        id={id}
        data-edge={id}
        data-kind={data.kind}
        data-critical={data.isCritical ? "true" : undefined}
        data-unresolved={data.isUnresolved ? "true" : undefined}
        className="react-flow__edge-path"
        d={path}
        fill="none"
        stroke={data.stroke}
        strokeWidth={data.strokeWidth}
        strokeDasharray={data.dasharray}
      />
      {data.label && mid && (
        <text
          data-edge-label={id}
          x={mid.x}
          y={mid.y - 4}
          textAnchor="middle"
          fontSize={9}
          fontWeight={600}
          fill={data.stroke}
          stroke="var(--color-surface, #fff)"
          strokeWidth={3}
          paintOrder="stroke"
          style={{ pointerEvents: "none" }}
        >
          {data.label}
        </text>
      )}
    </g>
  );
}

/** 折れ線の全長の半分の位置にある点を返す。 */
function polylineMidpoint(points: { x: number; y: number }[]): { x: number; y: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let remaining = total / 2;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= remaining) {
      const t = len === 0 ? 0 : remaining / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= len;
  }
  return points[points.length - 1];
}

/** 凡例。関係種別ごとの線見本とラベル、依存タイプ / lag ラベルの読み方を示す。 */
function EdgeLegend({
  styles,
  showParents,
}: {
  styles: Record<DependencyEdgeKind, DependencyEdgeStyle>;
  showParents: boolean;
}) {
  return (
    <Panel position="bottom-left">
      <div
        role="group"
        aria-label="凡例"
        data-testid="dependency-map-legend"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "4px 6px",
          fontSize: 9,
          lineHeight: 1.4,
          color: "var(--color-text-secondary)",
          background: "var(--color-surface, #fff)",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          opacity: 0.95,
        }}
      >
        {EDGE_KIND_ORDER.map((kind) => {
          const style = styles[kind];
          const hidden = kind === "parent" && !showParents;
          return (
            <span
              key={kind}
              data-legend-kind={kind}
              style={{ display: "flex", alignItems: "center", gap: 5, opacity: hidden ? 0.5 : 1 }}
            >
              <svg width={28} height={8} aria-hidden="true" style={{ flexShrink: 0 }}>
                <line
                  x1={0}
                  y1={4}
                  x2={28}
                  y2={4}
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  strokeDasharray={style.dasharray}
                />
              </svg>
              {style.label}
              {hidden ? " (非表示)" : ""}
            </span>
          );
        })}
        <span style={{ color: "var(--color-text-muted)" }}>
          SS / FF / SF = 依存タイプ (finish-to-start 以外)、+Nd = lag
        </span>
      </div>
    </Panel>
  );
}

/** 折れ線の角を二次ベジェで丸めた SVG パスを組み立てる。 */
function buildRoundedPath(points: { x: number; y: number }[], radius = 8): string {
  if (points.length === 0) return "";
  if (points.length < 3) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  }
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0) {
      d += ` L${cur.x} ${cur.y}`;
      continue;
    }
    const inX = cur.x - ((cur.x - prev.x) / inLen) * r;
    const inY = cur.y - ((cur.y - prev.y) / inLen) * r;
    const outX = cur.x + ((next.x - cur.x) / outLen) * r;
    const outY = cur.y + ((next.y - cur.y) / outLen) * r;
    d += ` L${inX} ${inY} Q${cur.x} ${cur.y} ${outX} ${outY}`;
  }
  const last = points[points.length - 1];
  d += ` L${last.x} ${last.y}`;
  return d;
}

const nodeTypes = { task: TaskNode };
const edgeTypes = { dependency: DependencyEdge };

/** 既存テーマトークンへ React Flow の CSS 変数を束ねる。 */
const canvasStyle = {
  flex: 1,
  minHeight: 0,
  position: "relative",
  "--xy-background-color": "var(--color-surface, #fff)",
  "--xy-edge-stroke": "var(--color-border)",
  "--xy-edge-stroke-width": String(EDGE_BASE_WIDTH),
  "--xy-controls-button-background-color": "var(--color-surface, #fff)",
  "--xy-controls-button-background-color-hover": "var(--color-hover-bg, #f5f8ff)",
  "--xy-controls-button-color": "var(--color-text)",
  "--xy-controls-button-color-hover": "var(--color-text)",
  "--xy-controls-button-border-color": "var(--color-border)",
  "--xy-controls-box-shadow": "none",
  "--xy-attribution-background-color": "transparent",
} as React.CSSProperties;

const SCOPE_LABELS: Record<DependencyMapScope, string> = {
  all: "全依存",
  focus: "選択中心",
};

/** ヘッダのトグルボタン共通スタイル。 */
function toggleButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "1px 7px",
    border: `1px solid ${active ? "var(--color-accent, #4285f4)" : "var(--color-border)"}`,
    borderRadius: 10,
    fontSize: 10,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    background: active ? "rgba(66, 133, 244, 0.12)" : "var(--color-bg)",
    color: active ? "var(--color-text)" : "var(--color-text-secondary)",
  };
}

/** ヘッダの「全依存 / 選択中心」トグル。現在のモードを aria-pressed で常に示す。 */
function ScopeToggle({
  scope,
  onChange,
}: {
  scope: DependencyMapScope;
  onChange: (scope: DependencyMapScope) => void;
}) {
  return (
    <span role="group" aria-label="Dependency Map の表示範囲" style={{ display: "flex", gap: 2 }}>
      {(Object.keys(SCOPE_LABELS) as DependencyMapScope[]).map((value) => {
        const active = value === scope;
        return (
          <button
            key={value}
            type="button"
            data-scope={value}
            aria-pressed={active}
            onClick={() => onChange(value)}
            style={toggleButtonStyle(active)}
          >
            {SCOPE_LABELS[value]}
          </button>
        );
      })}
    </span>
  );
}

/**
 * レイアウト確定後に初期ビューポートを適用する。
 * 表示領域の寸法は React Flow の store から取り、未計測 (0) の間は何もしない。
 */
function InitialViewport({
  layout,
  selectedTaskId,
}: {
  layout: DependencyMapLayout;
  selectedTaskId: string | null;
}) {
  const { setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const appliedRef = useRef<DependencyMapLayout>();
  // 選択の変化だけではビューポートを動かさない (全依存モードでクリックしても表示範囲を保つ)。
  // レイアウトが変わったときに、その時点の選択を中心候補として使う
  const selectedRef = useRef(selectedTaskId);
  selectedRef.current = selectedTaskId;

  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    if (appliedRef.current === layout) return;
    appliedRef.current = layout;
    void setViewport(computeInitialViewport(layout, selectedRef.current, { width, height }));
  }, [layout, width, height, setViewport]);

  return null;
}

/**
 * Dependency Map パネル。左を上流 (ブロッカー)・右を下流とする横向きの階層配置を dagre で求め、
 * React Flow で描画する。互いに依存のない連結成分は個別に配置する。
 * 表示範囲はヘッダの「全依存 / 選択中心」トグルで切り替え、既定の「全依存」ではノードをクリックしても
 * 選択が詳細パネルへ伝わるだけで表示範囲は変わらない。「選択中心」では選択タスク (とその子孫) を中心に
 * 上流 / 下流 2 階層へ絞り込む。ノード右端のフォーカス操作 (またはダブルクリック) は
 * そのタスクを選択したうえで「選択中心」へ切り替える。
 * エッジは関係種別 (ブロック解決済み / 未解決 / クリティカルパス / 親子) を色と線種で区別し、
 * 依存タイプと lag はラベルで示す。親子エッジはヘッダのトグルで表示でき (既定は非表示)、凡例をキャンバス内に置く。
 * 循環依存があれば警告を表示する。
 */
export function DependencyMapPanel({
  tasks,
  visibleTaskIds = null,
  milestoneTaskIds,
  readinessById,
  config,
  criticalEdgeKeys,
  warnings,
  selectedTaskId,
  onSelectTask,
}: DependencyMapPanelProps) {
  const criticalSet = useMemo(() => new Set(criticalEdgeKeys), [criticalEdgeKeys]);
  const [scope, setScope] = useState<DependencyMapScope>("all");
  // 親子エッジは既定で非表示。表示してもレイアウトの段付けには使わない
  const [showParents, setShowParents] = useState(false);
  const edgeStyles = useMemo(
    () => dependencyEdgeStyles(config.gantt.colors.critical_path),
    [config.gantt.colors.critical_path],
  );

  // 「全依存」では選択に関係なく全体を出す。「選択中心」で選択がなければ全体にフォールバックする。
  // 表示範囲の絞り込み（全タスクから組む）とツールバーのフィルタ（除外）は直交して効く
  const focusTaskId = scope === "focus" ? selectedTaskId : null;
  const graph = useMemo(
    () =>
      pruneDependencySubgraph(
        buildDependencySubgraph(focusTaskId, tasks, config, criticalSet),
        visibleTaskIds,
      ),
    [focusTaskId, tasks, config, criticalSet, visibleTaskIds],
  );

  const layout = useMemo(() => layoutDependencyGraph(graph), [graph]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => onSelectTask(node.id),
    [onSelectTask],
  );

  const focusTask = useCallback(
    (taskId: string) => {
      onSelectTask(taskId);
      setScope("focus");
    },
    [onSelectTask],
  );

  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => focusTask(node.id),
    [focusTask],
  );

  const nodes = useMemo<TaskFlowNode[]>(() => {
    const posById = new Map(layout.nodes.map((n) => [n.id, n]));
    return graph.nodes.map((node) => {
      const p = posById.get(node.task.id)!;
      const readiness = readinessById[node.task.id];
      const color = readiness ? boardColumnColor(readiness.column) : "#8b949e";
      const hidden = graph.hiddenNeighborsById[node.task.id];
      return {
        id: node.task.id,
        type: "task",
        position: { x: p.x, y: p.y },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        draggable: false,
        connectable: false,
        selectable: false,
        focusable: false,
        // jsdom / SSR でも計測を待たずにエッジを描けるようハンドル位置を明示する。
        // 横向き (LR) 配置なので target を左辺中央、source を右辺中央に置く
        handles: [
          {
            type: "target",
            position: Position.Left,
            x: 0,
            y: NODE_HEIGHT / 2,
            width: 1,
            height: 1,
          },
          {
            type: "source",
            position: Position.Right,
            x: NODE_WIDTH,
            y: NODE_HEIGHT / 2,
            width: 1,
            height: 1,
          },
        ],
        data: {
          title: node.task.title,
          color,
          assignees: node.task.assignees,
          linkedPrs: node.task.linked_prs,
          isSelected: node.task.id === selectedTaskId,
          isMilestone: milestoneTaskIds?.has(node.task.id) ?? false,
          hiddenUpstream: hidden?.upstream ?? 0,
          hiddenDownstream: hidden?.downstream ?? 0,
          onSelect: onSelectTask,
          onFocus: focusTask,
        },
      };
    });
  }, [graph, layout, readinessById, selectedTaskId, milestoneTaskIds, onSelectTask, focusTask]);

  const edges = useMemo<DependencyFlowEdge[]>(() => {
    const pointsByKey = new Map(layout.edges.map((e) => [`${e.from}->${e.to}`, e.points]));
    const dependencyEdges = graph.edges.flatMap<DependencyFlowEdge>((edge) => {
      const key = `${edge.from}->${edge.to}`;
      const points = pointsByKey.get(key);
      if (!points) return [];
      // 色と線幅は関係種別 (クリティカル > 未解決 > 解決済み) から、線種は未解決かどうかから決める。
      // 未解決のクリティカルパスは太い破線になり、両方の情報を保つ
      const kind: DependencyEdgeKind = edge.isCritical
        ? "critical"
        : edge.isUnresolved
          ? "unresolved"
          : "blocked";
      const style = edgeStyles[kind];
      return [
        {
          id: key,
          type: "dependency",
          source: edge.from,
          target: edge.to,
          focusable: false,
          selectable: false,
          data: {
            points,
            kind,
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
            dasharray: edge.isUnresolved ? DASH_UNRESOLVED : style.dasharray,
            isCritical: edge.isCritical,
            isUnresolved: edge.isUnresolved,
            label: dependencyEdgeLabel(edge.type, edge.lag),
          },
        },
      ];
    });
    if (!showParents) return dependencyEdges;
    // 親子エッジは依存エッジの下に描く (配列の先頭が下)
    const parentStyle = edgeStyles.parent;
    const parentEdges = layout.parentEdges.map<DependencyFlowEdge>((edge) => ({
      id: `parent:${edge.from}->${edge.to}`,
      type: "dependency",
      source: edge.from,
      target: edge.to,
      focusable: false,
      selectable: false,
      data: {
        points: edge.points,
        kind: "parent",
        stroke: parentStyle.stroke,
        strokeWidth: parentStyle.strokeWidth,
        dasharray: parentStyle.dasharray,
        isCritical: false,
        isUnresolved: false,
        label: null,
      },
    }));
    return [...parentEdges, ...dependencyEdges];
  }, [graph, layout, edgeStyles, showParents]);

  return (
    <>
      <PanelHeader
        title="Dependency Map"
        actions={
          <>
            <ScopeToggle scope={scope} onChange={setScope} />
            <button
              type="button"
              data-parent-toggle
              aria-pressed={showParents}
              title="親子関係のエッジを表示する (レイアウトには影響しない)"
              onClick={() => setShowParents((v) => !v)}
              style={{ ...toggleButtonStyle(showParents), marginLeft: 6 }}
            >
              親子
            </button>
          </>
        }
        hint={
          graph.nodes.length > 0
            ? `${graph.nodes.length} ノード / ${graph.edges.length} エッジ${
                showParents && graph.parentEdges.length > 0
                  ? ` / 親子 ${graph.parentEdges.length}`
                  : ""
              }${
                graph.hiddenNodeCount > 0 ? ` · フィルタで ${graph.hiddenNodeCount} 件非表示` : ""
              }`
            : graph.hiddenNodeCount > 0
              ? `フィルタで ${graph.hiddenNodeCount} 件非表示`
              : undefined
        }
      />
      {warnings.length > 0 && (
        <div
          role="alert"
          style={{
            margin: 8,
            padding: "4px 8px",
            fontSize: 10,
            color: DANGER,
            background: "var(--color-danger-bg, rgba(231,76,60,0.1))",
            border: `1px solid ${DANGER}`,
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          {warnings.join(" / ")}
        </div>
      )}
      {graph.nodes.length === 0 ? (
        <PanelEmpty
          message={
            graph.hiddenNodeCount > 0
              ? "フィルタに一致する依存関係のあるタスクがありません"
              : "依存関係のあるタスクがありません"
          }
        />
      ) : (
        <div data-testid="dependency-map-canvas" style={canvasStyle}>
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              // ダブルクリックはフォーカス操作に使うため、d3-zoom の拡大 (イベントを握り潰す) を止める
              zoomOnDoubleClick={false}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              minZoom={0.2}
              maxZoom={2}
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              aria-label="Dependency graph"
            >
              <InitialViewport layout={layout} selectedTaskId={selectedTaskId} />
              <Controls showInteractive={false} position="bottom-right" />
              <EdgeLegend styles={edgeStyles} showParents={showParents} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      )}
    </>
  );
}
