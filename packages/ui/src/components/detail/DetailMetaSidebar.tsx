import React from "react";
import type { Task, Config } from "../../types/index.js";

interface DetailMetaSidebarProps {
  task: Task;
  config: Config;
  onUpdate: (updates: Partial<Task>) => void;
  isMilestone: boolean;
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
};

const dateInputStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  width: "100%",
};

const separatorStyle: React.CSSProperties = {
  paddingTop: 10,
  borderTop: "1px solid var(--color-border-light)",
};

export function DetailMetaSidebar({ task, config, onUpdate, isMilestone }: DetailMetaSidebarProps) {
  const statusFieldName = config.statuses.field_name;
  const currentStatus = task.custom_fields[statusFieldName] as string | undefined;
  const statusOptions = Object.keys(config.statuses.values);
  const priorityFieldName = config.sync?.field_mapping?.priority;
  const rawPriority = priorityFieldName ? task.custom_fields[priorityFieldName] : undefined;
  const currentPriority = typeof rawPriority === "string" ? rawPriority.toLowerCase() : "";

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Status (non-milestone only) */}
      {!isMilestone && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Status</label>
          <select
            value={currentStatus ?? ""}
            onChange={(e) =>
              onUpdate({
                custom_fields: { ...task.custom_fields, [statusFieldName]: e.target.value },
              })
            }
            style={selectStyle}
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Priority (non-milestone only, if field_mapping.priority exists) */}
      {!isMilestone && priorityFieldName && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Priority</label>
          <select
            value={currentPriority}
            onChange={(e) =>
              onUpdate({
                custom_fields: {
                  ...task.custom_fields,
                  [priorityFieldName]: e.target.value || undefined,
                },
              })
            }
            style={selectStyle}
          >
            <option value="">None</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      )}

      {/* Type (non-milestone only) */}
      {!isMilestone && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Type</label>
          <select
            value={task.type}
            onChange={(e) => onUpdate({ type: e.target.value })}
            style={selectStyle}
          >
            {Object.entries(config.task_types)
              .filter(([name]) => name !== "milestone")
              .map(([name, def]) => (
                <option key={name} value={name}>
                  {def.label}
                </option>
              ))}
          </select>
        </div>
      )}

      {/* Dates (with separator) */}
      <div style={separatorStyle}>
        {isMilestone ? (
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Due Date</label>
            <input
              type="date"
              value={(task.date ?? "").slice(0, 10)}
              onChange={(e) => onUpdate({ date: e.target.value || null })}
              style={dateInputStyle}
            />
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Start Date</label>
              <input
                type="date"
                value={(task.start_date ?? "").slice(0, 10)}
                onChange={(e) => onUpdate({ start_date: e.target.value || null })}
                style={dateInputStyle}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>End Date</label>
              <input
                type="date"
                value={(task.end_date ?? "").slice(0, 10)}
                onChange={(e) => onUpdate({ end_date: e.target.value || null })}
                style={dateInputStyle}
              />
            </div>
          </>
        )}
      </div>

      {/* Assignees (with separator) */}
      <div style={{ ...separatorStyle, marginBottom: 14 }}>
        <label style={labelStyle}>Assignees</label>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {task.assignees.length === 0 ? (
            <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>None</span>
          ) : (
            task.assignees.map((a) => (
              <span
                key={a}
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  background: "var(--color-selected-bg)",
                  borderRadius: 12,
                }}
              >
                {a}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Labels */}
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>Labels</label>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {task.labels.length === 0 ? (
            <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>None</span>
          ) : (
            task.labels.map((l) => (
              <span
                key={l}
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  background: "var(--color-border-light)",
                  borderRadius: 3,
                }}
              >
                {l}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Milestone */}
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>Milestone</label>
        <span style={{ fontSize: 12 }}>
          {task.milestone ?? (
            <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>None</span>
          )}
        </span>
      </div>
    </div>
  );
}
