// packages/ui/src/components/toolbar/Toolbar.tsx
import React from "react";
import type { DisplayOption } from "../../hooks/useDisplayOptions.js";
import type { SprintConfig } from "@gh-gantt/shared";
import type { TaskType } from "../../types/index.js";
import { ZoomGroup } from "./ZoomGroup.js";
import { FilterGroup } from "./FilterGroup.js";
import { SearchBox } from "./SearchBox.js";
import { UndoRedoGroup } from "./UndoRedoGroup.js";
import { SyncGroup } from "./SyncGroup.js";
import { MoreMenu } from "./MoreMenu.js";
import { ThemeToggle } from "./ThemeToggle.js";

interface ToolbarProps {
  projectName: string;
  taskCount: number;
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
  sprints?: SprintConfig[];
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
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 11,
      }}
    >
      <strong style={{ fontSize: 13, whiteSpace: "nowrap" }}>{props.projectName}</strong>
      <span style={{ color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
        {props.taskCount} tasks
      </span>
      <div
        style={{
          width: 1,
          height: 16,
          background: "var(--color-border)",
          flexShrink: 0,
        }}
      />
      <ZoomGroup
        onZoomIn={props.onZoomIn}
        onZoomOut={props.onZoomOut}
        onScrollToToday={props.onScrollToToday}
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
      <UndoRedoGroup
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        canUndo={props.canUndo}
        canRedo={props.canRedo}
        undoCount={props.undoCount}
        redoCount={props.redoCount}
        undoRedoBusy={props.undoRedoBusy}
      />
      <div style={{ flex: 1 }} />
      <MoreMenu
        displayOptions={props.displayOptions}
        onToggleDisplayOption={props.onToggleDisplayOption}
        taskTypes={props.taskTypes}
        sprints={props.sprints}
        onOpenShortcuts={props.onOpenShortcuts}
      />
      <ThemeToggle />
      <SyncGroup
        onPull={props.onPull}
        onPush={props.onPush}
        syncing={props.syncing}
        lastSyncedAt={props.lastSyncedAt}
      />
    </div>
  );
}
