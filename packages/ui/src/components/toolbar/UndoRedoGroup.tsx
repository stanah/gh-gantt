import React from "react";
import { Undo2, Redo2 } from "lucide-react";
import { IconButton } from "./IconButton.js";

interface UndoRedoGroupProps {
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoCount?: number;
  redoCount?: number;
  undoRedoBusy?: boolean;
}

export function UndoRedoGroup({
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  undoCount = 0,
  redoCount = 0,
  undoRedoBusy = false,
}: UndoRedoGroupProps) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      <IconButton
        icon={<Undo2 size={14} />}
        title={`Undo (⌘Z)${undoCount > 0 ? ` — ${undoCount}` : ""}`}
        onClick={onUndo}
        disabled={!onUndo || !canUndo || undoRedoBusy}
        badge={undoCount > 0 ? undoCount : undefined}
      />
      <IconButton
        icon={<Redo2 size={14} />}
        title={`Redo (⌘⇧Z)${redoCount > 0 ? ` — ${redoCount}` : ""}`}
        onClick={onRedo}
        disabled={!onRedo || !canRedo || undoRedoBusy}
        badge={redoCount > 0 ? redoCount : undefined}
      />
    </div>
  );
}
