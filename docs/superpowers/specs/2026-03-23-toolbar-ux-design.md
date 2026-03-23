# Toolbar UX Improvement Design

Issue: #46 - Filter Toolbar UX Improvement

## Overview

Convert the flat, text-heavy toolbar into a compact, icon-based toolbar with clear logical grouping, active filter badges, and keyboard shortcut tooltips.

## Approach

Approach A: Icon buttons with group labels in a single row. Uses `lucide-react` for icons. Group labels (9px uppercase) above each section. Active filters shown with blue highlight + badge count. Native `title` tooltips with keyboard shortcut hints.

## Group Layout (left to right)

| Group         | Elements               | Icon (lucide-react)              | Tooltip                |
| ------------- | ---------------------- | -------------------------------- | ---------------------- |
| **View**      | Day/Week/Month/Quarter | Text segment buttons (D/W/M/Q)   | —                      |
| **Zoom**      | Zoom In                | `ZoomIn`                         | Zoom In                |
|               | Zoom Out               | `ZoomOut`                        | Zoom Out               |
|               | Today                  | `CalendarDays`                   | Scroll to Today        |
| **Display**   | Issue ID               | `Hash`                           | Show Issue ID          |
|               | Assignees              | `User`                           | Show Assignees         |
| **Filter**    | Hide Closed            | `EyeOff` / `Eye`                 | Hide Closed Tasks      |
|               | Type                   | `Tags` + dropdown                | Filter by Type         |
|               | Assignee               | `Users` + dropdown               | Filter by Assignee     |
|               | Priority               | `Signal` + dropdown              | Filter by Priority     |
| **Search**    | Search box             | `Search` (in input)              | Search (⌘K)            |
| **Help**      | Shortcuts              | `Keyboard`                       | Keyboard Shortcuts (?) |
| **(spacer)**  | flex: 1                |                                  |                        |
| **Undo/Redo** | Undo                   | `Undo2`                          | Undo (⌘Z)              |
|               | Redo                   | `Redo2`                          | Redo (⌘⇧Z)             |
| **Sync**      | Pull                   | `CloudDownload`                  | Pull from GitHub       |
|               | Push                   | `CloudUpload`                    | Push to GitHub         |
|               | Last synced            | text (color: #888, fontSize: 10) | —                      |

## Active State

- **Toggle buttons** (Display, Hide Closed): background `#e8f0fe`, color `#1a73e8`
- **Filter dropdowns** (Type, Assignee, Priority): same blue highlight (`#e8f0fe` / `#1a73e8`) when filtered, with badge count. This replaces the current `#333` dark style for consistency across the toolbar.
- **View Scale**: selected = `#333` background + white text (segment button)
- **Disabled** (e.g. Redo unavailable): `opacity: 0.4`
- **Badge**: small pill (`background: #1a73e8, color: #fff, border-radius: 8px, padding: 0 5px, font-size: 9px`) shown inline after the dropdown trigger icon/text

## Dropdown Behavior

All filter dropdowns (Type, Assignee, Priority) follow the same pattern:

- Checkbox-based multi-select menu
- "Clear (All ...)" button at top to reset
- TypeFilter includes type colors from `config.task_types[name].color` as colored dots next to each checkbox label
- At least one type must remain selected (disable unchecking the last one, or show warning)
- Clicking outside a dropdown closes it (add click-outside detection)
- Opening one dropdown does NOT auto-close others (independent operation)
- Position: `absolute`, `top: calc(100% + 4px)`, `left: 0`, `z-index: 20`

## Component Structure

```
components/
  toolbar/
    Toolbar.tsx          — Main container, assembles groups
    ToolbarGroup.tsx     — Group label + children wrapper
    IconButton.tsx       — Icon button + tooltip + optional badge
    ViewScaleGroup.tsx   — D/W/M/Q segment buttons
    ZoomGroup.tsx        — ZoomIn / ZoomOut / Today
    DisplayGroup.tsx     — #ID / Assignee toggles
    FilterGroup.tsx      — HideClosed / Type / Assignee / Priority
    UndoRedoGroup.tsx    — Undo / Redo
    SyncGroup.tsx        — Pull / Push / lastSynced
    SearchBox.tsx        — Search input with icon
  AssigneeFilter.tsx     — Existing dropdown (style update: #333 → #e8f0fe blue)
  PriorityFilter.tsx     — Existing dropdown (style update: #333 → #e8f0fe blue)
  TypeFilter.tsx         — Rewrite: toggle buttons → checkbox dropdown (matching Assignee/Priority pattern)
```

## Props Changes

`Toolbar.tsx` props interface adds:

- `taskTypes: Record<string, TaskType>`
- `enabledTypes: Set<string>`
- `onToggleType: (typeName: string) => void`

All existing props remain unchanged for backward compatibility.

## Migration

- `TaskTreeHeader` removes `TypeFilter` rendering (moved to toolbar). If it becomes empty, simplify to just render the header border/spacing.
- `TypeFilter.tsx` rewritten as checkbox dropdown (consistent with Assignee/Priority filters)
- Old `Toolbar.tsx` replaced entirely by new `toolbar/Toolbar.tsx`
- Update import in `App.tsx` from `"./components/Toolbar.js"` to `"./components/toolbar/Toolbar.js"`

## Dependencies

- Add `lucide-react` to `@gh-gantt/ui` dependencies (runtime, not devDependencies)

## Out of Scope

- Responsive/mobile layout
- Dark mode
- Custom icon theme
- Toolbar position configuration
- Keyboard shortcuts for opening filter dropdowns
