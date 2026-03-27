// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, act, cleanup } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../contexts/ThemeContext.js";

function TestConsumer() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button data-testid="set-dark" onClick={() => setTheme("dark")}>
        Dark
      </button>
      <button data-testid="set-light" onClick={() => setTheme("light")}>
        Light
      </button>
      <button data-testid="set-system" onClick={() => setTheme("system")}>
        System
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  let matchMediaListeners: Array<(e: { matches: boolean }) => void>;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    matchMediaListeners = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          matchMediaListeners.push(cb);
        },
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("defaults to system theme", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(getByTestId("theme").textContent).toBe("system");
    expect(getByTestId("resolved").textContent).toBe("light");
  });

  it("reads initial theme from localStorage", () => {
    localStorage.setItem("gh-gantt-theme", "dark");
    const { getByTestId } = render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(getByTestId("theme").textContent).toBe("dark");
    expect(getByTestId("resolved").textContent).toBe("dark");
  });

  it("sets data-theme on document element", () => {
    localStorage.setItem("gh-gantt-theme", "dark");
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("persists theme to localStorage on change", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    act(() => getByTestId("set-dark").click());
    expect(localStorage.getItem("gh-gantt-theme")).toBe("dark");
    expect(getByTestId("resolved").textContent).toBe("dark");
  });

  it("resolves system theme based on matchMedia", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          matchMediaListeners.push(cb);
        },
        removeEventListener: vi.fn(),
      })),
    );
    const { getByTestId } = render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(getByTestId("theme").textContent).toBe("system");
    expect(getByTestId("resolved").textContent).toBe("dark");
  });

  it("reacts to OS theme changes when set to system", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(getByTestId("resolved").textContent).toBe("light");
    act(() => {
      for (const listener of matchMediaListeners) {
        listener({ matches: true });
      }
    });
    expect(getByTestId("resolved").textContent).toBe("dark");
  });
});
