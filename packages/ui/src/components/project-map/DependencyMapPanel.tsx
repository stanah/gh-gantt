import React, { useMemo } from "react";
import {
  buildDependencySubgraph,
  type Task as SharedTask,
  type TaskReadiness,
  type DependencyGraphNode,
} from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { PanelHeader, PanelBody, PanelEmpty } from "./ProjectMapLayout.js";
import { boardColumnColor } from "./ReadinessBadge.js";

interface DependencyMapPanelProps {
  tasks: SharedTask[];
  readinessById: Record<string, TaskReadiness>;
  config: Config;
  criticalEdgeKeys: string[];
  warnings: string[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

const BOX_W = 150;
const BOX_H = 30;
const GAP_X = 16;
const GAP_Y = 34;
const PAD = 12;

/**
 * Dependency Map パネル。選択タスク（とその子孫）を中心に上流 / 下流を層状に縦配置し、
 * blocked_by エッジを SVG で描画する。未解決の上流は赤、クリティカルパスは太線で強調し、
 * 循環依存があれば警告を表示する。
 */
export function DependencyMapPanel({
  tasks,
  readinessById,
  config,
  criticalEdgeKeys,
  warnings,
  selectedTaskId,
  onSelectTask,
}: DependencyMapPanelProps) {
  const criticalSet = useMemo(() => new Set(criticalEdgeKeys), [criticalEdgeKeys]);

  const graph = useMemo(
    () => buildDependencySubgraph(selectedTaskId, tasks, config, criticalSet),
    [selectedTaskId, tasks, config, criticalSet],
  );

  const layout = useMemo(() => {
    // rank: upstream を上 (負), selected を 0, downstream を下 (正) に置く
    const rankOf = (node: DependencyGraphNode) =>
      node.direction === "upstream"
        ? -node.depth
        : node.direction === "downstream"
          ? node.depth
          : 0;

    const byRank = new Map<number, DependencyGraphNode[]>();
    for (const node of graph.nodes) {
      const rank = rankOf(node);
      const list = byRank.get(rank);
      if (list) list.push(node);
      else byRank.set(rank, [node]);
    }
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    const pos = new Map<string, { x: number; y: number }>();
    let maxCols = 0;
    ranks.forEach((rank, rowIndex) => {
      const nodes = byRank.get(rank)!;
      maxCols = Math.max(maxCols, nodes.length);
      nodes.forEach((node, colIndex) => {
        pos.set(node.task.id, {
          x: PAD + colIndex * (BOX_W + GAP_X),
          y: PAD + rowIndex * (BOX_H + GAP_Y),
        });
      });
    });
    const width = PAD * 2 + Math.max(1, maxCols) * (BOX_W + GAP_X) - GAP_X;
    const height = PAD * 2 + Math.max(1, ranks.length) * (BOX_H + GAP_Y) - GAP_Y;
    return { pos, width, height };
  }, [graph]);

  return (
    <>
      <PanelHeader title="Dependency Map" hint={selectedTaskId ? "選択の依存" : "全依存"} />
      {warnings.length > 0 && (
        <div
          role="alert"
          style={{
            margin: 8,
            padding: "4px 8px",
            fontSize: 10,
            color: "var(--color-danger, #e74c3c)",
            background: "var(--color-danger-bg, rgba(231,76,60,0.1))",
            border: "1px solid var(--color-danger, #e74c3c)",
            borderRadius: 4,
          }}
        >
          {warnings.join(" / ")}
        </div>
      )}
      {graph.nodes.length === 0 ? (
        <PanelEmpty message="依存関係のあるタスクがありません" />
      ) : (
        <PanelBody>
          <svg
            width={layout.width}
            height={layout.height}
            role="group"
            aria-label="Dependency graph"
            style={{ display: "block" }}
          >
            {graph.edges.map((edge) => {
              const from = layout.pos.get(edge.from);
              const to = layout.pos.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + BOX_W / 2;
              const y1 = from.y + BOX_H;
              const x2 = to.x + BOX_W / 2;
              const y2 = to.y;
              const stroke = edge.isUnresolved
                ? "#e74c3c"
                : edge.isCritical
                  ? config.gantt.colors.critical_path
                  : "var(--color-border)";
              return (
                <line
                  key={`${edge.from}->${edge.to}`}
                  data-edge={`${edge.from}->${edge.to}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={stroke}
                  strokeWidth={edge.isCritical ? 2 : 1}
                  strokeDasharray={edge.isUnresolved ? "3 2" : undefined}
                />
              );
            })}
            {graph.nodes.map((node) => {
              const p = layout.pos.get(node.task.id);
              if (!p) return null;
              const readiness = readinessById[node.task.id];
              const color = readiness ? boardColumnColor(readiness.column) : "#8b949e";
              const isSelected = node.task.id === selectedTaskId;
              return (
                <g
                  key={node.task.id}
                  data-node={node.task.id}
                  role="button"
                  tabIndex={0}
                  aria-label={node.task.title}
                  aria-pressed={isSelected}
                  onClick={() => onSelectTask(node.task.id)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onSelectTask(node.task.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    x={p.x}
                    y={p.y}
                    width={BOX_W}
                    height={BOX_H}
                    rx={4}
                    fill="var(--color-bg)"
                    stroke={isSelected ? "#4285f4" : color}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                  />
                  <rect x={p.x} y={p.y} width={4} height={BOX_H} rx={2} fill={color} />
                  <text x={p.x + 10} y={p.y + BOX_H / 2 + 4} fontSize={11} fill="var(--color-text)">
                    {node.task.title.length > 18
                      ? `${node.task.title.slice(0, 17)}…`
                      : node.task.title}
                  </text>
                </g>
              );
            })}
          </svg>
        </PanelBody>
      )}
    </>
  );
}
