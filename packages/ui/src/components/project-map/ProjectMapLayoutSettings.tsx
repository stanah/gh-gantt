import React from "react";
import {
  PROJECT_MAP_LAYOUT_PRESETS,
  PROJECT_MAP_PANEL_LABELS,
  PROJECT_MAP_PANEL_SIZES,
  PROJECT_MAP_PANEL_SIZE_LABELS,
  matchProjectMapLayoutPreset,
  type ProjectMapLayoutPresetId,
  type ProjectMapLayoutSettings,
  type ProjectMapPanelId,
  type ProjectMapPanelSize,
} from "@gh-gantt/shared";

interface ProjectMapLayoutSettingsProps {
  settings: ProjectMapLayoutSettings;
  onSetPanelVisible: (id: ProjectMapPanelId, visible: boolean) => void;
  onSetPanelSize: (id: ProjectMapPanelId, size: ProjectMapPanelSize) => void;
  onMovePanel: (id: ProjectMapPanelId, direction: "up" | "down") => void;
  onApplyPreset: (preset: ProjectMapLayoutPresetId) => void;
  onReset: () => void;
}

const PRESET_IDS = new Set<string>(PROJECT_MAP_LAYOUT_PRESETS.map((p) => p.id));

const controlStyle: React.CSSProperties = {
  padding: "2px 6px",
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  fontSize: 11,
  minHeight: 22,
  background: "var(--color-bg)",
  color: "var(--color-text)",
};

const iconButtonStyle: React.CSSProperties = {
  ...controlStyle,
  cursor: "pointer",
  padding: "0 6px",
  lineHeight: 1,
};

/**
 * Project Map のパネル構成を編集するインライン設定 UI。
 * プリセット選択、パネルごとの表示 / サイズ / 並び順、既定に戻す操作を提供する。
 */
export function ProjectMapLayoutSettings({
  settings,
  onSetPanelVisible,
  onSetPanelSize,
  onMovePanel,
  onApplyPreset,
  onReset,
}: ProjectMapLayoutSettingsProps) {
  const presetValue = matchProjectMapLayoutPreset(settings) ?? "custom";
  const last = settings.panels.length - 1;

  return (
    <div
      data-testid="project-map-layout-settings"
      role="region"
      aria-label="パネル構成の設定"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        padding: "6px 10px",
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        fontSize: 11,
      }}
    >
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ color: "var(--color-text-muted)" }}>プリセット</span>
        <select
          aria-label="レイアウトプリセット"
          value={presetValue}
          onChange={(e) => {
            const value = e.target.value;
            if (PRESET_IDS.has(value)) onApplyPreset(value as ProjectMapLayoutPresetId);
          }}
          style={controlStyle}
        >
          {presetValue === "custom" && (
            <option value="custom" disabled>
              カスタム
            </option>
          )}
          {PROJECT_MAP_LAYOUT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id} title={preset.description}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <ul
        aria-label="パネル一覧"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        {settings.panels.map((panel, index) => {
          const label = PROJECT_MAP_PANEL_LABELS[panel.id];
          return (
            <li
              key={panel.id}
              data-panel-setting={panel.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 6px",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                opacity: panel.visible ? 1 : 0.6,
              }}
            >
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  aria-label={`${label} を表示`}
                  checked={panel.visible}
                  onChange={(e) => onSetPanelVisible(panel.id, e.target.checked)}
                />
                <span>{label}</span>
              </label>
              <select
                aria-label={`${label} のサイズ`}
                value={panel.size}
                onChange={(e) => onSetPanelSize(panel.id, e.target.value as ProjectMapPanelSize)}
                style={controlStyle}
              >
                {PROJECT_MAP_PANEL_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {PROJECT_MAP_PANEL_SIZE_LABELS[size]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`${label} を上へ`}
                title="上へ"
                disabled={index === 0}
                onClick={() => onMovePanel(panel.id, "up")}
                style={iconButtonStyle}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`${label} を下へ`}
                title="下へ"
                disabled={index === last}
                onClick={() => onMovePanel(panel.id, "down")}
                style={iconButtonStyle}
              >
                ↓
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={onReset} style={{ ...controlStyle, cursor: "pointer" }}>
        既定に戻す
      </button>
    </div>
  );
}
