import React from "react";
import type { ScaleTime } from "d3-scale";
import type { MilestoneInfo } from "../lib/milestone-utils.js";
import type { Config, Task } from "../types/index.js";
import { parseDate } from "../lib/date-utils.js";

/** マイルストーン専用レーンの高さ（px）。 */
export const MILESTONE_LANE_HEIGHT = 22;

/**
 * {@link GanttMilestoneLane} コンポーネントのプロパティ。
 */
interface GanttMilestoneLaneProps {
  /** 描画対象のマイルストーン情報（日付昇順を想定） */
  milestones: MilestoneInfo[];
  /** 日付 → X 座標への時間スケール */
  xScale: ScaleTime<number, number>;
  /** レーン SVG の全幅（px） */
  totalWidth: number;
  /** マーカー色の解決に使う gantt 設定 */
  config: Config;
  /** マーカーへのホバー / フォーカス時にツールチップを表示するコールバック */
  onTooltipShow?: (task: Task, e: React.MouseEvent | React.FocusEvent) => void;
  /** ツールチップを隠すコールバック */
  onTooltipHide?: () => void;
  /** マーカークリック時に対象タスクを選択するコールバック */
  onSelectTask?: (taskId: string) => void;
  /** 現在選択中のタスク ID（マーカーの強調表示に使用） */
  selectedTaskId?: string | null;
}

/**
 * マイルストーン専用レーンを描画するコンポーネント。
 *
 * タイムラインヘッダー直下に配置され、各マイルストーンを菱形マーカーとして
 * `due_date`（{@link getMilestoneDate} で解決）の時間軸位置に表示する。
 * マーカーはホバー / フォーカスでツールチップを出し、クリックで選択を切り替える。
 *
 * @param props - {@link GanttMilestoneLaneProps}
 * @returns マイルストーンレーンの JSX。マイルストーンが空なら null
 */
export function GanttMilestoneLane({
  milestones,
  xScale,
  totalWidth,
  config,
  onTooltipShow,
  onTooltipHide,
  onSelectTask,
  selectedTaskId,
}: GanttMilestoneLaneProps) {
  if (milestones.length === 0) return null;

  const size = 6;
  const cy = MILESTONE_LANE_HEIGHT / 2;

  return (
    <div
      data-testid="milestone-lane"
      style={{
        height: MILESTONE_LANE_HEIGHT,
        borderBottom: "1px solid var(--color-border)",
        position: "relative",
        background: "var(--color-bg)",
      }}
    >
      <svg width={totalWidth} height={MILESTONE_LANE_HEIGHT} role="group" aria-label="Milestones">
        {milestones.map(({ task, date }) => {
          const x = xScale(parseDate(date));
          const color = config.task_types[task.type]?.color ?? "#E74C3C";
          const isSelected = selectedTaskId === task.id;
          return (
            <g
              key={task.id}
              role="graphics-symbol"
              aria-label={`Milestone: ${task.title}, ${date}, ${task.state}`}
              tabIndex={0}
              onMouseEnter={(e) => onTooltipShow?.(task, e)}
              onMouseLeave={() => onTooltipHide?.()}
              onFocus={(e) => onTooltipShow?.(task, e)}
              onBlur={() => onTooltipHide?.()}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTask?.(task.id);
              }}
              style={{ cursor: onSelectTask ? "pointer" : "default" }}
              className="gantt-focusable"
            >
              <polygon
                points={`${x},${cy - size} ${x + size},${cy} ${x},${cy + size} ${x - size},${cy}`}
                fill={color}
                fillOpacity={task.state === "closed" ? 1 : 0.4}
                stroke={color}
                strokeWidth={isSelected ? 2 : 1}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
