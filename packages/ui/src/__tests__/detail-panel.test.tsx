// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { TaskDetailPanel } from "../components/TaskDetailPanel.js";
import type { Task, Config } from "../types/index.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "TASK-1",
    type: "task",
    github_issue: 42,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: "Test Task Title",
    body: "Task description body",
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: { Status: "In Progress" },
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    date: null,
    blocked_by: [],
    _progress: 50,
    ...overrides,
  };
}

const config: Config = {
  version: "1",
  project: {
    name: "Test Project",
    github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#4a90d9", github_label: null },
    epic: { label: "Epic", display: "summary", color: "#e5a00d", github_label: "epic" },
  },
  type_hierarchy: { epic: ["task"] },
  statuses: {
    field_name: "Status",
    values: {
      "In Progress": { color: "#4a90d9", done: false },
      Done: { color: "#2ea44f", done: true },
    },
  },
  gantt: {
    default_view: "month",
    working_days: [1, 2, 3, 4, 5],
    colors: {
      critical_path: "#ff0000",
      on_track: "#00ff00",
      at_risk: "#ffaa00",
      overdue: "#ff0000",
    },
  },
};

const sprintConfig: Config = {
  ...config,
  sprints: [
    {
      name: "Sprint 1",
      start_date: "2026-01-01",
      end_date: "2026-01-14",
      color: "#2563eb",
    },
    {
      name: "Sprint 2",
      start_date: "2026-02-01",
      end_date: "2026-02-14",
      color: "#16a34a",
    },
  ],
};

const priorityConfig: Config = {
  ...config,
  sync: {
    ...config.sync,
    field_mapping: { ...config.sync.field_mapping, priority: "Priority" },
  },
};

describe("TaskDetailPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title and issue number", () => {
    const task = makeTask();
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={task}
        config={config}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    expect(html).toContain("Test Task Title");
    expect(html).toContain("#42");
  });

  it("renders description", () => {
    const task = makeTask({ body: "Important description text" });
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={task}
        config={config}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    expect(html).toContain("Important description text");
  });

  describe("[NFR-STABILITY-011-AC1] Markdown preview の安全化", () => {
    it("未保存の Markdown preview はリンクとして再解釈しない", () => {
      const task = makeTask({ body: "Initial body" });
      const { getByRole, queryByRole } = render(
        <TaskDetailPanel
          task={task}
          config={config}
          comments={[]}
          allTasks={[task]}
          onUpdate={() => {}}
          onClose={() => {}}
          onSelectTask={() => {}}
        />,
      );

      fireEvent.click(getByRole("button", { name: "Edit" }));
      fireEvent.change(getByRole("textbox"), {
        target: { value: "[draft](https://example.com)" },
      });
      fireEvent.click(getByRole("button", { name: "Preview" }));

      expect(queryByRole("link", { name: "draft" })).toBeNull();
    });
  });

  it("[FR-VIS-022-AC1] 詳細パネルの操作ボタンにアクセシブルラベルを付与する", () => {
    const task = makeTask();
    const { getByRole } = render(
      <TaskDetailPanel
        task={task}
        config={config}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    const copyButton = getByRole("button", { name: "Copy task info as JSON" });
    expect(copyButton.getAttribute("aria-label")).toBe("Copy task info as JSON");
    expect(copyButton.getAttribute("title")).toBe("Copy task info as JSON");

    const closeButton = getByRole("button", { name: "Close task details" });
    expect(closeButton.getAttribute("aria-label")).toBe("Close task details");
    expect(closeButton.getAttribute("title")).toBe("Close task details");
  });

  it("[FR-VIS-022-AC1] コピー成功をライブリージョンで通知する", async () => {
    const task = makeTask();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    const { findByRole, getByRole } = render(
      <TaskDetailPanel
        task={task}
        config={config}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Copy task info as JSON" }));

    expect((await findByRole("status")).textContent).toBe("Task info copied");
  });

  it("[FR-VIS-022-AC1] コピー失敗をライブリージョンで通知する", async () => {
    const task = makeTask();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("clipboard unavailable")),
      },
    });
    const { findByRole, getByRole } = render(
      <TaskDetailPanel
        task={task}
        config={config}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Copy task info as JSON" }));

    expect((await findByRole("status")).textContent).toBe("Could not copy task info");
  });

  it("renders sub-tasks with titles", () => {
    const childTask = makeTask({ id: "TASK-2", title: "Child Task Title", parent: "TASK-1" });
    const parentTask = makeTask({ sub_tasks: ["TASK-2"] });
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={parentTask}
        config={config}
        comments={[]}
        allTasks={[parentTask, childTask]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    expect(html).toContain("Child Task Title");
  });

  it("[FR-VIS-011-AC1][FR-VIS-011-AC2] sprint 選択で task の期間を sprint 期間へ更新する", () => {
    const task = makeTask({
      start_date: null,
      end_date: null,
    });
    const onUpdate = vi.fn();
    const { getByLabelText } = render(
      <TaskDetailPanel
        task={task}
        config={sprintConfig}
        comments={[]}
        allTasks={[task]}
        onUpdate={onUpdate}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    const select = getByLabelText("Sprint") as HTMLSelectElement;
    expect(select.value).toBe("");

    fireEvent.change(select, { target: { value: "Sprint 2" } });

    expect(onUpdate).toHaveBeenCalledWith({
      start_date: "2026-02-01",
      end_date: "2026-02-14",
    });
  });

  it("[FR-VIS-011-AC1] task の期間が sprint 内にある場合は現在 sprint として表示する", () => {
    const task = makeTask({
      start_date: "2026-01-02",
      end_date: "2026-01-10",
    });
    const { getByLabelText } = render(
      <TaskDetailPanel
        task={task}
        config={sprintConfig}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    const select = getByLabelText("Sprint") as HTMLSelectElement;
    expect(select.value).toBe("Sprint 1");
  });

  it("[FR-VIS-011-AC3] sprint 未設定では sprint 選択を表示しない", () => {
    const task = makeTask();
    const { queryByLabelText } = render(
      <TaskDetailPanel
        task={task}
        config={config}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );

    expect(queryByLabelText("Sprint")).toBeNull();
  });
});

describe("[FR-VIS-006-AC3] 1カラムレイアウトでもタスクの Status、Priority、Type、日付を編集できる", () => {
  afterEach(() => {
    cleanup();
  });

  it("1カラムで Status、Priority、Type、Start Date、End Date を変更できる", () => {
    const task = makeTask({ custom_fields: { Status: "In Progress", Priority: "medium" } });
    const onUpdate = vi.fn();
    const { getByLabelText } = render(
      <TaskDetailPanel
        task={task}
        config={priorityConfig}
        comments={[]}
        allTasks={[task]}
        onUpdate={onUpdate}
        onClose={() => {}}
        onSelectTask={() => {}}
        width={400}
      />,
    );

    fireEvent.change(getByLabelText("Status"), { target: { value: "Done" } });
    fireEvent.change(getByLabelText("Priority"), { target: { value: "high" } });
    fireEvent.change(getByLabelText("Type"), { target: { value: "epic" } });
    fireEvent.change(getByLabelText("Start Date"), { target: { value: "2026-02-01" } });
    fireEvent.change(getByLabelText("End Date"), { target: { value: "2026-02-14" } });

    expect(onUpdate).toHaveBeenCalledWith({
      custom_fields: { Status: "Done", Priority: "medium" },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      custom_fields: { Status: "Done", Priority: "high" },
    });
    expect(onUpdate).toHaveBeenCalledWith({ type: "epic" });
    expect(onUpdate).toHaveBeenCalledWith({ start_date: "2026-02-01" });
    expect(onUpdate).toHaveBeenCalledWith({ end_date: "2026-02-14" });
  });

  it("1カラムで milestone の Due Date を変更できる", () => {
    const milestone = makeTask({
      type: "milestone",
      id: "stanah/gh-gantt#7",
      github_issue: null,
      title: "Milestone",
      date: "2026-03-01",
      start_date: null,
      end_date: null,
    });
    const onUpdate = vi.fn();
    const { getByLabelText } = render(
      <TaskDetailPanel
        task={milestone}
        config={priorityConfig}
        comments={[]}
        allTasks={[milestone]}
        onUpdate={onUpdate}
        onClose={() => {}}
        onSelectTask={() => {}}
        width={400}
      />,
    );

    fireEvent.change(getByLabelText("Due Date"), { target: { value: "2026-03-15" } });

    expect(onUpdate).toHaveBeenCalledWith({ date: "2026-03-15" });
  });

  it("2カラムの既存メタ編集も維持する", () => {
    const task = makeTask({ custom_fields: { Status: "In Progress", Priority: "medium" } });
    const onUpdate = vi.fn();
    const { getByLabelText } = render(
      <TaskDetailPanel
        task={task}
        config={priorityConfig}
        comments={[]}
        allTasks={[task]}
        onUpdate={onUpdate}
        onClose={() => {}}
        onSelectTask={() => {}}
        width={640}
      />,
    );

    fireEvent.change(getByLabelText("Status"), { target: { value: "Done" } });

    expect(onUpdate).toHaveBeenCalledWith({
      custom_fields: { Status: "Done", Priority: "medium" },
    });
  });
});

describe("[FR-VIS-006-AC4] 1カラムレイアウトで Open/Closed の state を重複表示しない", () => {
  afterEach(() => {
    cleanup();
  });

  it("1カラムでは state badge を DetailHeader の1件だけ表示する", () => {
    const task = makeTask();
    const { getAllByText } = render(
      <TaskDetailPanel
        task={task}
        config={priorityConfig}
        comments={[]}
        allTasks={[task]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
        width={400}
      />,
    );

    expect(getAllByText("Open")).toHaveLength(1);
  });
});
