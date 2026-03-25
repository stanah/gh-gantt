import { describe, it, expect } from "vitest";
import { contrastTextColor } from "../lib/color-utils.js";

describe("contrastTextColor", () => {
  it("returns dark text for light backgrounds", () => {
    expect(contrastTextColor("#ffffff")).toBe("#1E293B");
    expect(contrastTextColor("#fdecea")).toBe("#1E293B");
    expect(contrastTextColor("#fff4db")).toBe("#1E293B");
    expect(contrastTextColor("#f39c12")).toBe("#1E293B"); // orange
  });

  it("picks the candidate with higher contrast ratio", () => {
    // #e74c3c (red): dark text wins by tiny margin (3.83 vs 3.82)
    expect(contrastTextColor("#e74c3c")).toBe("#1E293B");
    // #27AE60 (green): dark text wins (5.09 vs 2.87)
    expect(contrastTextColor("#27AE60")).toBe("#1E293B");
    // #8957e5 (purple): light text wins (4.61 vs 3.18)
    expect(contrastTextColor("#8957e5")).toBe("#fff");
  });

  it("returns white text for very dark backgrounds", () => {
    expect(contrastTextColor("#000000")).toBe("#fff");
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
