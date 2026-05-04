// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SELECTED_TASK_QUERY_KEY, useTaskDeepLink } from "../hooks/useTaskDeepLink.js";
import type { Task } from "../types/index.js";

const taskId = "stanah/gh-gantt#235";

function makeTask(id = taskId): Task {
  return {
    id,
    type: "task",
    github_issue: 235,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: "Deep link task",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-05-04T00:00:00Z",
    updated_at: "2026-05-04T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: "2026-05-04",
    end_date: null,
    date: null,
    blocked_by: [],
  };
}

function DeepLinkProbe({ tasks = [makeTask()] }: { tasks?: Task[] }) {
  const { selectedTaskId, setSelectedTaskId } = useTaskDeepLink(tasks);
  return (
    <div>
      <output aria-label="selected task">{selectedTaskId ?? ""}</output>
      <button type="button" onClick={() => setSelectedTaskId(taskId)}>
        select
      </button>
      <button type="button" onClick={() => setSelectedTaskId(null)}>
        clear
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("[FR-VIS-021] 選択中タスクの URL deep link", () => {
  it("[FR-VIS-021-AC1] task query を初期選択として復元する", () => {
    window.history.replaceState({}, "", `/?task=${encodeURIComponent(taskId)}`);

    const { getByLabelText } = render(<DeepLinkProbe />);

    expect(getByLabelText("selected task").textContent).toBe(taskId);
  });

  it("[FR-VIS-021-AC2] タスク選択を task query に反映し既存 query を維持する", () => {
    window.history.replaceState({}, "", "/?labels=pkg%3Aui");
    const { getByText } = render(<DeepLinkProbe />);

    fireEvent.click(getByText("select"));

    const params = new URL(window.location.href).searchParams;
    expect(params.get(SELECTED_TASK_QUERY_KEY)).toBe(taskId);
    expect(params.get("labels")).toBe("pkg:ui");
  });

  it("[FR-VIS-021-AC3] 選択解除または存在しない task query では task query を削除する", async () => {
    window.history.replaceState({}, "", `/?labels=pkg%3Aui&task=${encodeURIComponent("missing")}`);
    const { getByLabelText, getByText } = render(<DeepLinkProbe />);

    await waitFor(() => {
      expect(getByLabelText("selected task").textContent).toBe("");
    });
    expect(new URL(window.location.href).searchParams.has(SELECTED_TASK_QUERY_KEY)).toBe(false);

    fireEvent.click(getByText("select"));
    expect(new URL(window.location.href).searchParams.get(SELECTED_TASK_QUERY_KEY)).toBe(taskId);

    fireEvent.click(getByText("clear"));
    expect(new URL(window.location.href).searchParams.has(SELECTED_TASK_QUERY_KEY)).toBe(false);
  });
});
