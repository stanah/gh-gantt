# Toolbar UX Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the flat text-button toolbar into an icon-based toolbar with group labels, active filter badges, and keyboard shortcut tooltips.

**Architecture:** Split the monolithic `Toolbar.tsx` (264 lines) into focused sub-components under `components/toolbar/`. Each toolbar group is its own component. Shared primitives (`ToolbarGroup`, `IconButton`) provide consistent styling. TypeFilter moves from `TaskTreeHeader` into the toolbar's `FilterGroup`.

**Tech Stack:** React 18, lucide-react (icons), inline styles (matching existing codebase pattern)

**Spec:** `docs/superpowers/specs/2026-03-23-toolbar-ux-design.md`

---

### Task 1: Add lucide-react dependency

**Files:**

- Modify: `packages/ui/package.json`

- [ ] **Step 1: Install lucide-react**

```bash
cd packages/ui && pnpm add lucide-react
```

- [ ] **Step 2: Verify import works**

```bash
cd /Users/stanah/work/github.com/stanah/gh-gantt && pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml
git commit -m "chore: add lucide-react dependency to @gh-gantt/ui"
```

---

### Task 2: Create shared toolbar primitives (ToolbarGroup, IconButton)

**Files:**

- Create: `packages/ui/src/components/toolbar/ToolbarGroup.tsx`
- Create: `packages/ui/src/components/toolbar/IconButton.tsx`

- [ ] **Step 1: Create `ToolbarGroup.tsx`**

`ToolbarGroup` is a wrapper that renders a small uppercase label above its children. The `gap` prop controls spacing between child elements (the inner row), not between label and children.

```tsx
// packages/ui/src/components/toolbar/ToolbarGroup.tsx
import React from "react";

interface ToolbarGroupProps {
  label?: string;
  children: React.ReactNode;
  gap?: number; // gap between child elements in the inner row (px)
}

export function ToolbarGroup({ label, children, gap = 2 }: ToolbarGroupProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1, // gap between label and inner row
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 9,
            color: "#999",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          {label}
        </span>
      )}
      <div style={{ display: "flex", gap, alignItems: "center" }}>{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Create `IconButton.tsx`**

```tsx
// packages/ui/src/components/toolbar/IconButton.tsx
import React from "react";

interface IconButtonProps {
  icon: React.ReactNode;
  title: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
  children?: React.ReactNode;
}

const baseStyle: React.CSSProperties = {
  padding: "4px 6px",
  border: "1px solid #ddd",
  borderRadius: 3,
  background: "#fff",
  color: "#555",
  cursor: "pointer",
  fontSize: 11,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  lineHeight: 1,
};

const activeStyle: React.CSSProperties = {
  background: "#e8f0fe",
  color: "#1a73e8",
  borderColor: "#c5d7f7",
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: "default",
};

const badgeStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "#fff",
  borderRadius: 8,
  padding: "0 5px",
  fontSize: 9,
  minWidth: 16,
  textAlign: "center",
  lineHeight: "16px",
};

export function IconButton({
  icon,
  title,
  onClick,
  active = false,
  disabled = false,
  badge,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      style={{
        ...baseStyle,
        ...(active ? activeStyle : {}),
        ...(disabled ? disabledStyle : {}),
      }}
    >
      {icon}
      {children}
      {badge != null && badge > 0 && <span style={badgeStyle}>{badge}</span>}
    </button>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/toolbar/
git commit -m "feat(ui): add ToolbarGroup and IconButton primitives"
```

---

### Task 3: Create ViewScaleGroup and ZoomGroup

**Files:**

- Create: `packages/ui/src/components/toolbar/ViewScaleGroup.tsx`
- Create: `packages/ui/src/components/toolbar/ZoomGroup.tsx`

- [ ] **Step 1: Create `ViewScaleGroup.tsx`**

```tsx
// packages/ui/src/components/toolbar/ViewScaleGroup.tsx
import React from "react";
import type { ViewScale } from "../../hooks/useGanttScale.js";
import { ToolbarGroup } from "./ToolbarGroup.js";

interface ViewScaleGroupProps {
  viewScale: ViewScale;
  onSetViewScale: (scale: ViewScale) => void;
}

const SCALES: { key: ViewScale; label: string }[] = [
  { key: "day", label: "D" },
  { key: "week", label: "W" },
  { key: "month", label: "M" },
  { key: "quarter", label: "Q" },
];

export function ViewScaleGroup({ viewScale, onSetViewScale }: ViewScaleGroupProps) {
  return (
    <ToolbarGroup label="View" gap={0}>
      <div
        style={{
          display: "flex",
          gap: 1,
          background: "#f0f0f0",
          borderRadius: 4,
          padding: 1,
        }}
      >
        {SCALES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => onSetViewScale(key)}
            style={{
              padding: "3px 8px",
              border: "none",
              borderRadius: 3,
              background: viewScale === key ? "#333" : "transparent",
              color: viewScale === key ? "#fff" : "#555",
              cursor: "pointer",
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </ToolbarGroup>
  );
}
```

- [ ] **Step 2: Create `ZoomGroup.tsx`**

```tsx
// packages/ui/src/components/toolbar/ZoomGroup.tsx
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
    <ToolbarGroup label="Zoom">
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
```

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/toolbar/
git commit -m "feat(ui): add ViewScaleGroup and ZoomGroup toolbar components"
```

---

### Task 4: Create DisplayGroup, UndoRedoGroup, SyncGroup, SearchBox

**Files:**

- Create: `packages/ui/src/components/toolbar/DisplayGroup.tsx`
- Create: `packages/ui/src/components/toolbar/UndoRedoGroup.tsx`
- Create: `packages/ui/src/components/toolbar/SyncGroup.tsx`
- Create: `packages/ui/src/components/toolbar/SearchBox.tsx`

- [ ] **Step 1: Create `DisplayGroup.tsx`**

```tsx
// packages/ui/src/components/toolbar/DisplayGroup.tsx
import React from "react";
import { Hash, User } from "lucide-react";
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
    </ToolbarGroup>
  );
}
```

- [ ] **Step 2: Create `UndoRedoGroup.tsx`**

Note: No ToolbarGroup label — Undo/Redo is a utility action, not a logical "group" needing a header. Keeping it unlabeled to reduce visual noise on the right side of the toolbar.

```tsx
// packages/ui/src/components/toolbar/UndoRedoGroup.tsx
import React from "react";
import { Undo2, Redo2 } from "lucide-react";
import { IconButton } from "./IconButton.js";

interface UndoRedoGroupProps {
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoCount?: number;
  redoCount?: number;
  undoRedoBusy?: boolean;
}

export function UndoRedoGroup({
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  undoCount = 0,
  redoCount = 0,
  undoRedoBusy = false,
}: UndoRedoGroupProps) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      <IconButton
        icon={<Undo2 size={14} />}
        title={`Undo (⌘Z)${undoCount > 0 ? ` — ${undoCount}` : ""}`}
        onClick={onUndo}
        disabled={!onUndo || !canUndo || undoRedoBusy}
        badge={undoCount > 0 ? undoCount : undefined}
      />
      <IconButton
        icon={<Redo2 size={14} />}
        title={`Redo (⌘⇧Z)${redoCount > 0 ? ` — ${redoCount}` : ""}`}
        onClick={onRedo}
        disabled={!onRedo || !canRedo || undoRedoBusy}
        badge={redoCount > 0 ? redoCount : undefined}
      />
    </div>
  );
}
```

- [ ] **Step 3: Create `SyncGroup.tsx`**

Note: No ToolbarGroup label — Sync is pinned right with last-synced timestamp, acting as a status indicator rather than a labeled group.

```tsx
// packages/ui/src/components/toolbar/SyncGroup.tsx
import React from "react";
import { CloudDownload, CloudUpload } from "lucide-react";
import { IconButton } from "./IconButton.js";

interface SyncGroupProps {
  onPull: () => void;
  onPush: () => void;
  syncing: "pull" | "push" | null;
  lastSyncedAt?: string;
}

export function SyncGroup({ onPull, onPush, syncing, lastSyncedAt }: SyncGroupProps) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      <IconButton
        icon={<CloudDownload size={14} />}
        title="Pull from GitHub"
        onClick={onPull}
        disabled={!!syncing}
      >
        {syncing === "pull" ? "…" : null}
      </IconButton>
      <IconButton
        icon={<CloudUpload size={14} />}
        title="Push to GitHub"
        onClick={onPush}
        disabled={!!syncing}
      >
        {syncing === "push" ? "…" : null}
      </IconButton>
      {lastSyncedAt && (
        <span style={{ color: "#888", fontSize: 10 }}>
          {new Date(lastSyncedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `SearchBox.tsx`**

Note: No ToolbarGroup label — the search icon inside the input serves as the visual indicator.

```tsx
// packages/ui/src/components/toolbar/SearchBox.tsx
import React from "react";
import { Search } from "lucide-react";

interface SearchBoxProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
}

export function SearchBox({ searchQuery, onSearchChange, searchInputRef }: SearchBoxProps) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <Search
        size={12}
        style={{ position: "absolute", left: 6, color: "#999", pointerEvents: "none" }}
      />
      <input
        ref={searchInputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search… (⌘K)"
        aria-label="Search tasks"
        style={{
          padding: "3px 24px 3px 22px",
          border: "1px solid #ddd",
          borderRadius: 3,
          fontSize: 11,
          width: 140,
          outline: "none",
          background: "#f8f8f8",
        }}
      />
      {searchQuery && (
        <button
          type="button"
          onClick={() => onSearchChange("")}
          aria-label="Clear search"
          style={{
            position: "absolute",
            right: 2,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            color: "#888",
            padding: "0 4px",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Verify build**

```bash
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/toolbar/
git commit -m "feat(ui): add DisplayGroup, UndoRedoGroup, SyncGroup, SearchBox toolbar components"
```

---

### Task 5: Rewrite TypeFilter as checkbox dropdown

**Files:**

- Modify: `packages/ui/src/components/TypeFilter.tsx`

- [ ] **Step 1: Rewrite `TypeFilter.tsx`**

Complete rewrite from inline toggle buttons to a checkbox dropdown matching AssigneeFilter/PriorityFilter pattern. Key implementation details:

- Props interface stays the same: `{ taskTypes, enabled, onToggle }`
- Click-outside detection via `useRef` + `useEffect` with `mousedown` listener
- "Enable All" button at top resets to all types
- Each checkbox label shows a colored dot using `taskType.color`
- Last enabled type's checkbox is disabled (at-least-one constraint)
- Trigger button shows active blue style (`#e8f0fe` / `#1a73e8`) when not all types enabled
- Badge count shows number of enabled types when filtered

```tsx
// packages/ui/src/components/TypeFilter.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Tags } from "lucide-react";
import type { TaskType } from "../types/index.js";

interface TypeFilterProps {
  taskTypes: Record<string, TaskType>;
  enabled: Set<string>;
  onToggle: (typeName: string) => void;
}

function formatLabel(enabled: Set<string>, total: number): string {
  if (enabled.size === total || enabled.size === 0) return "All types";
  if (enabled.size === 1) {
    const [name] = enabled;
    return name;
  }
  return `${enabled.size} types`;
}

export function TypeFilter({ taskTypes, enabled, onToggle }: TypeFilterProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => Object.entries(taskTypes), [taskTypes]);
  const allCount = entries.length;
  const isFiltered = enabled.size < allCount && enabled.size > 0;

  // Click-outside detection
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const btnStyle: React.CSSProperties = {
    padding: "4px 8px",
    border: `1px solid ${isFiltered ? "#c5d7f7" : "#ddd"}`,
    borderRadius: 3,
    background: isFiltered ? "#e8f0fe" : "#fff",
    color: isFiltered ? "#1a73e8" : "#555",
    cursor: "pointer",
    fontSize: 11,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    lineHeight: 1,
  };

  const menuStyle: React.CSSProperties = {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 20,
    minWidth: 180,
    maxHeight: 260,
    overflow: "auto",
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    padding: 8,
  };

  const badgeStyle: React.CSSProperties = {
    background: "#1a73e8",
    color: "#fff",
    borderRadius: 8,
    padding: "0 5px",
    fontSize: 9,
    minWidth: 16,
    textAlign: "center",
    lineHeight: "16px",
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={btnStyle}
        title={formatLabel(enabled, allCount)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Tags size={12} />
        {formatLabel(enabled, allCount)}
        {isFiltered && <span style={badgeStyle}>{enabled.size}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Filter by type" style={menuStyle}>
          <button
            type="button"
            onClick={() => {
              // Enable all types
              for (const [name] of entries) {
                if (!enabled.has(name)) onToggle(name);
              }
            }}
            style={{
              width: "100%",
              padding: "4px 6px",
              border: "1px solid #ddd",
              borderRadius: 3,
              background: enabled.size === allCount ? "#f0f4ff" : "#fff",
              cursor: "pointer",
              fontSize: 11,
              marginBottom: 8,
            }}
          >
            Enable All
          </button>

          {entries.map(([name, def]) => {
            const isLast = enabled.size === 1 && enabled.has(name);
            return (
              <label
                key={name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  marginBottom: 6,
                  cursor: isLast ? "not-allowed" : "pointer",
                  opacity: isLast ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={enabled.has(name)}
                  disabled={isLast}
                  onChange={() => onToggle(name)}
                />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: def.color,
                    flexShrink: 0,
                  }}
                />
                {def.label}
              </label>
            );
          })}

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                padding: "3px 10px",
                border: "1px solid #ccc",
                borderRadius: 3,
                background: "#fff",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/TypeFilter.tsx
git commit -m "feat(ui): rewrite TypeFilter as checkbox dropdown"
```

---

### Task 6: Update AssigneeFilter and PriorityFilter styles + click-outside

**Files:**

- Modify: `packages/ui/src/components/AssigneeFilter.tsx`
- Modify: `packages/ui/src/components/PriorityFilter.tsx`

- [ ] **Step 1: Update AssigneeFilter**

Two changes:

1. Active style: change `#333` → `#e8f0fe` blue (lines 29-30):

```tsx
background: selectedValues.length > 0 ? "#e8f0fe" : "#fff",
color: selectedValues.length > 0 ? "#1a73e8" : "#333",
```

2. Click-outside detection: add `useRef` for wrapper div and `useEffect`:

```tsx
const wrapperRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!open) return;
  const handler = (e: MouseEvent) => {
    if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  };
  document.addEventListener("mousedown", handler);
  return () => document.removeEventListener("mousedown", handler);
}, [open]);
```

Add `ref={wrapperRef}` to the outer `<div style={{ position: "relative" }}>`.

Also add `useRef` to the import from "react" (currently imports `useMemo, useState`; add `useEffect, useRef`).

- [ ] **Step 2: Update PriorityFilter**

Same two changes as AssigneeFilter:

1. Active style `#333` → `#e8f0fe` / `#1a73e8`
2. Click-outside detection with `useRef` + `useEffect`

Add `useRef, useEffect` to the import (currently imports `useMemo, useState`).

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/AssigneeFilter.tsx packages/ui/src/components/PriorityFilter.tsx
git commit -m "feat(ui): update filter active styles to blue theme and add click-outside"
```

---

### Task 7: Create FilterGroup and assemble new Toolbar

**Files:**

- Create: `packages/ui/src/components/toolbar/FilterGroup.tsx`
- Create: `packages/ui/src/components/toolbar/Toolbar.tsx`

- [ ] **Step 1: Create `FilterGroup.tsx`**

Assembles HideClosed toggle, TypeFilter, AssigneeFilter, PriorityFilter inside a `ToolbarGroup` with label "Filter".

Note on `selectedAssignee` format: App.tsx stores selected assignees as a comma-separated string (`string | null`). FilterGroup converts this to `string[]` for AssigneeFilter, and converts back on change. This bridges the App.tsx interface (which we don't change) with AssigneeFilter's array interface.

```tsx
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
    hideClosed,
    onToggleHideClosed,
    taskTypes,
    enabledTypes,
    onToggleType,
    selectedAssignee,
    allAssignees,
    onSelectAssignee,
    selectedPriorities,
    onSelectPriorities,
  } = props;

  // Bridge App.tsx comma-separated string ↔ AssigneeFilter array
  const selectedAssignees = selectedAssignee
    ? selectedAssignee
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
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
```

- [ ] **Step 2: Create `toolbar/Toolbar.tsx`**

Main toolbar container. Assembles all groups in a single row. Same props interface as old Toolbar plus TypeFilter props.

```tsx
// packages/ui/src/components/toolbar/Toolbar.tsx
import React from "react";
import { Keyboard } from "lucide-react";
import type { ViewScale } from "../../hooks/useGanttScale.js";
import type { DisplayOption } from "../../hooks/useDisplayOptions.js";
import type { TaskType } from "../../types/index.js";
import { ViewScaleGroup } from "./ViewScaleGroup.js";
import { ZoomGroup } from "./ZoomGroup.js";
import { DisplayGroup } from "./DisplayGroup.js";
import { FilterGroup } from "./FilterGroup.js";
import { SearchBox } from "./SearchBox.js";
import { IconButton } from "./IconButton.js";
import { UndoRedoGroup } from "./UndoRedoGroup.js";
import { SyncGroup } from "./SyncGroup.js";

interface ToolbarProps {
  viewScale: ViewScale;
  onSetViewScale: (scale: ViewScale) => void;
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
      <ViewScaleGroup viewScale={props.viewScale} onSetViewScale={props.onSetViewScale} />
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
```

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/toolbar/
git commit -m "feat(ui): create FilterGroup and assemble new Toolbar"
```

---

### Task 8: Wire up new Toolbar in App.tsx and clean up TaskTreeHeader

**Files:**

- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/components/TaskTree.tsx`
- Delete: `packages/ui/src/components/Toolbar.tsx` (old)

- [ ] **Step 1: Update App.tsx**

1. Change import:

```tsx
// OLD:
import { Toolbar } from "./components/Toolbar.js";
// NEW:
import { Toolbar } from "./components/toolbar/Toolbar.js";
```

2. Add new props to `<Toolbar>` (after existing props):

```tsx
taskTypes={config?.task_types ?? {}}
enabledTypes={enabled}
onToggleType={toggleType}
```

3. Remove `enabledTypes` and `onToggleType` from `<TaskTreeHeader>`:

```tsx
// OLD:
<TaskTreeHeader config={config} enabledTypes={enabled} onToggleType={toggleType} />
// NEW:
<TaskTreeHeader config={config} />
```

- [ ] **Step 2: Simplify TaskTreeHeader**

In `packages/ui/src/components/TaskTree.tsx`:

1. Remove `TypeFilter` import
2. Simplify `TaskTreeHeaderProps` — remove `enabledTypes` and `onToggleType`
3. `TaskTreeHeader` now just renders the header border/spacing div (for the sprint band area). It still needs `config` for sprint detection (`hasSprintBand`).

```tsx
interface TaskTreeHeaderProps {
  config: Config;
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
```

- [ ] **Step 3: Delete old Toolbar.tsx**

```bash
rm packages/ui/src/components/Toolbar.tsx
```

- [ ] **Step 4: Verify build**

```bash
pnpm build
```

- [ ] **Step 5: Run tests**

```bash
pnpm test
```

Fix any test failures (likely in tests that import the old Toolbar path or test TaskTreeHeader with old props).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ui): wire new toolbar, migrate TypeFilter, remove old Toolbar"
```

---

### Task 9: Visual verification and final polish

**Files:**

- Possibly minor adjustments to any toolbar component

- [ ] **Step 1: Start dev server and verify visually**

```bash
# Terminal 1:
gh-gantt serve --api-only
# Terminal 2:
cd packages/ui && pnpm dev
```

Open the app in browser and verify:

- All groups render with labels (View, Zoom, Display, Filter)
- Icons display correctly from lucide-react
- View scale segment buttons (D/W/M/Q) work with active highlight
- Zoom in/out/today work
- Display toggles (#ID, Assignee) work and show blue active state
- All filter dropdowns open and function (Type, Assignee, Priority)
- Hide Closed toggle shows EyeOff/Eye icon swap
- TypeFilter shows colored dots and enforces at-least-one constraint
- Active filter badges show correct count
- Click-outside closes dropdowns
- Search works, ⌘K focuses
- Undo/Redo work with badge counts and disabled state
- Pull/Push buttons work with loading indicator
- Keyboard shortcuts show in button title attributes (hover tooltips)

- [ ] **Step 2: Fix any visual issues**

Adjust spacing, sizing, alignment as needed.

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
pnpm lint
pnpm typecheck
```

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(ui): toolbar visual polish and alignment adjustments"
```
