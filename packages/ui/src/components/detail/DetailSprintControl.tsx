import React from "react";
import type { Config, SprintConfig, Task } from "../../types/index.js";

interface DetailSprintControlProps {
  task: Task;
  config: Config;
  onUpdate: (updates: Partial<Task>) => void;
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-muted)",
  marginBottom: 4,
  fontWeight: 600,
  display: "block",
};

const selectStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  width: "100%",
  background: "var(--color-bg)",
  color: "var(--color-text)",
};

function isTaskInSprint(task: Task, sprint: SprintConfig): boolean {
  return Boolean(
    task.start_date &&
    task.end_date &&
    task.start_date >= sprint.start_date &&
    task.end_date <= sprint.end_date,
  );
}

export function findTaskSprint(task: Task, sprints: SprintConfig[]): SprintConfig | undefined {
  return sprints.find((sprint) => isTaskInSprint(task, sprint));
}

export function DetailSprintControl({ task, config, onUpdate }: DetailSprintControlProps) {
  const sprints = config.sprints ?? [];
  if (sprints.length === 0) return null;

  const selectedSprint = findTaskSprint(task, sprints);

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>Sprint</label>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          aria-label="Sprint"
          value={selectedSprint?.name ?? ""}
          onChange={(e) => {
            const sprint = sprints.find((candidate) => candidate.name === e.target.value);
            if (!sprint) return;
            onUpdate({
              start_date: sprint.start_date,
              end_date: sprint.end_date,
            });
          }}
          style={selectStyle}
        >
          <option value="">Custom / Backlog</option>
          {sprints.map((sprint) => (
            <option key={sprint.name} value={sprint.name}>
              {sprint.name}
            </option>
          ))}
        </select>
        {selectedSprint && (
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 10,
              flexShrink: 0,
              borderRadius: 2,
              background: selectedSprint.color,
              border: "1px solid var(--color-border)",
            }}
          />
        )}
      </div>
    </div>
  );
}
