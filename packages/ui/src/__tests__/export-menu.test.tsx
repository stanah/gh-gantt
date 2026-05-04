// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toolbar } from "../components/toolbar/Toolbar.js";

vi.mock("../components/toolbar/ThemeToggle.js", () => ({
  ThemeToggle: () => null,
}));

afterEach(() => {
  cleanup();
});

describe("[FR-VIS-019-AC4] Toolbar のエクスポートメニュー", () => {
  it("形式・範囲・2x オプションを選んで export handler に渡せる", () => {
    const onExport = vi.fn();
    const { getByLabelText, getByTitle } = render(
      <Toolbar
        projectName="Test Project"
        taskCount={1}
        activeScale="month"
        onScaleChange={() => {}}
        onScrollToToday={() => {}}
        onPull={() => {}}
        onPush={() => {}}
        syncing={null}
        displayOptions={new Set()}
        onToggleDisplayOption={() => {}}
        dependencyHighlightEnabled={false}
        onToggleDependencyHighlight={() => {}}
        hideClosed={false}
        onToggleHideClosed={() => {}}
        taskTypes={{
          task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
        }}
        enabledTypes={new Set(["task"])}
        onToggleType={() => {}}
        selectedAssignee={null}
        allAssignees={[]}
        onSelectAssignee={() => {}}
        searchQuery=""
        onSearchChange={() => {}}
        taskSortMode="default"
        onTaskSortModeChange={() => {}}
        onExport={onExport}
      />,
    );

    fireEvent.click(getByTitle("Export"));
    fireEvent.change(getByLabelText("Export format"), { target: { value: "png" } });
    fireEvent.change(getByLabelText("Export scope"), { target: { value: "project" } });
    fireEvent.click(getByLabelText("High resolution 2x"));
    fireEvent.click(getByLabelText("Run export"));

    expect(onExport).toHaveBeenCalledWith({
      format: "png",
      scope: "project",
      scaleFactor: 2,
    });
  });
});
