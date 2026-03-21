import { useState, useCallback, useRef } from "react";
import type { Task, Config } from "../types/index.js";
import { wouldCreateParentCycle, isTypeHierarchyAllowed } from "../lib/validation.js";

export type DropMode = "reparent" | "dependency";

export interface DropIndicator {
  targetTaskId: string;
  valid: boolean;
  mode: DropMode;
  reason?: string;
}

interface UseTreeDragDropOptions {
  tasks: Task[];
  config: Config | null;
  onReparent: (taskId: string, newParentId: string | null) => Promise<void>;
  onAddDependency?: (taskId: string, blockedByTaskId: string) => Promise<void>;
}

export interface UseTreeDragDropReturn {
  draggedTaskId: string | null;
  dropIndicator: DropIndicator | null;
  handleDragStart: (e: React.DragEvent, taskId: string) => void;
  handleDragOver: (e: React.DragEvent, targetTaskId: string) => void;
  handleDragLeave: () => void;
  handleDrop: (e: React.DragEvent, targetTaskId: string) => void;
  handleDragEnd: () => void;
  handleRootDragOver: (e: React.DragEvent) => void;
  handleRootDrop: (e: React.DragEvent) => void;
}

export function shouldHandleRootDrop(tasks: Task[], dragId: string | null): boolean {
  if (!dragId) return false;
  const draggedTask = tasks.find((t) => t.id === dragId);
  return Boolean(draggedTask?.parent);
}

export function useTreeDragDrop({
  tasks,
  config,
  onReparent,
  onAddDependency,
}: UseTreeDragDropOptions): UseTreeDragDropReturn {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const draggedRef = useRef<string | null>(null);

  const getDropMode = (e: { altKey: boolean }): DropMode =>
    e.altKey && onAddDependency ? "dependency" : "reparent";

  const handleDragStart = useCallback(
    (e: React.DragEvent, taskId: string) => {
      e.dataTransfer.setData("text/plain", taskId);
      e.dataTransfer.effectAllowed = "move";
      draggedRef.current = taskId;
      setDraggedTaskId(taskId);
    },
    [],
  );

  const validateReparent = useCallback(
    (dragId: string, targetTaskId: string): DropIndicator | null => {
      const draggedTask = tasks.find((t) => t.id === dragId);
      const targetTask = tasks.find((t) => t.id === targetTaskId);
      if (!draggedTask || !targetTask) return null;

      if (draggedTask.parent === targetTaskId) return null;

      if (wouldCreateParentCycle(tasks, dragId, targetTaskId)) {
        return { targetTaskId, valid: false, mode: "reparent", reason: "サイクルが発生します" };
      }

      if (config && !isTypeHierarchyAllowed(config.type_hierarchy, targetTask.type, draggedTask.type)) {
        return {
          targetTaskId,
          valid: false,
          mode: "reparent",
          reason: `"${draggedTask.type}" を "${targetTask.type}" の下に配置できません`,
        };
      }

      return { targetTaskId, valid: true, mode: "reparent" };
    },
    [tasks, config],
  );

  const validateDependency = useCallback(
    (dragId: string, targetTaskId: string): DropIndicator | null => {
      const draggedTask = tasks.find((t) => t.id === dragId);
      const targetTask = tasks.find((t) => t.id === targetTaskId);
      if (!draggedTask || !targetTask) return null;

      // Already has this dependency
      if (draggedTask.blocked_by.some((d) => d.task === targetTaskId)) {
        return { targetTaskId, valid: false, mode: "dependency", reason: "既に依存関係があります" };
      }

      return { targetTaskId, valid: true, mode: "dependency" };
    },
    [tasks],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, targetTaskId: string) => {
      const dragId = draggedRef.current;
      if (!dragId || dragId === targetTaskId) {
        setDropIndicator(null);
        return;
      }

      e.preventDefault();

      const mode = getDropMode(e);
      const indicator = mode === "dependency"
        ? validateDependency(dragId, targetTaskId)
        : validateReparent(dragId, targetTaskId);

      setDropIndicator(indicator);
    },
    [validateReparent, validateDependency, onAddDependency],
  );

  const handleDragLeave = useCallback(() => {
    setDropIndicator(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetTaskId: string) => {
      e.preventDefault();
      const dragId = draggedRef.current;
      const mode = getDropMode(e);
      setDropIndicator(null);
      setDraggedTaskId(null);
      draggedRef.current = null;

      if (!dragId || dragId === targetTaskId) return;

      if (mode === "dependency" && onAddDependency) {
        const indicator = validateDependency(dragId, targetTaskId);
        if (!indicator?.valid) return;
        onAddDependency(dragId, targetTaskId).catch((err) => {
          console.error("Add dependency failed:", err);
        });
      } else {
        const indicator = validateReparent(dragId, targetTaskId);
        if (!indicator?.valid) return;
        onReparent(dragId, targetTaskId).catch((err) => {
          console.error("Reparent failed:", err);
        });
      }
    },
    [onReparent, onAddDependency, validateReparent, validateDependency],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedTaskId(null);
    setDropIndicator(null);
    draggedRef.current = null;
  }, []);

  const handleRootDragOver = useCallback(
    (e: React.DragEvent) => {
      const dragId = draggedRef.current;
      if (!dragId) return;
      if (!shouldHandleRootDrop(tasks, dragId)) return;
      e.preventDefault();
      setDropIndicator({ targetTaskId: "__root__", valid: true, mode: "reparent" });
    },
    [tasks],
  );

  const handleRootDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const dragId = draggedRef.current;
      setDropIndicator(null);
      setDraggedTaskId(null);
      draggedRef.current = null;
      if (!dragId) return;
      if (!shouldHandleRootDrop(tasks, dragId)) return;
      onReparent(dragId, null).catch((err) => {
        console.error("Reparent failed:", err);
      });
    },
    [tasks, onReparent],
  );

  return {
    draggedTaskId,
    dropIndicator,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    handleRootDragOver,
    handleRootDrop,
  };
}
