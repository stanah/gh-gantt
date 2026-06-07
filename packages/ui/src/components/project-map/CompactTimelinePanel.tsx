import React, { useMemo } from "react";
import { collectSubtreeIds, type Task as SharedTask, type TaskReadiness } from "@gh-gantt/shared";
import { PanelHeader, PanelBody, PanelEmpty } from "./ProjectMapLayout.js";
import { boardColumnColor } from "./ReadinessBadge.js";

interface CompactTimelinePanelProps {
  tasks: SharedTask[];
  readinessById: Record<string, TaskReadiness>;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

const ROW_H = 22;
const LABEL_W = 120;
const PX_PER_DAY = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseYmd(value: string | null): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}

/**
 * Compact Gantt / Timeline パネル（読み取り専用）。
 * 選択サブツリー（未選択なら全タスク）のうち start_date / end_date を持つタスクを、
 * 軽量なミニタイムラインのバーで表示する。今日の位置に縦線を引き、バー選択で他パネルへ伝播する。
 */
export function CompactTimelinePanel({
  tasks,
  readinessById,
  selectedTaskId,
  onSelectTask,
}: CompactTimelinePanelProps) {
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const scheduled = useMemo(() => {
    let scope = tasks;
    if (selectedTaskId && taskById.has(selectedTaskId)) {
      const ids = collectSubtreeIds(selectedTaskId, taskById);
      scope = tasks.filter((t) => ids.has(t.id));
    }
    return scope
      .map((task) => ({ task, start: parseYmd(task.start_date), end: parseYmd(task.end_date) }))
      .filter(
        (r): r is { task: SharedTask; start: number; end: number } =>
          r.start != null && r.end != null && r.end >= r.start,
      )
      .sort((a, b) => a.start - b.start);
  }, [tasks, taskById, selectedTaskId]);

  const layout = useMemo(() => {
    if (scheduled.length === 0) return null;
    const min = Math.min(...scheduled.map((r) => r.start));
    const max = Math.max(...scheduled.map((r) => r.end));
    const days = Math.max(1, Math.round((max - min) / DAY_MS) + 1);
    const width = days * PX_PER_DAY;
    const todayX = Math.round((Date.now() - min) / DAY_MS) * PX_PER_DAY;
    const xOf = (t: number) => Math.round((t - min) / DAY_MS) * PX_PER_DAY;
    return { min, max, width, todayX, xOf };
  }, [scheduled]);

  return (
    <>
      <PanelHeader title="Compact Gantt" hint={selectedTaskId ? "選択サブツリー" : "全タスク"} />
      {!layout ? (
        <PanelEmpty message="日付が設定されたタスクがありません" />
      ) : (
        <PanelBody>
          <div style={{ position: "relative" }}>
            <svg
              width={LABEL_W + layout.width + 8}
              height={scheduled.length * ROW_H + 4}
              role="group"
              aria-label="Compact timeline"
              style={{ display: "block" }}
            >
              {layout.todayX >= 0 && layout.todayX <= layout.width && (
                <line
                  x1={LABEL_W + layout.todayX}
                  y1={0}
                  x2={LABEL_W + layout.todayX}
                  y2={scheduled.length * ROW_H}
                  stroke="var(--color-danger, #e74c3c)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
              )}
              {scheduled.map((row, i) => {
                const y = i * ROW_H + 2;
                const x = LABEL_W + layout.xOf(row.start);
                const w = Math.max(4, layout.xOf(row.end) - layout.xOf(row.start) + PX_PER_DAY);
                const readiness = readinessById[row.task.id];
                const color = readiness ? boardColumnColor(readiness.column) : "#3498db";
                const isSelected = row.task.id === selectedTaskId;
                return (
                  <g
                    key={row.task.id}
                    data-task-id={row.task.id}
                    role="button"
                    tabIndex={0}
                    aria-label={row.task.title}
                    aria-pressed={isSelected}
                    onClick={() => onSelectTask(row.task.id)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      onSelectTask(row.task.id);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <text x={0} y={y + ROW_H / 2 + 3} fontSize={10} fill="var(--color-text)">
                      {row.task.title.length > 16
                        ? `${row.task.title.slice(0, 15)}…`
                        : row.task.title}
                    </text>
                    <rect
                      x={x}
                      y={y + 3}
                      width={w}
                      height={ROW_H - 8}
                      rx={3}
                      fill={color}
                      fillOpacity={isSelected ? 1 : 0.7}
                      stroke={isSelected ? "#4285f4" : "transparent"}
                      strokeWidth={isSelected ? 1.5 : 0}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        </PanelBody>
      )}
    </>
  );
}
