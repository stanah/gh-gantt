import React from "react";
import { Tags } from "lucide-react";
import { TaskRow } from "./TaskRow.js";
import { FilterEmptyState, NoTasksGuide } from "./EmptyState.js";
import type { Config } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";
import type { DisplayOption } from "../hooks/useDisplayOptions.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";
import type { UseTreeDragDropReturn } from "../hooks/useTreeDragDrop.js";

export const ROW_HEIGHT = 28;

function GroupRow({
  node,
  isCollapsed,
  onToggle,
}: {
  node: TreeNode;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      data-group-id={node.task.id}
      tabIndex={0}
      role="button"
      aria-expanded={!isCollapsed}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onToggle();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: ROW_HEIGHT,
        padding: "3px 8px",
        borderBottom: "1px solid var(--color-border-light)",
        background: "var(--color-bg)",
        color: "var(--color-text-secondary)",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 16,
          textAlign: "center",
          fontSize: 10,
          color: "var(--color-text-muted)",
          flexShrink: 0,
        }}
      >
        {isCollapsed ? "\u25B6" : "\u25BC"}
      </span>
      <Tags size={13} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {node.group?.label ?? node.task.title}
      </span>
      <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-text-muted)" }}>
        {node.group?.taskCount ?? 0}
      </span>
    </div>
  );
}

interface TaskTreeHeaderProps {
  config: Config;
}

function getNodeKey(node: TreeNode): string {
  return node.renderKey ?? node.task.id;
}

export function TaskTreeHeader({ config }: TaskTreeHeaderProps) {
  const hasSprintBand = (config.sprints?.length ?? 0) > 0;
  const headerHeight = hasSprintBand ? 52 : 32;
  return (
    <div
      style={{
        paddingTop: hasSprintBand ? 20 : 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 8,
        borderBottom: "1px solid #e0e0e0",
        height: headerHeight,
        display: "flex",
        alignItems: "center",
        boxSizing: "border-box",
      }}
    />
  );
}

interface TaskTreeBodyProps {
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  flatList: TreeNode[];
  collapsed: Set<string>;
  onToggleCollapse: (taskId: string) => void;
  displayOptions?: Set<DisplayOption>;
  hoveredTaskId?: string | null;
  onHoverTask?: (taskId: string | null) => void;
  dependencyHighlightEnabled?: boolean;
  highlightedTaskIds?: Set<string>;
  highlightRelationMap?: Map<string, RelationType>;
  searchQuery?: string;
  dragState?: UseTreeDragDropReturn;
  totalTaskCount?: number;
  hasActiveFilters?: boolean;
  onResetFilters?: () => void;
}

export function TaskTreeBody({
  config,
  selectedTaskId,
  onSelectTask,
  flatList,
  collapsed,
  onToggleCollapse,
  displayOptions,
  hoveredTaskId,
  onHoverTask,
  dependencyHighlightEnabled = true,
  highlightedTaskIds,
  highlightRelationMap,
  searchQuery,
  dragState,
  totalTaskCount = 0,
  hasActiveFilters = false,
  onResetFilters,
}: TaskTreeBodyProps) {
  const renderRow = (node: TreeNode) => {
    if (node.kind === "group") {
      return (
        <GroupRow
          key={getNodeKey(node)}
          node={node}
          isCollapsed={collapsed.has(node.task.id)}
          onToggle={() => onToggleCollapse(node.task.id)}
        />
      );
    }

    return (
      <TaskRow
        key={getNodeKey(node)}
        task={node.task}
        depth={node.depth}
        hasChildren={node.children.length > 0}
        isCollapsed={collapsed.has(node.task.id)}
        onToggle={() => onToggleCollapse(node.task.id)}
        onClick={() => onSelectTask(node.task.id)}
        isSelected={selectedTaskId === node.task.id}
        isHovered={hoveredTaskId === node.task.id}
        onHover={onHoverTask}
        statusFieldName={config.statuses.field_name}
        statusValues={config.statuses.values}
        taskType={config.task_types[node.task.type]}
        showIssueId={displayOptions?.has("issueId")}
        showAssignees={displayOptions?.has("assignees")}
        showPriority={displayOptions?.has("priority")}
        priorityFieldName={config.sync?.field_mapping?.priority}
        atRiskThresholdDays={config.gantt.at_risk_threshold_days}
        highlightType={
          dependencyHighlightEnabled ? (highlightRelationMap?.get(node.task.id) ?? null) : null
        }
        isDimmed={
          dependencyHighlightEnabled &&
          hoveredTaskId != null &&
          hoveredTaskId !== node.task.id &&
          !highlightedTaskIds?.has(node.task.id)
        }
        searchQuery={searchQuery}
        draggable={!!dragState}
        isDragging={dragState?.draggedTaskId === node.task.id}
        dropIndicator={
          dragState?.dropIndicator?.targetTaskId === node.task.id ? dragState.dropIndicator : null
        }
        onDragStart={dragState ? (e) => dragState.handleDragStart(e, node.task.id) : undefined}
        onDragOver={dragState ? (e) => dragState.handleDragOver(e, node.task.id) : undefined}
        onDragLeave={dragState?.handleDragLeave}
        onDrop={dragState ? (e) => dragState.handleDrop(e, node.task.id) : undefined}
        onDragEnd={dragState?.handleDragEnd}
        scheduleState={node.scheduleState}
      />
    );
  };

  const isEmpty = flatList.length === 0;

  if (isEmpty && hasActiveFilters && onResetFilters) {
    return (
      <div>
        <FilterEmptyState onReset={onResetFilters} />
      </div>
    );
  }

  if (isEmpty && totalTaskCount === 0) {
    return (
      <div>
        <NoTasksGuide />
      </div>
    );
  }

  return (
    <div>
      {flatList.map(renderRow)}
      {dragState?.draggedTaskId && (
        <div
          onDragOver={dragState.handleRootDragOver}
          onDrop={dragState.handleRootDrop}
          style={{
            height: 32,
            border: "2px dashed #ccc",
            borderRadius: 4,
            margin: "4px 8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "#888",
            background:
              dragState.dropIndicator?.targetTaskId === "__root__" ? "#f0f4ff" : "transparent",
          }}
        >
          ルートレベルに移動
        </div>
      )}
    </div>
  );
}
