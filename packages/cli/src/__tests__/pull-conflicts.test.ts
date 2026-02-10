import { describe, it, expect, vi, beforeEach } from "vitest";
import { confirmConflicts } from "../commands/pull.js";
import type { Conflict } from "../sync/conflict.js";

const conflicts: Conflict[] = [
  {
    taskId: "owner/repo#5",
    title: "Implement auth flow",
    localHash: "aaa",
    remoteHash: "bbb",
    snapshotHash: "ccc",
  },
  {
    taskId: "owner/repo#12",
    title: "Update dashboard layout",
    localHash: "ddd",
    remoteHash: "eee",
    snapshotHash: "fff",
  },
];

function createMockIO(answer?: string) {
  const closeFn = vi.fn();
  const questionFn = vi.fn().mockResolvedValue(answer ?? "");
  return {
    isTTY: true,
    createPrompt: vi.fn(() => ({ question: questionFn, close: closeFn })),
    closeFn,
    questionFn,
  };
}

describe("confirmConflicts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("prints conflict task list in warning", async () => {
    const io = createMockIO("n");
    await confirmConflicts(conflicts, {}, io);

    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(warnCalls).toContain("owner/repo#5: Implement auth flow");
    expect(warnCalls).toContain("owner/repo#12: Update dashboard layout");
    expect(warnCalls).toContain("2 task(s) have conflicting changes");
  });

  it("returns proceed with --force without prompting", async () => {
    const io = createMockIO();
    const result = await confirmConflicts(conflicts, { force: true }, io);

    expect(result.action).toBe("proceed");
    expect(io.createPrompt).not.toHaveBeenCalled();
  });

  it("returns proceed with --dry-run without prompting", async () => {
    const io = createMockIO();
    const result = await confirmConflicts(conflicts, { dryRun: true }, io);

    expect(result.action).toBe("proceed");
    expect(io.createPrompt).not.toHaveBeenCalled();
  });

  it("returns abort in non-TTY environment", async () => {
    const io = createMockIO();
    io.isTTY = false;
    const result = await confirmConflicts(conflicts, {}, io);

    expect(result.action).toBe("abort");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("--force"),
    );
    expect(io.createPrompt).not.toHaveBeenCalled();
  });

  it("returns proceed when user answers 'y'", async () => {
    const io = createMockIO("y");
    const result = await confirmConflicts(conflicts, {}, io);

    expect(result.action).toBe("proceed");
  });

  it("returns proceed when user answers 'Y'", async () => {
    const io = createMockIO("Y");
    const result = await confirmConflicts(conflicts, {}, io);

    expect(result.action).toBe("proceed");
  });

  it("returns abort when user answers 'n'", async () => {
    const io = createMockIO("n");
    const result = await confirmConflicts(conflicts, {}, io);

    expect(result.action).toBe("abort");
  });

  it("returns abort on empty enter (default No)", async () => {
    const io = createMockIO("");
    const result = await confirmConflicts(conflicts, {}, io);

    expect(result.action).toBe("abort");
  });

  it("closes readline in finally block", async () => {
    const io = createMockIO("y");
    await confirmConflicts(conflicts, {}, io);

    expect(io.closeFn).toHaveBeenCalledOnce();
  });

  it("closes readline even when question rejects", async () => {
    const closeFn = vi.fn();
    const questionFn = vi.fn().mockRejectedValue(new Error("interrupted"));
    const io = {
      isTTY: true,
      createPrompt: vi.fn(() => ({ question: questionFn, close: closeFn })),
    };

    await expect(confirmConflicts(conflicts, {}, io)).rejects.toThrow("interrupted");
    expect(closeFn).toHaveBeenCalledOnce();
  });
});
