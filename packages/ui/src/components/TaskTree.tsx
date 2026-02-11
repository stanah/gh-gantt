import React from "react";
import { TaskRow } from "./TaskRow.js";
import { TypeFilter } from "./TypeFilter.js";
import { BacklogSectionHeader } from "./BacklogSectionHeader.js";
import type { Task, Config } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";
import type { DisplayOption } from "../hooks/useDisplayOptions.js";
import type { RelationType } from "../hooks/useRelatedTasks.js";

export const ROW_HEIGHT = 28;

interface TaskTreeHeaderProps {
  config: Config;
  enabledTypes: Set<string>;
  onToggleType: (typeName: string) => void;
}

export function TaskTreeHeader({ config, enabledTypes, onToggleType }: TaskTreeHeaderProps) {
  return (
    <div style={{ padding: "0 8px", borderBottom: "1px solid #e0e0e0", height: 32, display: "flex", alignItems: "center" }}>
      <TypeFilter taskTypes={config.task_types} enabled={enabledTypes} onToggle={onToggleType} />
    </div>
  );
}

interface TaskTreeBodyProps {
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  flatList: TreeNode[];
  collapsed: Set<string>;
  onToggleCollapse: (taskId: string) => void;
  backlogFlatList: TreeNode[];
  backlogCollapsed: boolean;
  backlogTotalCount: number;
  onToggleBacklog: () => void;
  displayOptions?: Set<DisplayOption>;
  hoveredTaskId?: string | null;
  onHoverTask?: (taskId: string | null) => void;
  highlightedTaskIds?: Set<string>;
  highlightRelationMap?: Map<string, RelationType>;
  searchQuery?: string;
}

export function TaskTreeBody({
  config,
  selectedTaskId,
  onSelectTask,
  flatList,
  collapsed,
  onToggleCollapse,
  backlogFlatList,
  backlogCollapsed,
  backlogTotalCount,
  onToggleBacklog,
  displayOptions,
  hoveredTaskId,
  onHoverTask,
  highlightedTaskIds,
  highlightRelationMap,
  searchQuery,
}: TaskTreeBodyProps) {
  return (
    <div>
      {flatList.map((node) => (
        <TaskRow
          key={node.task.id}
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
          highlightType={highlightRelationMap?.get(node.task.id) ?? null}
          isDimmed={hoveredTaskId != null && hoveredTaskId !== node.task.id && !highlightedTaskIds?.has(node.task.id)}
          searchQuery={searchQuery}
        />
      ))}
      {backlogTotalCount > 0 && (
        <>
          <BacklogSectionHeader
            isCollapsed={backlogCollapsed}
            totalCount={backlogTotalCount}
            onToggle={onToggleBacklog}
          />
          {!backlogCollapsed && backlogFlatList.map((node) => (
            <TaskRow
              key={node.task.id}
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
              highlightType={highlightRelationMap?.get(node.task.id) ?? null}
              isDimmed={hoveredTaskId != null && hoveredTaskId !== node.task.id && !highlightedTaskIds?.has(node.task.id)}
              searchQuery={searchQuery}
            />
          ))}
        </>
      )}
    </div>
  );
}
