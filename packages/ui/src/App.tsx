import React, { useState } from "react";
import { useApi } from "./hooks/useApi.js";
import { Layout } from "./components/Layout.js";
import type { Task } from "./types/index.js";

export function App() {
  const { config, tasks, cache, loading, error, refresh, updateTask } = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#888" }}>
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#e74c3c" }}>
        Error: {error}
      </div>
    );
  }

  if (!config) return null;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "8px 16px", borderBottom: "1px solid #e0e0e0", background: "#fff", display: "flex", alignItems: "center", gap: 12 }}>
        <strong>{config.project.name}</strong>
        <span style={{ color: "#888", fontSize: 12 }}>{tasks.length} tasks</span>
      </header>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Layout
          left={
            <div style={{ padding: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Tasks</div>
              {tasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  style={{
                    padding: "4px 8px",
                    cursor: "pointer",
                    background: selectedTaskId === task.id ? "#e8f0fe" : "transparent",
                    borderRadius: 4,
                  }}
                >
                  {task.title}
                </div>
              ))}
            </div>
          }
          right={
            <div style={{ padding: 16, color: "#888" }}>
              Gantt timeline (coming soon)
            </div>
          }
        />
      </div>
    </div>
  );
}
