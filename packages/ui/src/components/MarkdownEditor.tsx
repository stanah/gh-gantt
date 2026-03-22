import React, { useEffect, useMemo, useState } from "react";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  renderPreview?: (value: string) => React.ReactNode;
}

type Mode = "edit" | "preview";

export function MarkdownEditor({ value, onChange, renderPreview }: MarkdownEditorProps) {
  const [mode, setMode] = useState<Mode>(value.trim() ? "preview" : "edit");
  const [draft, setDraft] = useState(value);
  const dirty = draft !== value;

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const previewNode = useMemo(() => {
    if (!draft.trim()) return <span style={{ color: "#999" }}>No description</span>;
    if (renderPreview) return renderPreview(draft);
    return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{draft}</div>;
  }, [draft, renderPreview]);

  const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    border: "1px solid #ccc",
    borderRadius: 4,
    background: active ? "#333" : "#fff",
    color: active ? "#fff" : "#333",
    cursor: "pointer",
    fontSize: 11,
  });

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => setMode("edit")} style={tabButtonStyle(mode === "edit")}>
            Edit
          </button>
          <button onClick={() => setMode("preview")} style={tabButtonStyle(mode === "preview")}>
            Preview
          </button>
        </div>
        {dirty && <span style={{ fontSize: 10, color: "#b45309" }}>Unsaved</span>}
      </div>

      {mode === "edit" ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{
            width: "100%",
            minHeight: 140,
            padding: 8,
            fontSize: 12,
            fontFamily: "monospace",
            border: "1px solid #ccc",
            borderRadius: 4,
            resize: "vertical",
          }}
        />
      ) : (
        <div
          style={{
            padding: 8,
            fontSize: 12,
            background: "#fafafa",
            borderRadius: 4,
            border: "1px solid #eee",
            minHeight: 40,
          }}
        >
          {previewNode}
        </div>
      )}

      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        <button
          onClick={() => {
            onChange(draft);
            setMode("preview");
          }}
          disabled={!dirty}
          style={{
            padding: "4px 12px",
            fontSize: 11,
            border: "1px solid #27AE60",
            borderRadius: 3,
            background: dirty ? "#27AE60" : "#a7d9b8",
            color: "#fff",
            cursor: dirty ? "pointer" : "default",
          }}
        >
          Save
        </button>
        <button
          onClick={() => {
            setDraft(value);
            setMode("preview");
          }}
          disabled={!dirty}
          style={{
            padding: "4px 12px",
            fontSize: 11,
            border: "1px solid #ccc",
            borderRadius: 3,
            background: "#fff",
            cursor: dirty ? "pointer" : "default",
            opacity: dirty ? 1 : 0.6,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
