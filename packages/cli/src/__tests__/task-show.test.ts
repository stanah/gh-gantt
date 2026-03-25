import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTaskShowCommand } from "../commands/task/show.js";

vi.mock("../store/config.js", () => ({
  ConfigStore: vi.fn().mockImplementation(() => ({
    read: vi.fn().mockRejectedValue(new Error("config not found")),
  })),
}));

describe("show command error handling", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("catches I/O errors and sets exitCode=1", async () => {
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
