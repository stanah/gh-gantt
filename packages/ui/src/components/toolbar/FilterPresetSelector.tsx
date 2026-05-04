import React from "react";
import { Bookmark, Pencil, Plus, Save, Trash2, XCircle } from "lucide-react";
import type { FilterPreset } from "../../hooks/useFilterPresets.js";
import { IconButton } from "./IconButton.js";

interface FilterPresetSelectorProps {
  presets: FilterPreset[];
  selectedPresetId: string | null;
  onApplyPreset: (id: string) => void;
  onSavePreset: (name: string) => void;
  onUpdatePreset: (id: string) => void;
  onRenamePreset: (id: string, name: string) => void;
  onDeletePreset: (id: string) => void;
  onClearFilters: () => void;
}

const selectStyle: React.CSSProperties = {
  minHeight: 24,
  width: 142,
  border: "1px solid var(--color-border)",
  borderRadius: 3,
  background: "var(--color-bg)",
  color: "var(--color-text)",
  fontSize: 11,
  padding: "3px 6px",
};

export function FilterPresetSelector({
  presets,
  selectedPresetId,
  onApplyPreset,
  onSavePreset,
  onUpdatePreset,
  onRenamePreset,
  onDeletePreset,
  onClearFilters,
}: FilterPresetSelectorProps) {
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null;

  const promptForName = (message: string, initialValue = "") => {
    const name = window.prompt(message, initialValue);
    return name?.trim() ? name.trim() : null;
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <Bookmark size={13} color="var(--color-text-secondary)" />
      <select
        aria-label="Filter preset"
        value={selectedPresetId ?? ""}
        onChange={(e) => {
          if (e.target.value) onApplyPreset(e.target.value);
        }}
        style={selectStyle}
      >
        <option value="">Preset...</option>
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.name}
          </option>
        ))}
      </select>
      <IconButton
        icon={<Plus size={13} />}
        title="Save Filter Preset"
        onClick={() => {
          const name = promptForName("Preset name");
          if (name) onSavePreset(name);
        }}
      />
      <IconButton
        icon={<Save size={13} />}
        title="Update Filter Preset"
        disabled={!selectedPreset}
        onClick={() => {
          if (selectedPreset) onUpdatePreset(selectedPreset.id);
        }}
      />
      <IconButton
        icon={<Pencil size={13} />}
        title="Rename Filter Preset"
        disabled={!selectedPreset}
        onClick={() => {
          if (!selectedPreset) return;
          const name = promptForName("Preset name", selectedPreset.name);
          if (name) onRenamePreset(selectedPreset.id, name);
        }}
      />
      <IconButton
        icon={<Trash2 size={13} />}
        title="Delete Filter Preset"
        disabled={!selectedPreset}
        onClick={() => {
          if (!selectedPreset) return;
          if (window.confirm(`Delete preset "${selectedPreset.name}"?`)) {
            onDeletePreset(selectedPreset.id);
          }
        }}
      />
      <IconButton icon={<XCircle size={13} />} title="Clear All Filters" onClick={onClearFilters} />
    </div>
  );
}
