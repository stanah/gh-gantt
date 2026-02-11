import { useState, useCallback, useRef } from "react";
import type { Task, Config } from "../types/index.js";
import { wouldCreateParentCycle, isTypeHierarchyAllowed } from "../lib/validation.js";

export interface DropIndicator {
  targetTaskId: string;
  valid: boolean;
  reason?: string;
}

interface UseTreeDragDropOptions {
  tasks: Task[];
  config: Config | null;
  onReparent: (taskId: string, newParentId: string | null) => Promise<void>;
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

export function useTreeDragDrop({
  tasks,
  config,
  onReparent,
}: UseTreeDragDropOptions): UseTreeDragDropReturn {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const draggedRef = useRef<string | null>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent, taskId: string) => {
      e.dataTransfer.setData("text/plain", taskId);
      e.dataTransfer.effectAllowed = "move";
      draggedRef.current = taskId;
      setDraggedTaskId(taskId);
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, targetTaskId: string) => {
      const dragId = draggedRef.current;
      if (!dragId || dragId === targetTaskId) {
        setDropIndicator(null);
        return;
      }

      // Always preventDefault so the browser allows the drop event to fire
      e.preventDefault();

      const draggedTask = tasks.find((t) => t.id === dragId);
      const targetTask = tasks.find((t) => t.id === targetTaskId);
      if (!draggedTask || !targetTask) {
        setDropIndicator(null);
        return;
      }

      // Already a child of this parent
      if (draggedTask.parent === targetTaskId) {
        setDropIndicator(null);
        return;
      }

      // Cycle check
      if (wouldCreateParentCycle(tasks, dragId, targetTaskId)) {
        setDropIndicator({ targetTaskId, valid: false, reason: "サイクルが発生します" });
        return;
      }

      // Type hierarchy check
      if (config && !isTypeHierarchyAllowed(config.type_hierarchy, targetTask.type, draggedTask.type)) {
        setDropIndicator({
          targetTaskId,
          valid: false,
          reason: `"${draggedTask.type}" を "${targetTask.type}" の下に配置できません`,
        });
        return;
      }

      setDropIndicator({ targetTaskId, valid: true });
    },
    [tasks, config?.type_hierarchy],
  );

  const handleDragLeave = useCallback(() => {
    setDropIndicator(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetTaskId: string) => {
      e.preventDefault();
      const dragId = draggedRef.current;
      setDropIndicator(null);
      setDraggedTaskId(null);
      draggedRef.current = null;

      if (!dragId || dragId === targetTaskId) return;

      const draggedTask = tasks.find((t) => t.id === dragId);
      const targetTask = tasks.find((t) => t.id === targetTaskId);
      if (!draggedTask || !targetTask) return;
      if (draggedTask.parent === targetTaskId) return;
      if (wouldCreateParentCycle(tasks, dragId, targetTaskId)) return;
      if (config && !isTypeHierarchyAllowed(config.type_hierarchy, targetTask.type, draggedTask.type)) return;

      onReparent(dragId, targetTaskId);
    },
    [tasks, config, onReparent],
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
      const draggedTask = tasks.find((t) => t.id === dragId);
      if (!draggedTask?.parent) return; // already root
      e.preventDefault();
      setDropIndicator({ targetTaskId: "__root__", valid: true });
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
      onReparent(dragId, null);
    },
    [onReparent],
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
