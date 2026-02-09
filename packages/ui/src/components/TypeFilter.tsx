import React from "react";
import type { TaskType } from "../types/index.js";

interface TypeFilterProps {
  taskTypes: Record<string, TaskType>;
  enabled: Set<string>;
  onToggle: (typeName: string) => void;
}

export function TypeFilter({ taskTypes, enabled, onToggle }: TypeFilterProps) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 0" }}>
      {Object.entries(taskTypes).map(([name, def]) => (
        <button
          key={name}
          onClick={() => onToggle(name)}
          style={{
            padding: "2px 8px",
            fontSize: 11,
            borderRadius: 3,
            border: `1px solid ${def.color}`,
            background: enabled.has(name) ? def.color + "22" : "transparent",
            color: enabled.has(name) ? def.color : "#999",
            cursor: "pointer",
            opacity: enabled.has(name) ? 1 : 0.5,
          }}
        >
          {def.label}
        </button>
      ))}
    </div>
  );
}
