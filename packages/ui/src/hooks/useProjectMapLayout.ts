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

  // 直前の state から次状態を導く関数型更新にし、同一イベント内の連続操作でも取りこぼさない。
  // 書き込みは純粋関数の結果に対して行うため、StrictMode の二重呼び出しでも同じ値を保存するだけで済む。
  const update = useCallback(
    (updater: (prev: ProjectMapLayoutSettings) => ProjectMapLayoutSettings) => {
      setSettings((prev) => {
        const next = updater(prev);
        writeSettings(next);
        return next;
      });
    },
    [],
  );

  const replace = useCallback((next: ProjectMapLayoutSettings) => update(() => next), [update]);

  const setPanelVisible = useCallback(
    (id: ProjectMapPanelId, visible: boolean) =>
      update((prev) => setProjectMapPanelVisible(prev, id, visible)),
    [update],
  );

  const setPanelSize = useCallback(
    (id: ProjectMapPanelId, size: ProjectMapPanelSize) =>
      update((prev) => setProjectMapPanelSize(prev, id, size)),
    [update],
  );

  const movePanel = useCallback(
    (id: ProjectMapPanelId, direction: "up" | "down") =>
      update((prev) => moveProjectMapPanel(prev, id, direction)),
    [update],
  );

  const applyPreset = useCallback(
    (preset: ProjectMapLayoutPresetId) => replace(applyProjectMapLayoutPreset(preset)),
    [replace],
  );

  const resetToDefault = useCallback(() => replace(defaultProjectMapLayoutSettings()), [replace]);

  return { settings, setPanelVisible, setPanelSize, movePanel, applyPreset, resetToDefault };
}
