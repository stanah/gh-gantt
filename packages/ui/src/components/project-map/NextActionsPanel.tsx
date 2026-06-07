import React from "react";
import type { NextAction } from "@gh-gantt/shared";
import type { Config } from "../../types/index.js";
import { PanelHeader, PanelBody, PanelEmpty } from "./ProjectMapLayout.js";
import { NextActionCard } from "./NextActionCard.js";

interface NextActionsPanelProps {
  nextActions: NextAction[];
  config: Config;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/**
 * Next Actions パネル。ViewModel が算出したスコア順の推薦タスクを、
 * 順位と理由付きで上位から表示する。カード選択で対象タスクを他パネルへ伝播する。
 */
export function NextActionsPanel({
  nextActions,
  config,
  selectedTaskId,
  onSelectTask,
}: NextActionsPanelProps) {
  return (
    <>
      <PanelHeader title="Next Actions" hint="次に着手すべき候補" />
      {nextActions.length === 0 ? (
        <PanelEmpty message="着手可能なタスクがありません" />
      ) : (
        <PanelBody>
          {nextActions.map((action, index) => (
            <NextActionCard
              key={action.task.id}
              action={action}
              config={config}
              index={index}
              isSelected={selectedTaskId === action.task.id}
              onSelect={onSelectTask}
            />
          ))}
        </PanelBody>
      )}
    </>
  );
}
