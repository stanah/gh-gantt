import React, { useState } from "react";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (editing) {
    return (
      <div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: "100%", minHeight: 120, padding: 8, fontSize: 12, fontFamily: "monospace", border: "1px solid #ccc", borderRadius: 4, resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <button
            onClick={() => { onChange(draft); setEditing(false); }}
            style={{ padding: "4px 12px", fontSize: 11, border: "1px solid #27AE60", borderRadius: 3, background: "#27AE60", color: "#fff", cursor: "pointer" }}
          >
            Save
          </button>
          <button
            onClick={() => { setDraft(value); setEditing(false); }}
            style={{ padding: "4px 12px", fontSize: 11, border: "1px solid #ccc", borderRadius: 3, background: "#fff", cursor: "pointer" }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => { setDraft(value); setEditing(true); }}
      style={{ padding: 8, fontSize: 12, background: "#fafafa", borderRadius: 4, cursor: "pointer", minHeight: 40, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    >
      {value || <span style={{ color: "#999" }}>Click to edit...</span>}
    </div>
  );
}
