import { describe, it, expect } from "vitest";
import { contrastTextColor } from "../lib/color-utils.js";

describe("contrastTextColor", () => {
  it("returns dark text for light backgrounds", () => {
    expect(contrastTextColor("#ffffff")).toBe("#1E293B");
    expect(contrastTextColor("#fdecea")).toBe("#1E293B");
    expect(contrastTextColor("#fff4db")).toBe("#1E293B");
    expect(contrastTextColor("#f39c12")).toBe("#1E293B"); // orange (lum 0.43)
  });

  it("returns white text for dark backgrounds", () => {
    expect(contrastTextColor("#000000")).toBe("#fff");
    expect(contrastTextColor("#e74c3c")).toBe("#fff"); // red (lum 0.22)
    expect(contrastTextColor("#8957e5")).toBe("#fff"); // purple (lum 0.18)
    expect(contrastTextColor("#27AE60")).toBe("#fff"); // green (lum 0.32)
  });

  it("handles 3-digit hex", () => {
    expect(contrastTextColor("#fff")).toBe("#1E293B");
    expect(contrastTextColor("#000")).toBe("#fff");
  });

  it("handles hex without #", () => {
    expect(contrastTextColor("ffffff")).toBe("#1E293B");
    expect(contrastTextColor("000000")).toBe("#fff");
  });

  it("returns dark text for invalid input", () => {
    expect(contrastTextColor("not-a-color")).toBe("#1E293B");
    expect(contrastTextColor("")).toBe("#1E293B");
  });
});
