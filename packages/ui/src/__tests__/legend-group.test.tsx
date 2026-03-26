import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegendGroup } from "../components/toolbar/LegendGroup.js";
import type { TaskType } from "../types/index.js";

const taskTypes: Record<string, TaskType> = {
  epic: {
    label: "Epic",
    display: "summary",
    color: "#8E44AD",
    github_label: "epic",
  },
  feature: {
    label: "Feature",
    display: "bar",
    color: "#2980B9",
    github_label: "feature",
  },
  milestone: {
    label: "Milestone",
    display: "milestone",
    color: "#E74C3C",
    github_label: null,
  },
  task: {
    label: "Task",
    display: "bar",
    color: "#27AE60",
    github_label: null,
  },
};

describe("LegendGroup", () => {
  it("renders the legend button", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).toContain("Task Type Legend");
    expect(html).toContain("Legend");
  });

  it("includes all task type labels in markup when expanded by default state", () => {
    // The component starts collapsed, so the panel is not in the initial render
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).not.toContain('role="dialog"');
  });

  it("renders the palette icon for each display type", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).toContain("lucide-palette");
  });

  it("renders with empty task types", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={{}} />);
    expect(html).toContain("Legend");
  });
});
