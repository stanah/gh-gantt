// packages/ui/src/components/toolbar/Toolbar.tsx
import React from "react";
import { ArrowDownUp, GitBranch } from "lucide-react";
import type { DisplayOption } from "../../hooks/useDisplayOptions.js";
import type { TaskSortMode } from "../../hooks/useTaskTree.js";
import type { SprintConfig, ViewScale } from "@gh-gantt/shared";
import type { TaskType } from "../../types/index.js";
import { ZoomGroup } from "./ZoomGroup.js";
import { FilterGroup } from "./FilterGroup.js";
import { SearchBox } from "./SearchBox.js";
import { UndoRedoGroup } from "./UndoRedoGroup.js";
import { SyncGroup } from "./SyncGroup.js";
import { MoreMenu } from "./MoreMenu.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { IconButton } from "./IconButton.js";
import { CalendarSettingsMenu } from "./CalendarSettingsMenu.js";
import type { CalendarHoliday } from "../../types/index.js";
import type { HolidayPreset } from "../../lib/holiday-presets.js";

interface ToolbarProps {
  projectName: string;
  taskCount: number;
  activeScale: ViewScale;
  onScaleChange: (scale: ViewScale) => void;
  onScrollToToday: () => void;
  onPull: () => void;
  onPush: () => void;
  syncing: "pull" | "push" | null;
  lastSyncedAt?: string;
  displayOptions: Set<DisplayOption>;
  onToggleDisplayOption: (opt: DisplayOption) => void;
  dependencyHighlightEnabled: boolean;
  onToggleDependencyHighlight: () => void;
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
  labelGroupingPrefix?: string;
  labelGroupingEnabled?: boolean;
  onToggleLabelGrouping?: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  taskSortMode: TaskSortMode;
  onTaskSortModeChange: (mode: TaskSortMode) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  onOpenShortcuts?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoCount?: number;
  redoCount?: number;
  undoRedoBusy?: boolean;
  configuredHolidays?: CalendarHoliday[];
  holidayPresetOptions?: HolidayPreset[];
  selectedHolidayPresetId?: string;
  presetHolidays?: CalendarHoliday[];
  onSelectHolidayPreset?: (presetId: string) => void;
  customDaysOff?: CalendarHoliday[];
  onAddCustomDayOff?: (day: CalendarHoliday) => void;
  onRemoveCustomDayOff?: (date: string) => void;
}

const taskSortOptions: Array<{ value: TaskSortMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "updated_at_asc", label: "Updated ↑" },
  { value: "updated_at_desc", label: "Updated ↓" },
];

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
        activeScale={props.activeScale}
        onScaleChange={props.onScaleChange}
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
        labelGroupingPrefix={props.labelGroupingPrefix}
        labelGroupingEnabled={props.labelGroupingEnabled}
        onToggleLabelGrouping={props.onToggleLabelGrouping}
      />
      <SearchBox
        searchQuery={props.searchQuery}
        onSearchChange={props.onSearchChange}
        searchInputRef={props.searchInputRef}
      />
      <label
        title="Task sort"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: "var(--color-text-secondary)",
          whiteSpace: "nowrap",
        }}
      >
        <ArrowDownUp size={13} />
        <select
          aria-label="Task sort"
          value={props.taskSortMode}
          onChange={(e) => props.onTaskSortModeChange(e.target.value as TaskSortMode)}
          style={{
            padding: "3px 6px",
            border: "1px solid var(--color-border)",
            borderRadius: 3,
            fontSize: 11,
            minHeight: 24,
            background: "var(--color-bg)",
            color: "var(--color-text)",
          }}
        >
          {taskSortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
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
      <IconButton
        icon={<GitBranch size={14} />}
        title="Dependency Highlight"
        onClick={props.onToggleDependencyHighlight}
        active={props.dependencyHighlightEnabled}
      />
      {props.onAddCustomDayOff && props.onRemoveCustomDayOff && (
        <CalendarSettingsMenu
          configuredHolidays={props.configuredHolidays ?? []}
          holidayPresetOptions={props.holidayPresetOptions}
          selectedHolidayPresetId={props.selectedHolidayPresetId}
          presetHolidays={props.presetHolidays}
          onSelectHolidayPreset={props.onSelectHolidayPreset}
          customDaysOff={props.customDaysOff ?? []}
          onAddCustomDayOff={props.onAddCustomDayOff}
          onRemoveCustomDayOff={props.onRemoveCustomDayOff}
        />
      )}
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
