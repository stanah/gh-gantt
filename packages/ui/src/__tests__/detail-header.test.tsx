import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailHeader } from "../components/detail/DetailHeader.js";

const baseTask = {
  id: "TASK-1",
  title: "My Task Title",
  github_issue: 42,
  github_repo: "stanah/gh-gantt",
  state: "open" as const,
  parent: null,
  _progress: 60,
};

const parentTask = {
  id: "EPIC-1",
  title: "Parent Epic",
  github_issue: 10,
};

describe("DetailHeader", () => {
  it("renders current task title and issue number", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );

    expect(html).toContain("My Task Title");
    expect(html).toContain("#42");
  });

  it("renders breadcrumb when parent task is present", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={parentTask} onSelectTask={() => {}} />,
    );

    expect(html).toContain("Parent Epic");
    expect(html).toContain("#10");
  });

  it("does not render breadcrumb when parent task is null", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );

    expect(html).not.toContain("Parent Epic");
    expect(html).not.toContain("#10");
  });

  it("renders Open state badge", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );

    expect(html).toContain("Open");
    expect(html).toContain("var(--color-success-bg)");
    expect(html).toContain("var(--color-success)");
  });

  it("renders Closed state badge", () => {
    const closedTask = { ...baseTask, state: "closed" as const };
    const html = renderToStaticMarkup(
      <DetailHeader task={closedTask} parentTask={null} onSelectTask={() => {}} />,
    );

    expect(html).toContain("Closed");
    expect(html).toContain("var(--color-complete-bg)");
    expect(html).toContain("var(--color-complete)");
  });

  it("renders progress bar for non-milestone tasks", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );

    expect(html).toContain("60%");
  });

  it("does not render progress bar for milestone tasks", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} isMilestone={true} />,
    );

    expect(html).not.toContain("60%");
  });

  it("generates correct GitHub issue URL", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );

    expect(html).toContain("https://github.com/stanah/gh-gantt/issues/42");
  });

  it("generates correct GitHub milestone URL for milestone tasks", () => {
    const milestoneTask = {
      ...baseTask,
      id: "milestone#5",
      github_issue: null,
    };
    const html = renderToStaticMarkup(
      <DetailHeader
        task={milestoneTask}
        parentTask={null}
        onSelectTask={() => {}}
        isMilestone={true}
      />,
    );

    expect(html).toContain("https://github.com/stanah/gh-gantt/milestone/5");
  });

  it("renders external link icon on task title", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );

    // External link icon — arrow-up-right svg
    expect(html).toContain("<svg");
  });
});
