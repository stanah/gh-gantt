import { describe, expect, it } from "vitest";
import {
  getNextSelection,
  isEditableTarget,
  resolveShortcutAction,
} from "../hooks/useKeyboardShortcuts.js";

function asTarget(value: unknown): EventTarget {
  return value as EventTarget;
}

describe("isEditableTarget", () => {
  it("returns true for input-like elements", () => {
    expect(isEditableTarget(asTarget({ tagName: "input" }))).toBe(true);
    expect(isEditableTarget(asTarget({ tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditableTarget(asTarget({ tagName: "select" }))).toBe(true);
  });

  it("returns true for content editable targets", () => {
    expect(isEditableTarget(asTarget({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });

  it("returns false for non-editable targets", () => {
    expect(isEditableTarget(asTarget({ tagName: "DIV" }))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("resolveShortcutAction", () => {
  it("maps j/k to navigation actions", () => {
    expect(resolveShortcutAction({ key: "j" })).toBe("selectNext");
    expect(resolveShortcutAction({ key: "k" })).toBe("selectPrev");
  });

  it("maps space to collapse toggle", () => {
    expect(resolveShortcutAction({ key: " " })).toBe("toggleCollapse");
    expect(resolveShortcutAction({ key: "Spacebar", code: "Space" })).toBe("toggleCollapse");
  });

  it("maps ctrl/cmd+k to search focus", () => {
    expect(resolveShortcutAction({ key: "k", ctrlKey: true })).toBe("focusSearch");
    expect(resolveShortcutAction({ key: "K", metaKey: true })).toBe("focusSearch");
  });

  it("maps ctrl/cmd+z to undo and ctrl/cmd+shift+z to redo", () => {
    expect(resolveShortcutAction({ key: "z", ctrlKey: true })).toBe("undo");
    expect(resolveShortcutAction({ key: "Z", metaKey: true })).toBe("undo");
    expect(resolveShortcutAction({ key: "z", ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(resolveShortcutAction({ key: "Z", metaKey: true, shiftKey: true })).toBe("redo");
  });

  it("maps ? to help toggle", () => {
    expect(resolveShortcutAction({ key: "?" })).toBe("toggleHelp");
    expect(resolveShortcutAction({ key: "/", shiftKey: true })).toBe("toggleHelp");
  });

  it("disables shortcuts while typing in editable elements", () => {
    expect(
      resolveShortcutAction({
        key: "j",
        target: asTarget({ tagName: "INPUT" }),
      }),
    ).toBeNull();
    expect(
      resolveShortcutAction({
        key: "k",
        ctrlKey: true,
        target: asTarget({ isContentEditable: true }),
      }),
    ).toBeNull();
    expect(
      resolveShortcutAction({
        key: "z",
        metaKey: true,
        target: asTarget({ tagName: "TEXTAREA" }),
      }),
    ).toBeNull();
  });
});

describe("getNextSelection", () => {
  const ids = ["a", "b", "c"];

  it("selects first/last when nothing is selected", () => {
    expect(getNextSelection(ids, null, "next")).toBe("a");
    expect(getNextSelection(ids, null, "prev")).toBe("c");
  });

  it("moves selection and clamps at boundaries", () => {
    expect(getNextSelection(ids, "a", "next")).toBe("b");
    expect(getNextSelection(ids, "c", "next")).toBe("c");
    expect(getNextSelection(ids, "c", "prev")).toBe("b");
    expect(getNextSelection(ids, "a", "prev")).toBe("a");
  });

  it("falls back when selected id is absent", () => {
    expect(getNextSelection(ids, "x", "next")).toBe("a");
    expect(getNextSelection(ids, "x", "prev")).toBe("c");
  });

  it("returns null for empty list", () => {
    expect(getNextSelection([], null, "next")).toBeNull();
  });
});
