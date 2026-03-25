import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTaskShowCommand } from "../commands/task/show.js";

describe("show command error handling", () => {
  const originalCwd = process.cwd;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("catches I/O errors and sets exitCode=1", async () => {
    // Point to a non-existent directory to trigger I/O failure
    process.cwd = () => "/non-existent-path";

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cmd = createTaskShowCommand();
    await cmd.parseAsync(["show", "1"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to show task:"),
      expect.any(String),
    );
  });
});
