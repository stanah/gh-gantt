import { useCallback, useMemo, useState } from "react";
import {
  getHolidayPreset,
  HOLIDAY_PRESETS,
  isHolidayPresetId,
  type HolidayPresetId,
} from "../lib/holiday-presets.js";

export const HOLIDAY_PRESET_STORAGE_KEY = "gh-gantt:holiday-preset";

function readStoredHolidayPresetId(): HolidayPresetId {
  if (typeof window === "undefined") return "none";
  try {
    const stored = window.localStorage.getItem(HOLIDAY_PRESET_STORAGE_KEY);
    if (!stored || !isHolidayPresetId(stored)) return "none";
    return stored;
  } catch {
    return "none";
  }
}

function writeStoredHolidayPresetId(presetId: HolidayPresetId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOLIDAY_PRESET_STORAGE_KEY, presetId);
  } catch {
    // 永続化できない環境では、メモリ上の選択状態だけを維持する。
  }
}

export function useHolidayPreset() {
  const [selectedHolidayPresetId, setSelectedHolidayPresetId] =
    useState<HolidayPresetId>(readStoredHolidayPresetId);

  const selectHolidayPreset = useCallback((presetId: HolidayPresetId) => {
    setSelectedHolidayPresetId(presetId);
    writeStoredHolidayPresetId(presetId);
  }, []);

  const selectedHolidayPreset = useMemo(
    () => getHolidayPreset(selectedHolidayPresetId),
    [selectedHolidayPresetId],
  );

  return {
    holidayPresetOptions: HOLIDAY_PRESETS,
    selectedHolidayPresetId,
    selectedHolidayPreset,
    presetHolidays: selectedHolidayPreset.holidays,
    selectHolidayPreset,
  };
}
