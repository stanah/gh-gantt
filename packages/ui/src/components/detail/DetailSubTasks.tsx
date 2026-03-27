import React, { useState } from "react";
import type { Task } from "../../types/index.js";

interface DetailSubTasksProps {
  subTaskIds: string[];
  allTasks: Task[];
  onSelectTask: (taskId: string) => void;
}

interface SubTaskNodeProps {
  taskId: string;
  taskMap: Map<string, Task>;
  depth: number;
  onSelectTask: (taskId: string) => void;
}

function SubTaskNode({ taskId, taskMap, depth, onSelectTask }: SubTaskNodeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const task = taskMap.get(taskId);

  if (!task) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: 12,
          paddingTop: 2,
          paddingBottom: 2,
          paddingLeft: depth * 20,
        }}
      >
        <span style={{ width: 14 }} />
        <span style={{ color: "var(--color-text-muted)" }}>{taskId}</span>
      </div>
    );
  }

  const hasChildren = task.sub_tasks.length > 0;
  const isClosed = task.state === "closed";

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: 12,
          paddingTop: 2,
          paddingBottom: 2,
          paddingLeft: depth * 20,
          minWidth: 0,
        }}
      >
        {hasChildren ? (
          <button
            onClick={() => setCollapsed((c) => !c)}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: 0,
              fontSize: 10,
              width: 14,
              flexShrink: 0,
              color: "var(--color-text-muted)",
            }}
          >
            {collapsed ? "▶" : "▼"}
          </button>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}

        <span
          style={{
            color: isClosed ? "var(--color-complete)" : "var(--color-in-progress)",
            flexShrink: 0,
          }}
        >
          ●
        </span>

        {task.github_issue != null && (
          <button
            onClick={() => onSelectTask(taskId)}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: 0,
              fontSize: 12,
              color: "var(--color-info)",
              flexShrink: 0,
            }}
          >
            #{task.github_issue}
          </button>
        )}

        <button
          onClick={() => onSelectTask(taskId)}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
            border: "none",
            background: "none",
            padding: 0,
            font: "inherit",
            fontSize: 12,
            cursor: "pointer",
            textAlign: "left",
            color: "inherit",
          }}
        >
          {task.title}
        </button>

        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 3,
            flexShrink: 0,
            background: isClosed ? "var(--color-complete-bg)" : "var(--color-border-light)",
          }}
        >
          {isClosed ? "Closed" : "Open"}
        </span>
      </div>

      {hasChildren &&
        !collapsed &&
        task.sub_tasks.map((childId) => (
          <SubTaskNode
            key={childId}
            taskId={childId}
            taskMap={taskMap}
            depth={depth + 1}
            onSelectTask={onSelectTask}
          />
        ))}
    </>
  );
}

export function DetailSubTasks({ subTaskIds, allTasks, onSelectTask }: DetailSubTasksProps) {
  if (subTaskIds.length === 0) return null;

  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.id, t]));

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "var(--color-text-muted)",
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        Sub-tasks ({subTaskIds.length})
      </div>
      {subTaskIds.map((id) => (
        <SubTaskNode key={id} taskId={id} taskMap={taskMap} depth={0} onSelectTask={onSelectTask} />
      ))}
    </div>
  );
}
