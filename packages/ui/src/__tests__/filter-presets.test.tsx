// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterPresetSelector } from "../components/toolbar/FilterPresetSelector.js";
import {
  FILTER_PRESETS_STORAGE_KEY,
  useFilterPresets,
  type FilterPreset,
  type FilterPresetState,
} from "../hooks/useFilterPresets.js";

const filterState: FilterPresetState = {
  hideClosed: true,
  selectedAssignees: ["stanah"],
  selectedPriorities: ["high"],
  selectedLabels: ["pkg:cli"],
  enabledTypes: ["task"],
  searchQuery: "cli",
  taskSortMode: "updated_at_desc",
};

const emptyFilterState: FilterPresetState = {
  hideClosed: false,
  selectedAssignees: [],
  selectedPriorities: [],
  selectedLabels: [],
  enabledTypes: ["task", "epic"],
  searchQuery: "",
  taskSortMode: "default",
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function PresetProbe({
  initialState = filterState,
  onApplyPreset = () => {},
}: {
  initialState?: FilterPresetState;
  onApplyPreset?: (state: FilterPresetState) => void;
}) {
  const [currentState, setCurrentState] = useState(initialState);
  const { presets, savePreset, applyPreset, updatePreset, renamePreset, deletePreset } =
    useFilterPresets({
      currentState,
      onApplyPreset,
    });

  return (
    <div>
      <output aria-label="preset count">{presets.length}</output>
      <output aria-label="preset names">{presets.map((preset) => preset.name).join(",")}</output>
      <button type="button" onClick={() => savePreset("自分のCLI")}>
        save
      </button>
      <button type="button" onClick={() => applyPreset("preset-1")}>
        apply
      </button>
      <button
        type="button"
        onClick={() => {
          setCurrentState(emptyFilterState);
          updatePreset("preset-1", emptyFilterState);
        }}
      >
        update
      </button>
      <button type="button" onClick={() => renamePreset("preset-1", "今週更新")}>
        rename
      </button>
      <button type="button" onClick={() => deletePreset("preset-1")}>
        delete
      </button>
    </div>
  );
}

describe("[FR-VIS-020-AC1] フィルタプリセットの localStorage 永続化", () => {
  it("現在のフィルタ状態を名前付きプリセットとして保存する", () => {
    const { getByText, getByLabelText } = render(<PresetProbe />);

    fireEvent.click(getByText("save"));

    expect(getByLabelText("preset count").textContent).toBe("1");
    const stored = JSON.parse(localStorage.getItem(FILTER_PRESETS_STORAGE_KEY) ?? "[]") as Array<{
      name: string;
      state: FilterPresetState;
    }>;
    expect(stored[0]).toMatchObject({
      name: "自分のCLI",
      state: filterState,
    });
  });

  it("保存済みプリセットを選択するとフィルタ状態を一括復元する", () => {
    localStorage.setItem(
      FILTER_PRESETS_STORAGE_KEY,
      JSON.stringify([{ id: "preset-1", name: "自分のCLI", state: filterState }]),
    );
    const onApplyPreset = vi.fn();
    const { getByText, getByLabelText } = render(
      <PresetProbe initialState={emptyFilterState} onApplyPreset={onApplyPreset} />,
    );

    expect(getByLabelText("preset names").textContent).toBe("自分のCLI");

    fireEvent.click(getByText("apply"));

    expect(onApplyPreset).toHaveBeenCalledWith(filterState);
  });

  it("プリセットの更新・名前変更・削除を localStorage に反映する", () => {
    localStorage.setItem(
      FILTER_PRESETS_STORAGE_KEY,
      JSON.stringify([{ id: "preset-1", name: "自分のCLI", state: filterState }]),
    );
    const { getByText } = render(<PresetProbe />);

    fireEvent.click(getByText("update"));
    let stored = JSON.parse(localStorage.getItem(FILTER_PRESETS_STORAGE_KEY) ?? "[]") as Array<{
      state: FilterPresetState;
    }>;
    expect(stored[0]?.state).toEqual(emptyFilterState);

    fireEvent.click(getByText("rename"));
    stored = JSON.parse(localStorage.getItem(FILTER_PRESETS_STORAGE_KEY) ?? "[]") as Array<{
      name: string;
    }>;
    expect(stored[0]?.name).toBe("今週更新");

    fireEvent.click(getByText("delete"));
    expect(localStorage.getItem(FILTER_PRESETS_STORAGE_KEY)).toBe("[]");
  });

  it("壊れた localStorage 値は空のプリセットとして扱う", () => {
    localStorage.setItem(FILTER_PRESETS_STORAGE_KEY, "not json");

    const { getByLabelText } = render(<PresetProbe />);

    expect(getByLabelText("preset count").textContent).toBe("0");
  });
});

describe("[FR-VIS-020-AC2] Toolbar のフィルタプリセット UI", () => {
  const preset: FilterPreset = {
    id: "preset-1",
    name: "自分のCLI",
    state: filterState,
  };

  it("ドロップダウンでプリセットを選択し、保存・更新・名前変更・削除・clear を実行できる", () => {
    const onApplyPreset = vi.fn();
    const onSavePreset = vi.fn();
    const onUpdatePreset = vi.fn();
    const onRenamePreset = vi.fn();
    const onDeletePreset = vi.fn();
    const onClearFilters = vi.fn();
    vi.spyOn(window, "prompt")
      .mockReturnValueOnce("新規プリセット")
      .mockReturnValueOnce("名前変更後");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    function SelectorHarness() {
      const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
      return (
        <FilterPresetSelector
          presets={[preset]}
          selectedPresetId={selectedPresetId}
          onApplyPreset={(id) => {
            setSelectedPresetId(id);
            onApplyPreset(id);
          }}
          onSavePreset={onSavePreset}
          onUpdatePreset={onUpdatePreset}
          onRenamePreset={onRenamePreset}
          onDeletePreset={onDeletePreset}
          onClearFilters={onClearFilters}
        />
      );
    }

    const { getByLabelText, getByTitle } = render(<SelectorHarness />);

    fireEvent.change(getByLabelText("Filter preset"), { target: { value: "preset-1" } });
    fireEvent.click(getByTitle("Save Filter Preset"));
    fireEvent.click(getByTitle("Update Filter Preset"));
    fireEvent.click(getByTitle("Rename Filter Preset"));
    fireEvent.click(getByTitle("Delete Filter Preset"));
    fireEvent.click(getByTitle("Clear All Filters"));

    expect(onApplyPreset).toHaveBeenCalledWith("preset-1");
    expect(onSavePreset).toHaveBeenCalledWith("新規プリセット");
    expect(onUpdatePreset).toHaveBeenCalledWith("preset-1");
    expect(onRenamePreset).toHaveBeenCalledWith("preset-1", "名前変更後");
    expect(onDeletePreset).toHaveBeenCalledWith("preset-1");
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
