import { useCallback, useEffect, useRef, useState } from "react";

export interface KeyboardShortcutOptions {
  enabled?: boolean;
  orderedTaskIds: string[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onToggleCollapse: (taskId: string) => void;
  onFocusSearch: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onHelpOpenChange?: (open: boolean) => void;
}

type ShortcutAction =
  | "selectNext"
  | "selectPrev"
  | "toggleCollapse"
  | "focusSearch"
  | "toggleHelp"
  | "undo"
  | "redo";

type KeyboardLikeEvent = Partial<
  Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">
>;

type MaybeEditableTarget =
  | EventTarget
  | { tagName?: string; isContentEditable?: boolean }
  | null
  | undefined;

export function isEditableTarget(target: MaybeEditableTarget): boolean {
  if (!target || typeof target !== "object") return false;
  const candidate = target as { tagName?: string; isContentEditable?: boolean };
  const tagName = candidate.tagName?.toLowerCase();
  return (
    candidate.isContentEditable === true ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

export function resolveShortcutAction(event: KeyboardLikeEvent): ShortcutAction | null {
  if (isEditableTarget(event.target)) return null;

  const rawKey = event.key ?? "";
  const key = rawKey.toLowerCase();
  const hasMeta = Boolean(event.metaKey || event.ctrlKey);
  const hasShift = Boolean(event.shiftKey);
  const hasOtherModifiers = Boolean(event.altKey || event.shiftKey);

  if (hasMeta && key === "z") {
    return hasShift ? "redo" : "undo";
  }
  if (hasMeta && key === "k") return "focusSearch";
  if (!hasMeta && !event.altKey && (rawKey === "?" || (rawKey === "/" && event.shiftKey)))
    return "toggleHelp";
  if (!hasMeta && !hasOtherModifiers && key === "j") return "selectNext";
  if (!hasMeta && !hasOtherModifiers && key === "k") return "selectPrev";
  if (
    !hasMeta &&
    !hasOtherModifiers &&
    (rawKey === " " || rawKey === "Spacebar" || event.code === "Space")
  ) {
    return "toggleCollapse";
  }
  return null;
}

export function getNextSelection(
  taskIds: string[],
  selectedTaskId: string | null,
  direction: "next" | "prev",
): string | null {
  if (taskIds.length === 0) return null;
  if (!selectedTaskId) return direction === "next" ? taskIds[0] : taskIds[taskIds.length - 1];

  const currentIndex = taskIds.indexOf(selectedTaskId);
  if (currentIndex === -1) return direction === "next" ? taskIds[0] : taskIds[taskIds.length - 1];

  if (direction === "next") return taskIds[Math.min(currentIndex + 1, taskIds.length - 1)];
  return taskIds[Math.max(currentIndex - 1, 0)];
}

export function useKeyboardShortcuts(options: KeyboardShortcutOptions) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const latestOptions = useRef(options);
  const helpOpenRef = useRef(isHelpOpen);

  useEffect(() => {
    latestOptions.current = options;
  }, [options]);

  useEffect(() => {
    helpOpenRef.current = isHelpOpen;
    options.onHelpOpenChange?.(isHelpOpen);
  }, [isHelpOpen, options.onHelpOpenChange]);

  const openHelp = useCallback(() => {
    setIsHelpOpen(true);
  }, []);

  const closeHelp = useCallback(() => {
    setIsHelpOpen(false);
  }, []);

  const toggleHelp = useCallback(() => {
    setIsHelpOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (options.enabled === false) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && helpOpenRef.current) {
        event.preventDefault();
        closeHelp();
        return;
      }

      const action = resolveShortcutAction(event);
      if (!action) return;

      // While help dialog is open, only allow toggleHelp (Escape is handled above)
      if (helpOpenRef.current && action !== "toggleHelp") return;

      const current = latestOptions.current;
      if (action === "focusSearch") {
        event.preventDefault();
        current.onFocusSearch();
        return;
      }

      if (action === "toggleHelp") {
        event.preventDefault();
        toggleHelp();
        return;
      }

      if (action === "undo") {
        if (!current.onUndo) return;
        event.preventDefault();
        current.onUndo();
        return;
      }

      if (action === "redo") {
        if (!current.onRedo) return;
        event.preventDefault();
        current.onRedo();
        return;
      }

      if (action === "toggleCollapse") {
        if (!current.selectedTaskId) return;
        event.preventDefault();
        current.onToggleCollapse(current.selectedTaskId);
        return;
      }

      const nextSelection = getNextSelection(
        current.orderedTaskIds,
        current.selectedTaskId,
        action === "selectNext" ? "next" : "prev",
      );
      if (!nextSelection) return;
      event.preventDefault();
      current.onSelectTask(nextSelection);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeHelp, options.enabled, toggleHelp]);

  return {
    isHelpOpen,
    openHelp,
    closeHelp,
    toggleHelp,
  };
}
