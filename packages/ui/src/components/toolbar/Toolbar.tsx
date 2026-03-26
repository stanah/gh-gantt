// packages/ui/src/components/toolbar/Toolbar.tsx
import React from "react";
import { Keyboard } from "lucide-react";
import type { DisplayOption } from "../../hooks/useDisplayOptions.js";
import type { TaskType } from "../../types/index.js";
import { ZoomGroup } from "./ZoomGroup.js";
import { DisplayGroup } from "./DisplayGroup.js";
import { FilterGroup } from "./FilterGroup.js";
import { SearchBox } from "./SearchBox.js";
import { IconButton } from "./IconButton.js";
import { UndoRedoGroup } from "./UndoRedoGroup.js";
import { SyncGroup } from "./SyncGroup.js";
import { LegendGroup } from "./LegendGroup.js";

interface ToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onScrollToToday: () => void;
  onPull: () => void;
  onPush: () => void;
  syncing: "pull" | "push" | null;
  lastSyncedAt?: string;
  displayOptions: Set<DisplayOption>;
  onToggleDisplayOption: (opt: DisplayOption) => void;
  hideClosed: boolean;
  onToggleHideClosed: () => void;
  taskTypes: Record<string, TaskType>;
  enabledTypes: Set<string>;
  onToggleType: (typeName: string) => void;
  selectedAssignee: string | null;
  allAssignees: string[];
  onSelectAssignee: (assignee: string | null) => void;
  selectedPriorities?: string[];
  onSelectPriorities?: (values: string[]) => void;
  allLabels?: string[];
  selectedLabels?: string[];
  onSelectLabels?: (values: string[]) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  onOpenShortcuts?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoCount?: number;
  redoCount?: number;
  undoRedoBusy?: boolean;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <div
      style={{
        padding: "6px 16px",
        borderBottom: "1px solid #e0e0e0",
        background: "#fff",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 11,
      }}
    >
      <ZoomGroup
        onZoomIn={props.onZoomIn}
        onZoomOut={props.onZoomOut}
        onScrollToToday={props.onScrollToToday}
      />
      <DisplayGroup
        displayOptions={props.displayOptions}
        onToggleDisplayOption={props.onToggleDisplayOption}
      />
      <FilterGroup
        hideClosed={props.hideClosed}
        onToggleHideClosed={props.onToggleHideClosed}
        taskTypes={props.taskTypes}
        enabledTypes={props.enabledTypes}
        onToggleType={props.onToggleType}
        selectedAssignee={props.selectedAssignee}
        allAssignees={props.allAssignees}
        onSelectAssignee={props.onSelectAssignee}
        selectedPriorities={props.selectedPriorities}
        onSelectPriorities={props.onSelectPriorities}
        allLabels={props.allLabels}
        selectedLabels={props.selectedLabels}
        onSelectLabels={props.onSelectLabels}
      />
      <SearchBox
        searchQuery={props.searchQuery}
        onSearchChange={props.onSearchChange}
        searchInputRef={props.searchInputRef}
      />
      {props.onOpenShortcuts && (
        <IconButton
          icon={<Keyboard size={14} />}
          title="Keyboard Shortcuts (?)"
          onClick={props.onOpenShortcuts}
        />
      )}
      <UndoRedoGroup
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        canUndo={props.canUndo}
        canRedo={props.canRedo}
        undoCount={props.undoCount}
        redoCount={props.redoCount}
        undoRedoBusy={props.undoRedoBusy}
      />
      <LegendGroup taskTypes={props.taskTypes} />
      <div style={{ flex: 1 }} />
      <SyncGroup
        onPull={props.onPull}
        onPush={props.onPush}
        syncing={props.syncing}
        lastSyncedAt={props.lastSyncedAt}
      />
    </div>
  );
}
