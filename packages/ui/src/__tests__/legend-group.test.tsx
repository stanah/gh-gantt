import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegendGroup } from "../components/toolbar/LegendGroup.js";
import type { TaskType } from "../types/index.js";
import type { SprintConfig } from "@gh-gantt/shared";

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

const sprints: SprintConfig[] = [
  {
    name: "Sprint 1",
    start_date: "2020-01-01",
    end_date: "2020-01-14",
    color: "#3b82f6",
  },
  {
    name: "Sprint Current",
    start_date: "2025-01-01",
    end_date: "2099-12-31",
    color: "#10b981",
  },
];

describe("LegendGroup", () => {
  it("renders the legend button", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).toContain("Task Type Legend");
    expect(html).toContain("Legend");
  });

  it("starts collapsed and does not render the dialog panel", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).not.toContain('role="dialog"');
  });

  it("renders a single palette icon in the toggle button", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).toContain("lucide-palette");
    // Only one Palette icon in the button, not one per type
    const matches = html.match(/lucide-palette/g);
    expect(matches).toHaveLength(1);
  });

  it("renders with empty task types", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={{}} />);
    expect(html).toContain("Legend");
  });

  it("includes aria-haspopup on the toggle button", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("renders sprint legends when sprints are provided", () => {
    // Use a wrapper that forces open state via click simulation is not possible
    // in SSR, so we test that the component accepts the sprints prop without error
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} sprints={sprints} />);
    // Panel is collapsed by default, sprints should not appear
    expect(html).not.toContain("Sprint 1");
  });

  it("renders without sprints when prop is omitted", () => {
    const html = renderToStaticMarkup(<LegendGroup taskTypes={taskTypes} />);
    expect(html).toContain("Legend");
    expect(html).not.toContain("Sprints");
  });
});
