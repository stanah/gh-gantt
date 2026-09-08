import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Handle,
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
  type Task as SharedTask,
  type TaskReadiness,
} from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { PanelHeader, PanelEmpty } from "./ProjectMapLayout.js";
import { boardColumnColor } from "./ReadinessBadge.js";
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
  isSelected: boolean;
  /** フィルタで除外された上流の件数（0 なら省略記号を出さない）。 */
  hiddenUpstream: number;
  /** フィルタで除外された下流の件数（0 なら省略記号を出さない）。 */
  hiddenDownstream: number;
  onSelect: (taskId: string) => void;
}

/** 依存エッジが保持する描画データ。 */
interface DependencyEdgeData extends Record<string, unknown> {
  points: { x: number; y: number }[];
  stroke: string;
  strokeWidth: number;
  dashed: boolean;
  isCritical: boolean;
}

type TaskFlowNode = Node<TaskNodeData, "task">;
type DependencyFlowEdge = Edge<DependencyEdgeData, "dependency">;

const SELECTED_BORDER = "var(--color-selected-fg, #1a73e8)";
const DANGER = "var(--color-danger, #e74c3c)";

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
        borderStyle: "solid",
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
      <span
        aria-hidden="true"
        style={{ alignSelf: "stretch", width: 4, flexShrink: 0, background: data.color }}
      />
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {data.title}
      </span>
      {(data.hiddenUpstream > 0 || data.hiddenDownstream > 0) && (
        <HiddenNeighborMark upstream={data.hiddenUpstream} downstream={data.hiddenDownstream} />
      )}
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

/** dagre の経路点をそのまま折れ線 (角を丸めたパス) として描画するエッジ。 */
// 上流が左・下流が右の配置で向きが読めるため、矢印 (markerEnd) は付けない
function DependencyEdge({ id, data }: EdgeProps<DependencyFlowEdge>) {
  if (!data) return null;
  const path = buildRoundedPath(data.points);
  return (
    <path
      id={id}
      data-edge={id}
      data-critical={data.isCritical ? "true" : undefined}
      className="react-flow__edge-path"
      d={path}
      fill="none"
      stroke={data.stroke}
      strokeWidth={data.strokeWidth}
      strokeDasharray={data.dashed ? "4 3" : undefined}
    />
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
  "--xy-edge-stroke-width": "1",
  "--xy-controls-button-background-color": "var(--color-surface, #fff)",
  "--xy-controls-button-background-color-hover": "var(--color-hover-bg, #f5f8ff)",
  "--xy-controls-button-color": "var(--color-text)",
  "--xy-controls-button-color-hover": "var(--color-text)",
  "--xy-controls-button-border-color": "var(--color-border)",
  "--xy-controls-box-shadow": "none",
  "--xy-attribution-background-color": "transparent",
} as React.CSSProperties;

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
  const appliedRef = useRef<{ layout: DependencyMapLayout; selectedTaskId: string | null }>();

  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    const applied = appliedRef.current;
    if (applied && applied.layout === layout && applied.selectedTaskId === selectedTaskId) return;
    appliedRef.current = { layout, selectedTaskId };
    void setViewport(computeInitialViewport(layout, selectedTaskId, { width, height }));
  }, [layout, selectedTaskId, width, height, setViewport]);

  return null;
}

/**
 * Dependency Map パネル。選択タスク（とその子孫）を中心に、左を上流 (ブロッカー)・右を下流とする
 * 横向きの階層配置を dagre で求め、React Flow で描画する。互いに依存のない連結成分は個別に配置する。未解決の上流は赤い破線、クリティカルパスは太線で強調し、
 * 循環依存があれば警告を表示する。パン・ズームで大きなグラフを閲覧できる。
 */
export function DependencyMapPanel({
  tasks,
  visibleTaskIds = null,
  readinessById,
  config,
  criticalEdgeKeys,
  warnings,
  selectedTaskId,
  onSelectTask,
}: DependencyMapPanelProps) {
  const criticalSet = useMemo(() => new Set(criticalEdgeKeys), [criticalEdgeKeys]);

  // 選択タスク中心の絞り込み（全タスクから組む）とツールバーのフィルタ（除外）は直交して効く
  const graph = useMemo(
    () =>
      pruneDependencySubgraph(
        buildDependencySubgraph(selectedTaskId, tasks, config, criticalSet),
        visibleTaskIds,
      ),
    [selectedTaskId, tasks, config, criticalSet, visibleTaskIds],
  );

  const layout = useMemo(() => layoutDependencyGraph(graph), [graph]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => onSelectTask(node.id),
    [onSelectTask],
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
          isSelected: node.task.id === selectedTaskId,
          hiddenUpstream: hidden?.upstream ?? 0,
          hiddenDownstream: hidden?.downstream ?? 0,
          onSelect: onSelectTask,
        },
      };
    });
  }, [graph, layout, readinessById, selectedTaskId, onSelectTask]);

  const edges = useMemo<DependencyFlowEdge[]>(() => {
    const pointsByKey = new Map(layout.edges.map((e) => [`${e.from}->${e.to}`, e.points]));
    return graph.edges.flatMap((edge) => {
      const key = `${edge.from}->${edge.to}`;
      const points = pointsByKey.get(key);
      if (!points) return [];
      const stroke = edge.isUnresolved
        ? DANGER
        : edge.isCritical
          ? config.gantt.colors.critical_path
          : "var(--color-border)";
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
            stroke,
            strokeWidth: edge.isCritical ? 2 : 1,
            dashed: edge.isUnresolved,
            isCritical: edge.isCritical,
          },
        },
      ];
    });
  }, [graph, layout, config.gantt.colors.critical_path]);

  return (
    <>
      <PanelHeader
        title="Dependency Map"
        hint={
          graph.nodes.length > 0
            ? `${selectedTaskId ? "選択の依存" : "全依存"} · ${graph.nodes.length} ノード / ${graph.edges.length} エッジ${
                graph.hiddenNodeCount > 0 ? ` · フィルタで ${graph.hiddenNodeCount} 件非表示` : ""
              }`
            : selectedTaskId
              ? "選択の依存"
              : "全依存"
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
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      )}
    </>
  );
}
