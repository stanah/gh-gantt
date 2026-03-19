import { useCallback, useRef, useState } from "react";

export interface UndoRedoAction {
  label?: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

export interface UndoRedoSnapshot {
  undoCount: number;
  redoCount: number;
  canUndo: boolean;
  canRedo: boolean;
  isApplying: boolean;
}

export interface UndoRedoManager {
  push: (action: UndoRedoAction) => void;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  clearRedo: () => void;
  clearAll: () => void;
  getSnapshot: () => UndoRedoSnapshot;
}

export function createUndoRedoManager(maxHistory = 100): UndoRedoManager {
  const undoStack: UndoRedoAction[] = [];
  const redoStack: UndoRedoAction[] = [];
  let isApplying = false;

  const snapshot = (): UndoRedoSnapshot => ({
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    isApplying,
  });

  const push = (action: UndoRedoAction) => {
    undoStack.push(action);
    if (maxHistory > 0 && undoStack.length > maxHistory) {
      undoStack.splice(0, undoStack.length - maxHistory);
    }
    redoStack.length = 0;
  };

  const undo = async (): Promise<boolean> => {
    if (isApplying || undoStack.length === 0) return false;
    const action = undoStack.pop();
    if (!action) return false;

    isApplying = true;
    try {
      await action.undo();
      redoStack.push(action);
      return true;
    } catch (error) {
      undoStack.push(action);
      throw error;
    } finally {
      isApplying = false;
    }
  };

  const redo = async (): Promise<boolean> => {
    if (isApplying || redoStack.length === 0) return false;
    const action = redoStack.pop();
    if (!action) return false;

    isApplying = true;
    try {
      await action.redo();
      undoStack.push(action);
      if (maxHistory > 0 && undoStack.length > maxHistory) {
        undoStack.splice(0, undoStack.length - maxHistory);
      }
      return true;
    } catch (error) {
      redoStack.push(action);
      throw error;
    } finally {
      isApplying = false;
    }
  };

  const clearRedo = () => {
    redoStack.length = 0;
  };

  const clearAll = () => {
    undoStack.length = 0;
    redoStack.length = 0;
  };

  return {
    push,
    undo,
    redo,
    clearRedo,
    clearAll,
    getSnapshot: snapshot,
  };
}

export function useUndoRedo(maxHistory = 100) {
  const managerRef = useRef<UndoRedoManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = createUndoRedoManager(maxHistory);
  }
  const manager = managerRef.current;

  const [snapshot, setSnapshot] = useState<UndoRedoSnapshot>(() => manager.getSnapshot());
  const syncSnapshot = useCallback(() => {
    setSnapshot(manager.getSnapshot());
  }, [manager]);

  const push = useCallback((action: UndoRedoAction) => {
    manager.push(action);
    syncSnapshot();
  }, [manager, syncSnapshot]);

  const undo = useCallback(async (): Promise<boolean> => {
    const pending = manager.undo();
    syncSnapshot();
    try {
      return await pending;
    } finally {
      syncSnapshot();
    }
  }, [manager, syncSnapshot]);

  const redo = useCallback(async (): Promise<boolean> => {
    const pending = manager.redo();
    syncSnapshot();
    try {
      return await pending;
    } finally {
      syncSnapshot();
    }
  }, [manager, syncSnapshot]);

  const clearRedo = useCallback(() => {
    manager.clearRedo();
    syncSnapshot();
  }, [manager, syncSnapshot]);

  const clearAll = useCallback(() => {
    manager.clearAll();
    syncSnapshot();
  }, [manager, syncSnapshot]);

  return {
    ...snapshot,
    push,
    undo,
    redo,
    clearRedo,
    clearAll,
  };
}
