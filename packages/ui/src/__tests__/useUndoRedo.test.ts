import { describe, expect, it, vi } from "vitest";
import { createUndoRedoManager } from "../hooks/useUndoRedo.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createUndoRedoManager", () => {
  it("tracks push/undo/redo counts and clears redo on push", async () => {
    const manager = createUndoRedoManager();
    const actionA = { undo: vi.fn(), redo: vi.fn() };
    const actionB = { undo: vi.fn(), redo: vi.fn() };

    manager.push(actionA);
    expect(manager.getSnapshot()).toMatchObject({
      undoCount: 1,
      redoCount: 0,
      canUndo: true,
      canRedo: false,
    });

    const undone = await manager.undo();
    expect(undone).toBe(true);
    expect(actionA.undo).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toMatchObject({
      undoCount: 0,
      redoCount: 1,
      canUndo: false,
      canRedo: true,
    });

    manager.push(actionB);
    expect(manager.getSnapshot()).toMatchObject({
      undoCount: 1,
      redoCount: 0,
      canUndo: true,
      canRedo: false,
    });
  });

  it("handles async undo/redo handlers", async () => {
    const manager = createUndoRedoManager();
    const history: string[] = [];
    manager.push({
      undo: async () => {
        history.push("undo");
      },
      redo: async () => {
        history.push("redo");
      },
    });

    expect(await manager.undo()).toBe(true);
    expect(await manager.redo()).toBe(true);
    expect(history).toEqual(["undo", "redo"]);
    expect(manager.getSnapshot()).toMatchObject({
      undoCount: 1,
      redoCount: 0,
      canUndo: true,
      canRedo: false,
    });
  });

  it("can clear redo stack explicitly", async () => {
    const manager = createUndoRedoManager();
    manager.push({ undo: vi.fn(), redo: vi.fn() });
    await manager.undo();
    expect(manager.getSnapshot().redoCount).toBe(1);

    manager.clearRedo();
    expect(manager.getSnapshot()).toMatchObject({ redoCount: 0, canRedo: false });
  });

  it("guards undo/redo while an operation is running", async () => {
    const manager = createUndoRedoManager();
    const waitUndo = deferred();
    manager.push({
      undo: () => waitUndo.promise,
      redo: vi.fn(),
    });

    const firstUndo = manager.undo();
    expect(manager.getSnapshot().isApplying).toBe(true);

    expect(await manager.undo()).toBe(false);
    expect(await manager.redo()).toBe(false);

    waitUndo.resolve();
    expect(await firstUndo).toBe(true);
    expect(manager.getSnapshot()).toMatchObject({ isApplying: false, redoCount: 1, canRedo: true });
  });

  it("can clear all stacks", async () => {
    const manager = createUndoRedoManager();
    manager.push({ undo: vi.fn(), redo: vi.fn() });
    await manager.undo();
    expect(manager.getSnapshot()).toMatchObject({ undoCount: 0, redoCount: 1 });

    manager.clearAll();
    expect(manager.getSnapshot()).toMatchObject({
      undoCount: 0,
      redoCount: 0,
      canUndo: false,
      canRedo: false,
    });
  });
});
