import React from "react";
import { ZoomIn, ZoomOut, CalendarDays } from "lucide-react";
import { ToolbarGroup } from "./ToolbarGroup.js";
import { IconButton } from "./IconButton.js";

interface ZoomGroupProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onScrollToToday: () => void;
}

export function ZoomGroup({ onZoomIn, onZoomOut, onScrollToToday }: ZoomGroupProps) {
  return (
    <ToolbarGroup>
      <IconButton icon={<ZoomIn size={14} />} title="Zoom In" onClick={onZoomIn} />
      <IconButton icon={<ZoomOut size={14} />} title="Zoom Out" onClick={onZoomOut} />
      <IconButton
        icon={<CalendarDays size={14} />}
        title="Scroll to Today"
        onClick={onScrollToToday}
      />
    </ToolbarGroup>
  );
}
