import React from "react";
import type { BoardColumnId, Task as SharedTask, TaskReadiness } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { ProjectTaskCard } from "./ProjectTaskCard.js";
import { boardColumnColor, boardColumnLabel } from "./ReadinessBadge.js";

interface ProjectBoardColumnProps {
  column: BoardColumnId;
  tasks: SharedTask[];
  readinessById: Record<string, TaskReadiness>;
  taskById: Map<string, SharedTask>;
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/**
 * Project Board の 1 列。列見出し（色 + 件数）と、その列に属するタスクカードを縦に並べる。
 */
export function ProjectBoardColumn({
  column,
  tasks,
  readinessById,
  taskById,
  config,
  selectedTaskId,
  onSelectTask,
}: ProjectBoardColumnProps) {
  return (
    <div
      data-column={column}
      style={{
        flex: "1 0 150px",
        minWidth: 150,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 4px 6px",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--color-text)",
          position: "sticky",
          top: 0,
          background: "var(--color-surface)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: boardColumnColor(column),
            flexShrink: 0,
          }}
        />
        {boardColumnLabel(column)}
        <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{tasks.length}</span>
      </div>
      <div style={{ overflow: "auto", flex: 1, minHeight: 0, paddingRight: 2 }}>
        {tasks.map((task) => {
          const readiness = readinessById[task.id];
          const blockingTitles = readiness?.blockingTaskIds
            .map((id) => taskById.get(id)?.title ?? `#${id}`)
            .filter(Boolean);
          return (
            <ProjectTaskCard
              key={task.id}
              task={task}
              readiness={readiness}
              config={config}
              isSelected={selectedTaskId === task.id}
              onSelect={onSelectTask}
              blockingTitles={blockingTitles}
            />
          );
        })}
      </div>
    </div>
  );
}
