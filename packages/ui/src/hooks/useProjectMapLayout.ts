import { useCallback, useState } from "react";
import {
  applyProjectMapLayoutPreset,
  defaultProjectMapLayoutSettings,
  moveProjectMapPanel,
  parseProjectMapLayoutSettings,
  setProjectMapPanelSize,
  setProjectMapPanelVisible,
  type ProjectMapLayoutPresetId,
  type ProjectMapLayoutSettings,
  type ProjectMapPanelId,
  type ProjectMapPanelSize,
} from "@gh-gantt/shared";

export const PROJECT_MAP_LAYOUT_STORAGE_KEY = "gh-gantt:project-map-layout";

function readSettings(): ProjectMapLayoutSettings {
  if (typeof window === "undefined") return defaultProjectMapLayoutSettings();
  try {
    const raw = window.localStorage.getItem(PROJECT_MAP_LAYOUT_STORAGE_KEY);
    if (!raw) return defaultProjectMapLayoutSettings();
    return parseProjectMapLayoutSettings(JSON.parse(raw) as unknown);
  } catch {
    // JSON 破損や localStorage 不可の場合は既定構成にフォールバックする。
    return defaultProjectMapLayoutSettings();
  }
}

function writeSettings(settings: ProjectMapLayoutSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECT_MAP_LAYOUT_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage が使えない環境でも UI 状態は維持する。
  }
}

/**
 * Project Map のパネル構成（表示 / 非表示・並び順・サイズ）を管理するフック。
 * useFilterPresets と同様に、Zod 検証を通した値だけを localStorage から復元する。
 */
export function useProjectMapLayout() {
  const [settings, setSettings] = useState<ProjectMapLayoutSettings>(readSettings);

  const replace = useCallback((next: ProjectMapLayoutSettings) => {
    setSettings(next);
    writeSettings(next);
  }, []);

  const setPanelVisible = useCallback(
    (id: ProjectMapPanelId, visible: boolean) =>
      replace(setProjectMapPanelVisible(settings, id, visible)),
    [replace, settings],
  );

  const setPanelSize = useCallback(
    (id: ProjectMapPanelId, size: ProjectMapPanelSize) =>
      replace(setProjectMapPanelSize(settings, id, size)),
    [replace, settings],
  );

  const movePanel = useCallback(
    (id: ProjectMapPanelId, direction: "up" | "down") =>
      replace(moveProjectMapPanel(settings, id, direction)),
    [replace, settings],
  );

  const applyPreset = useCallback(
    (preset: ProjectMapLayoutPresetId) => replace(applyProjectMapLayoutPreset(preset)),
    [replace],
  );

  const resetToDefault = useCallback(() => replace(defaultProjectMapLayoutSettings()), [replace]);

  return { settings, setPanelVisible, setPanelSize, movePanel, applyPreset, resetToDefault };
}
