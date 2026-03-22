// packages/ui/src/components/toolbar/FilterGroup.tsx
import React from "react";
import { Eye, EyeOff } from "lucide-react";
import type { TaskType } from "../../types/index.js";
import { ToolbarGroup } from "./ToolbarGroup.js";
import { IconButton } from "./IconButton.js";
import { TypeFilter } from "../TypeFilter.js";
import { AssigneeFilter } from "../AssigneeFilter.js";
import { PriorityFilter } from "../PriorityFilter.js";

interface FilterGroupProps {
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
}

export function FilterGroup(props: FilterGroupProps) {
  const {
    hideClosed, onToggleHideClosed,
    taskTypes, enabledTypes, onToggleType,
    selectedAssignee, allAssignees, onSelectAssignee,
    selectedPriorities, onSelectPriorities,
  } = props;

  const selectedAssignees = selectedAssignee
    ? selectedAssignee.split(",").map((v) => v.trim()).filter((v) => v.length > 0)
    : [];

  const allTypesCount = Object.keys(taskTypes).length;

  return (
    <ToolbarGroup label="Filter" gap={4}>
      <IconButton
        icon={hideClosed ? <EyeOff size={14} /> : <Eye size={14} />}
        title="Hide Closed Tasks"
        onClick={onToggleHideClosed}
        active={hideClosed}
      />
      {allTypesCount > 0 && (
        <TypeFilter taskTypes={taskTypes} enabled={enabledTypes} onToggle={onToggleType} />
      )}
      <AssigneeFilter
        assignees={allAssignees}
        selectedValues={selectedAssignees}
        onChange={(values) => onSelectAssignee(values.length > 0 ? values.join(",") : null)}
      />
      {selectedPriorities && onSelectPriorities && (
        <PriorityFilter selectedValues={selectedPriorities} onChange={onSelectPriorities} />
      )}
    </ToolbarGroup>
  );
}
