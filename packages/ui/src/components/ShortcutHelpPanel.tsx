import React from "react";

interface ShortcutHelpPanelProps {
  open: boolean;
  onClose: () => void;
  items?: Array<{ keys: string; description: string }>;
}

const shortcuts = [
  { keys: "j / k", description: "選択中のタスクを上下に移動" },
  { keys: "Space", description: "選択中タスクの折りたたみを切り替え" },
  { keys: "Ctrl+K / Cmd+K", description: "検索ボックスにフォーカス" },
  { keys: "Ctrl+Z / Cmd+Z", description: "直前の操作を元に戻す (Undo)" },
  { keys: "Ctrl+Shift+Z / Cmd+Shift+Z", description: "取り消した操作をやり直す (Redo)" },
  { keys: "?", description: "このヘルプを開閉" },
  { keys: "Esc", description: "ヘルプを閉じる" },
];

export function ShortcutHelpPanel({ open, onClose, items = shortcuts }: ShortcutHelpPanelProps) {
  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9997,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(15, 23, 42, 0.24)",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 420,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 16,
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "18px 20px 12px",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.08em",
                color: "var(--color-text-muted)",
                textTransform: "uppercase",
              }}
            >
              Keyboard
            </div>
            <h2 style={{ margin: "4px 0 0", fontSize: 18, color: "var(--color-text)" }}>
              ショートカット一覧
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              fontSize: 22,
              lineHeight: 1,
              color: "var(--color-text-secondary)",
              cursor: "pointer",
            }}
            aria-label="Close shortcuts"
          >
            ×
          </button>
        </div>

        <div style={{ padding: 20, display: "grid", gap: 10 }}>
          {items.map((shortcut) => (
            <div
              key={shortcut.keys}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 12,
                background: "var(--color-bg)",
                border: "1px solid var(--color-border-light)",
              }}
            >
              <span style={{ fontSize: 13, color: "var(--color-text)" }}>
                {shortcut.description}
              </span>
              <kbd
                style={{
                  fontSize: 12,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  padding: "4px 8px",
                  borderRadius: 8,
                  background: "var(--color-hover-bg)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                {shortcut.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
