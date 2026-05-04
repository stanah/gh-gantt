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
  const stored = window.localStorage.getItem(HOLIDAY_PRESET_STORAGE_KEY);
  if (!stored || !isHolidayPresetId(stored)) return "none";
  return stored;
}

function writeStoredHolidayPresetId(presetId: HolidayPresetId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(HOLIDAY_PRESET_STORAGE_KEY, presetId);
}

export function useHolidayPreset() {
  const [selectedHolidayPresetId, setSelectedHolidayPresetId] =
    useState<HolidayPresetId>(readStoredHolidayPresetId);

  const selectHolidayPreset = useCallback((presetId: string) => {
    const nextPresetId = isHolidayPresetId(presetId) ? presetId : "none";
    setSelectedHolidayPresetId(nextPresetId);
    writeStoredHolidayPresetId(nextPresetId);
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
