import React from "react";
import { Hash, Signal, User } from "lucide-react";
import type { DisplayOption } from "../../hooks/useDisplayOptions.js";
import { ToolbarGroup } from "./ToolbarGroup.js";
import { IconButton } from "./IconButton.js";

interface DisplayGroupProps {
  displayOptions: Set<DisplayOption>;
  onToggleDisplayOption: (opt: DisplayOption) => void;
}

export function DisplayGroup({ displayOptions, onToggleDisplayOption }: DisplayGroupProps) {
  return (
    <ToolbarGroup label="Display">
      <IconButton
        icon={<Hash size={14} />}
        title="Show Issue ID"
        onClick={() => onToggleDisplayOption("issueId")}
        active={displayOptions.has("issueId")}
      />
      <IconButton
        icon={<User size={14} />}
        title="Show Assignees"
        onClick={() => onToggleDisplayOption("assignees")}
        active={displayOptions.has("assignees")}
      />
      <IconButton
        icon={<Signal size={14} />}
        title="Show Priority"
        onClick={() => onToggleDisplayOption("priority")}
        active={displayOptions.has("priority")}
      />
    </ToolbarGroup>
  );
}
