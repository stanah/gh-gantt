import { useCallback, useState } from "react";
import type { TaskSortMode } from "./useTaskTree.js";

export const FILTER_PRESETS_STORAGE_KEY = "gh-gantt:filter-presets";

export interface FilterPresetState {
  hideClosed: boolean;
  selectedAssignees: string[];
  selectedPriorities: string[];
  selectedLabels: string[];
  enabledTypes: string[];
  searchQuery: string;
  taskSortMode: TaskSortMode;
}

export interface FilterPreset {
  id: string;
  name: string;
  state: FilterPresetState;
}

interface UseFilterPresetsOptions {
  currentState: FilterPresetState;
  onApplyPreset: (state: FilterPresetState) => void;
}

function cloneState(state: FilterPresetState): FilterPresetState {
  return {
    hideClosed: state.hideClosed,
    selectedAssignees: [...state.selectedAssignees],
    selectedPriorities: [...state.selectedPriorities],
    selectedLabels: [...state.selectedLabels],
    enabledTypes: [...state.enabledTypes],
    searchQuery: state.searchQuery,
    taskSortMode: state.taskSortMode,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function taskSortMode(value: unknown): TaskSortMode {
  if (value === "updated_at_asc" || value === "updated_at_desc") return value;
  return "default";
}

function normalizeState(value: unknown): FilterPresetState | null {
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  return {
    hideClosed: record.hideClosed === true,
    selectedAssignees: stringArray(record.selectedAssignees),
    selectedPriorities: stringArray(record.selectedPriorities),
    selectedLabels: stringArray(record.selectedLabels),
    enabledTypes: stringArray(record.enabledTypes),
    searchQuery: typeof record.searchQuery === "string" ? record.searchQuery : "",
    taskSortMode: taskSortMode(record.taskSortMode),
  };
}

function normalizePreset(value: unknown): FilterPreset | null {
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  const state = normalizeState(record.state);
  if (!state) return null;
  return { id: record.id, name: record.name, state };
}

function readPresets(): FilterPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FILTER_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const preset = normalizePreset(item);
      return preset ? [preset] : [];
    });
  } catch {
    return [];
  }
}

function writePresets(presets: FilterPreset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FILTER_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // localStorage が使えない環境でも UI 状態は維持する。
  }
}

function createPresetId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `preset-${Date.now().toString(36)}`;
}

function cleanName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function useFilterPresets({ currentState, onApplyPreset }: UseFilterPresetsOptions) {
  const [presets, setPresets] = useState<FilterPreset[]>(readPresets);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  const replacePresets = useCallback((next: FilterPreset[]) => {
    setPresets(next);
    writePresets(next);
  }, []);

  const savePreset = useCallback(
    (name: string) => {
      const normalizedName = cleanName(name);
      if (!normalizedName) return;
      replacePresets([
        ...presets,
        { id: createPresetId(), name: normalizedName, state: cloneState(currentState) },
      ]);
    },
    [currentState, presets, replacePresets],
  );

  const applyPreset = useCallback(
    (id: string) => {
      const preset = presets.find((item) => item.id === id);
      if (!preset) return;
      setSelectedPresetId(id);
      onApplyPreset(cloneState(preset.state));
    },
    [onApplyPreset, presets],
  );

  const updatePreset = useCallback(
    (id: string, state: FilterPresetState = currentState) => {
      replacePresets(
        presets.map((preset) =>
          preset.id === id ? { ...preset, state: cloneState(state) } : preset,
        ),
      );
    },
    [currentState, presets, replacePresets],
  );

  const renamePreset = useCallback(
    (id: string, name: string) => {
      const normalizedName = cleanName(name);
      if (!normalizedName) return;
      replacePresets(
        presets.map((preset) => (preset.id === id ? { ...preset, name: normalizedName } : preset)),
      );
    },
    [presets, replacePresets],
  );

  const deletePreset = useCallback(
    (id: string) => {
      replacePresets(presets.filter((preset) => preset.id !== id));
      setSelectedPresetId((prev) => (prev === id ? null : prev));
    },
    [presets, replacePresets],
  );

  const clearSelectedPreset = useCallback(() => {
    setSelectedPresetId(null);
  }, []);

  return {
    presets,
    selectedPresetId,
    savePreset,
    applyPreset,
    updatePreset,
    renamePreset,
    deletePreset,
    clearSelectedPreset,
  };
}
