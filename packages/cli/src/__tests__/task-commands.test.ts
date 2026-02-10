import { describe, it, expect } from "vitest";
import { filterTasks } from "../commands/task/list.js";
import { applyTaskUpdate } from "../commands/task/update.js";
import {
  addDependency,
  removeDependency,
  setParent,
  removeParent,
} from "../commands/task/link.js";
import type { Config, Task } from "@gh-gantt/shared";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1",
    type: "task",
    github_issue: 1,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "Test task",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeConfig(): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "owner", repo: "repo", project_number: 1 },
    },
    sync: {
      conflict_strategy: "remote-wins",
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000", github_label: null },
      epic: { label: "Epic", display: "summary", color: "#00f", github_label: "epic" },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
  };
}

// --- filterTasks ---

describe("filterTasks", () => {
  const tasks = [
    makeTask({ id: "owner/repo#1", start_date: "2026-01-01", end_date: "2026-01-10" }),
    makeTask({ id: "owner/repo#2", start_date: null, end_date: null, date: null }),
    makeTask({ id: "owner/repo#3", date: "2026-02-01" }),
    makeTask({ id: "owner/repo#4", type: "epic", state: "closed" }),
  ];

  it("returns all tasks with no filters", () => {
    expect(filterTasks(tasks, {})).toHaveLength(4);
  });

  it("filters backlog tasks (no dates)", () => {
    const result = filterTasks(tasks, { backlog: true });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#2", "owner/repo#4"]);
  });

  it("filters scheduled tasks (have dates)", () => {
    const result = filterTasks(tasks, { scheduled: true });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1", "owner/repo#3"]);
  });

  it("filters by type", () => {
    const result = filterTasks(tasks, { type: "epic" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("owner/repo#4");
  });

  it("filters by state", () => {
    const result = filterTasks(tasks, { state: "closed" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("owner/repo#4");
  });

  it("combines filters with AND logic", () => {
    const result = filterTasks(tasks, { backlog: true, state: "closed" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("owner/repo#4");
  });
});

// --- applyTaskUpdate ---

describe("applyTaskUpdate", () => {
  const config = makeConfig();

  it("updates title", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { title: "New title" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.title).toBe("New title");
  });

  it("updates type", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { type: "epic" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.type).toBe("epic");
  });

  it("rejects unknown type", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { type: "unknown" }, config);
    expect(result.error).toContain("Unknown task type");
  });

  it("updates start date", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { startDate: "2026-03-01" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.start_date).toBe("2026-03-01");
  });

  it("clears start date with 'none'", () => {
    const task = makeTask({ start_date: "2026-03-01" });
    const result = applyTaskUpdate(task, { startDate: "none" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.start_date).toBeNull();
  });

  it("rejects invalid date format", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { startDate: "not-a-date" }, config);
    expect(result.error).toContain("Invalid start date format");
  });

  it("adds assignee", () => {
    const task = makeTask({ assignees: ["alice"] });
    const result = applyTaskUpdate(task, { assignee: "bob" }, config);
    expect(result.task.assignees).toEqual(["alice", "bob"]);
  });

  it("does not duplicate assignee", () => {
    const task = makeTask({ assignees: ["alice"] });
    const result = applyTaskUpdate(task, { assignee: "alice" }, config);
    expect(result.task.assignees).toEqual(["alice"]);
  });

  it("removes assignee", () => {
    const task = makeTask({ assignees: ["alice", "bob"] });
    const result = applyTaskUpdate(task, { removeAssignee: "alice" }, config);
    expect(result.task.assignees).toEqual(["bob"]);
  });

  it("updates updated_at", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { title: "Changed" }, config);
    expect(result.task.updated_at).not.toBe(task.updated_at);
  });
});

// --- link operations ---

describe("addDependency", () => {
  it("adds a blocking dependency", () => {
    const task = makeTask();
    const result = addDependency(task, "owner/repo#2");
    expect(result.blocked_by).toHaveLength(1);
    expect(result.blocked_by[0]).toEqual({
      task: "owner/repo#2",
      type: "finish-to-start",
      lag: 0,
    });
  });

  it("does not add duplicate dependency", () => {
    const task = makeTask({
      blocked_by: [{ task: "owner/repo#2", type: "finish-to-start", lag: 0 }],
    });
    const result = addDependency(task, "owner/repo#2");
    expect(result.blocked_by).toHaveLength(1);
  });
});

describe("removeDependency", () => {
  it("removes a blocking dependency", () => {
    const task = makeTask({
      blocked_by: [
        { task: "owner/repo#2", type: "finish-to-start", lag: 0 },
        { task: "owner/repo#3", type: "finish-to-start", lag: 0 },
      ],
    });
    const result = removeDependency(task, "owner/repo#2");
    expect(result.blocked_by).toHaveLength(1);
    expect(result.blocked_by[0].task).toBe("owner/repo#3");
  });

  it("handles removing non-existent dependency", () => {
    const task = makeTask();
    const result = removeDependency(task, "owner/repo#99");
    expect(result.blocked_by).toHaveLength(0);
  });
});

describe("setParent", () => {
  it("sets parent and updates sub_tasks", () => {
    const tasks = [
      makeTask({ id: "owner/repo#1" }),
      makeTask({ id: "owner/repo#2", sub_tasks: [] }),
    ];
    const result = setParent(tasks, "owner/repo#1", "owner/repo#2");
    const child = result.find((t) => t.id === "owner/repo#1")!;
    const parent = result.find((t) => t.id === "owner/repo#2")!;
    expect(child.parent).toBe("owner/repo#2");
    expect(parent.sub_tasks).toContain("owner/repo#1");
  });

  it("removes from old parent when re-parenting", () => {
    const tasks = [
      makeTask({ id: "owner/repo#1", parent: "owner/repo#2" }),
      makeTask({ id: "owner/repo#2", sub_tasks: ["owner/repo#1"] }),
      makeTask({ id: "owner/repo#3", sub_tasks: [] }),
    ];
    const result = setParent(tasks, "owner/repo#1", "owner/repo#3");
    const oldParent = result.find((t) => t.id === "owner/repo#2")!;
    const newParent = result.find((t) => t.id === "owner/repo#3")!;
    const child = result.find((t) => t.id === "owner/repo#1")!;
    expect(oldParent.sub_tasks).not.toContain("owner/repo#1");
    expect(newParent.sub_tasks).toContain("owner/repo#1");
    expect(child.parent).toBe("owner/repo#3");
  });
});

describe("removeParent", () => {
  it("removes parent and updates old parent sub_tasks", () => {
    const tasks = [
      makeTask({ id: "owner/repo#1", parent: "owner/repo#2" }),
      makeTask({ id: "owner/repo#2", sub_tasks: ["owner/repo#1"] }),
    ];
    const result = removeParent(tasks, "owner/repo#1");
    const child = result.find((t) => t.id === "owner/repo#1")!;
    const parent = result.find((t) => t.id === "owner/repo#2")!;
    expect(child.parent).toBeNull();
    expect(parent.sub_tasks).not.toContain("owner/repo#1");
  });

  it("handles task with no parent", () => {
    const tasks = [makeTask({ id: "owner/repo#1", parent: null })];
    const result = removeParent(tasks, "owner/repo#1");
    expect(result.find((t) => t.id === "owner/repo#1")!.parent).toBeNull();
  });
});
