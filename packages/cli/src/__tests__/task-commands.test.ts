import { describe, it, expect, vi, afterEach } from "vitest";
import { filterTasks, sortTasks } from "../commands/task/list.js";
import { applyTaskUpdate, filterTasksForUpdate } from "../commands/task/update.js";
import { collectMilestones } from "../commands/milestone/list.js";
import { addDependency, removeDependency, setParent, removeParent } from "../commands/task/link.js";
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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "owner", repo: "repo", project_number: 1 },
    },
    sync: {
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
    ...overrides,
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

  // --- new filters ---

  const tasksExtended = [
    makeTask({
      id: "owner/repo#1",
      state: "open",
      assignees: ["alice"],
      labels: ["bug"],
      title: "Fix login error",
      body: "Users cannot login with SSO",
      custom_fields: { Status: "In Progress" },
      blocked_by: [],
      start_date: "2026-01-01",
      end_date: "2026-01-10",
    }),
    makeTask({
      id: "owner/repo#2",
      state: "open",
      assignees: ["bob"],
      labels: ["feature"],
      title: "Add search feature",
      body: "Full text search for tasks",
      custom_fields: { Status: "Todo" },
      blocked_by: [{ task: "owner/repo#1", type: "finish-to-start", lag: 0 }],
    }),
    makeTask({
      id: "owner/repo#3",
      state: "open",
      assignees: [],
      labels: [],
      title: "Update docs",
      body: null,
      custom_fields: { Status: "Todo" },
      blocked_by: [],
    }),
    makeTask({
      id: "owner/repo#4",
      state: "closed",
      assignees: ["alice", "bob"],
      labels: ["bug"],
      title: "Fix crash on startup",
      body: "App crashes when config missing",
      custom_fields: { Status: "Done" },
      blocked_by: [{ task: "owner/repo#5", type: "finish-to-start", lag: 0 }],
    }),
    makeTask({
      id: "owner/repo#5",
      state: "closed",
      assignees: [],
      labels: [],
      title: "Setup CI",
      body: null,
      custom_fields: {},
      blocked_by: [],
    }),
  ];

  it("filters unblocked tasks (no dependencies)", () => {
    const result = filterTasks(tasksExtended, { unblocked: true });
    // #1: no deps → unblocked
    // #2: blocked by #1 (open) → blocked
    // #3: no deps → unblocked
    // #4: blocked by #5 but #5 is closed → unblocked
    // #5: no deps → unblocked
    expect(result.map((t) => t.id)).toEqual([
      "owner/repo#1",
      "owner/repo#3",
      "owner/repo#4",
      "owner/repo#5",
    ]);
  });

  it("filters by assignee", () => {
    const result = filterTasks(tasksExtended, { assignee: "alice" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1", "owner/repo#4"]);
  });

  it("filters unassigned tasks", () => {
    const result = filterTasks(tasksExtended, { unassigned: true });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#3", "owner/repo#5"]);
  });

  it("filters by status custom field", () => {
    const result = filterTasks(tasksExtended, { status: "Todo", statusFieldName: "Status" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#2", "owner/repo#3"]);
  });

  it("filters by label", () => {
    const result = filterTasks(tasksExtended, { label: "bug" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1", "owner/repo#4"]);
  });

  it("filters by search query in title", () => {
    const result = filterTasks(tasksExtended, { search: "login" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1"]);
  });

  it("filters by search query in body (case insensitive)", () => {
    const result = filterTasks(tasksExtended, { search: "SSO" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1"]);
  });

  it("search matches partial text", () => {
    const result = filterTasks(tasksExtended, { search: "search" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#2"]);
  });

  it("combines new filters with AND logic", () => {
    const result = filterTasks(tasksExtended, { assignee: "alice", label: "bug", state: "open" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1"]);
  });

  it("combines unblocked with state", () => {
    const result = filterTasks(tasksExtended, { unblocked: true, state: "open" });
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1", "owner/repo#3"]);
  });
});

// --- sortTasks ---

describe("sortTasks", () => {
  const tasksForSort = [
    makeTask({
      id: "owner/repo#1",
      title: "Banana",
      type: "task",
      end_date: "2026-03-01",
      start_date: "2026-01-15",
    }),
    makeTask({
      id: "owner/repo#2",
      title: "Apple",
      type: "epic",
      end_date: null,
      start_date: "2026-01-01",
    }),
    makeTask({
      id: "owner/repo#3",
      title: "Cherry",
      type: "task",
      end_date: "2026-02-01",
      start_date: null,
    }),
  ];

  const config = makeConfig();

  it("sorts by title alphabetically", () => {
    const result = sortTasks(tasksForSort, "title", config);
    expect(result.map((t) => t.title)).toEqual(["Apple", "Banana", "Cherry"]);
  });

  it("sorts by end_date ascending (null last)", () => {
    const result = sortTasks(tasksForSort, "end_date", config);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#3", "owner/repo#1", "owner/repo#2"]);
  });

  it("sorts by start_date ascending (null last)", () => {
    const result = sortTasks(tasksForSort, "start_date", config);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#2", "owner/repo#1", "owner/repo#3"]);
  });

  it("sorts by type using config task_types order", () => {
    const result = sortTasks(tasksForSort, "type", config);
    // config has: task, epic → task first
    expect(result.map((t) => t.type)).toEqual(["task", "task", "epic"]);
  });

  it("sorts by multiple fields (comma-separated, first takes priority)", () => {
    const result = sortTasks(tasksForSort, "type,title", config);
    // tasks first (sorted by title): Banana, Cherry; then epic: Apple
    expect(result.map((t) => t.title)).toEqual(["Banana", "Cherry", "Apple"]);
  });

  it("sorts by priority using config field_mapping.priority", () => {
    const configWithPriority = makeConfig({
      sync: {
        auto_create_issues: false,
        field_mapping: {
          start_date: "Start",
          end_date: "End",
          status: "Status",
          priority: "Priority",
        },
      },
    });
    const tasksWithPriority = [
      makeTask({ id: "owner/repo#1", title: "Low", custom_fields: { Priority: "P2" } }),
      makeTask({ id: "owner/repo#2", title: "High", custom_fields: { Priority: "P0" } }),
      makeTask({ id: "owner/repo#3", title: "Medium", custom_fields: { Priority: "P1" } }),
    ];
    // Single Select field order is alphabetical when no option_ids available
    const result = sortTasks(tasksWithPriority, "priority", configWithPriority);
    expect(result.map((t) => t.title)).toEqual(["High", "Medium", "Low"]);
  });

  it("skips priority sort when field_mapping.priority is not configured", () => {
    const tasksWithPriority = [
      makeTask({ id: "owner/repo#1", title: "B" }),
      makeTask({ id: "owner/repo#2", title: "A" }),
    ];
    // priority sort should be skipped, fallback to original order
    const result = sortTasks(tasksWithPriority, "priority", config);
    expect(result.map((t) => t.title)).toEqual(["B", "A"]);
  });

  it("returns original order when sort field is empty", () => {
    const result = sortTasks(tasksForSort, "", config);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1", "owner/repo#2", "owner/repo#3"]);
  });
});

// --- applyTaskUpdate ---

describe("applyTaskUpdate", () => {
  const config = makeConfig();

  it("rejects update with no fields specified", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, {}, config);
    expect(result.error).toContain("at least one");
  });

  it("updates title", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { title: "New title" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.title).toBe("New title");
  });

  it("updates body", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { body: "New description" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.body).toBe("New description");
  });

  it("clears body with empty string", () => {
    const task = makeTask({ body: "Existing body" });
    const result = applyTaskUpdate(task, { body: "" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.body).toBe("");
  });

  it("does not change body when not specified", () => {
    const task = makeTask({ body: "Keep this" });
    const result = applyTaskUpdate(task, { title: "New title" }, config);
    expect(result.task.body).toBe("Keep this");
  });

  it("updates type", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { type: "epic" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.type).toBe("epic");
  });

  it("updates type and adds github_label", () => {
    const task = makeTask({ type: "task", labels: [] });
    const result = applyTaskUpdate(task, { type: "epic" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.type).toBe("epic");
    expect(result.task.labels).toContain("epic");
  });

  it("removes old github_label when changing type", () => {
    const task = makeTask({ type: "epic", labels: ["epic"] });
    const result = applyTaskUpdate(task, { type: "task" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.type).toBe("task");
    expect(result.task.labels).not.toContain("epic");
  });

  it("swaps github_label when both types have labels", () => {
    const configWithBug = makeConfig({
      task_types: {
        task: { label: "Task", display: "bar", color: "#000", github_label: null },
        epic: { label: "Epic", display: "summary", color: "#00f", github_label: "epic" },
        bug: { label: "Bug", display: "bar", color: "#f00", github_label: "bug" },
      },
    });
    const task = makeTask({ type: "bug", labels: ["bug", "other"] });
    const result = applyTaskUpdate(task, { type: "epic" }, configWithBug);
    expect(result.error).toBeUndefined();
    expect(result.task.type).toBe("epic");
    expect(result.task.labels).toContain("epic");
    expect(result.task.labels).not.toContain("bug");
    expect(result.task.labels).toContain("other");
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

  it("sets milestone", () => {
    const task = makeTask();
    const result = applyTaskUpdate(task, { milestone: "v1.0" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.milestone).toBe("v1.0");
  });

  it("clears milestone with 'none'", () => {
    const task = makeTask({ milestone: "v1.0" });
    const result = applyTaskUpdate(task, { milestone: "none" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.milestone).toBeNull();
  });

  it("adds label", () => {
    const task = makeTask({ labels: ["bug"] });
    const result = applyTaskUpdate(task, { label: "priority" }, config);
    expect(result.error).toBeUndefined();
    expect(result.task.labels).toEqual(["bug", "priority"]);
  });

  it("does not duplicate label", () => {
    const task = makeTask({ labels: ["bug"] });
    const result = applyTaskUpdate(task, { label: "bug" }, config);
    expect(result.task.labels).toEqual(["bug"]);
  });

  it("removes label", () => {
    const task = makeTask({ labels: ["bug", "priority"] });
    const result = applyTaskUpdate(task, { removeLabel: "bug" }, config);
    expect(result.task.labels).toEqual(["priority"]);
  });

  // --- status option with auto-date updates ---

  describe("--status option", () => {
    afterEach(() => vi.restoreAllMocks());

    const configWithStatuses = makeConfig({
      statuses: {
        field_name: "Status",
        values: {
          Todo: { color: "#ccc", done: false },
          "In Progress": { color: "#36f", done: false, starts_work: true },
          Done: { color: "#0c0", done: true },
        },
      },
    });

    it("sets status custom field and start_date when starts_work", () => {
      vi.useFakeTimers({ now: new Date("2026-03-15T12:00:00Z") });
      const task = makeTask({ custom_fields: { Status: "Todo" } });
      const result = applyTaskUpdate(task, { status: "In Progress" }, configWithStatuses);
      expect(result.error).toBeUndefined();
      expect(result.task.custom_fields.Status).toBe("In Progress");
      expect(result.task.start_date).toBe("2026-03-15");
      vi.useRealTimers();
    });

    it("sets end_date when transitioning to done status", () => {
      vi.useFakeTimers({ now: new Date("2026-04-20T08:30:00Z") });
      const task = makeTask({ custom_fields: { Status: "In Progress" }, start_date: "2026-03-15" });
      const result = applyTaskUpdate(task, { status: "Done" }, configWithStatuses);
      expect(result.error).toBeUndefined();
      expect(result.task.custom_fields.Status).toBe("Done");
      expect(result.task.end_date).toBe("2026-04-20");
      vi.useRealTimers();
    });

    it("does not change dates for a non-special status", () => {
      const task = makeTask({ custom_fields: { Status: "In Progress" }, start_date: "2026-03-15" });
      const result = applyTaskUpdate(task, { status: "Todo" }, configWithStatuses);
      expect(result.error).toBeUndefined();
      expect(result.task.start_date).toBe("2026-03-15");
      expect(result.task.end_date).toBeNull();
    });

    it("overwrites existing start_date on starts_work transition", () => {
      vi.useFakeTimers({ now: new Date("2026-05-01T00:00:00Z") });
      const task = makeTask({ custom_fields: { Status: "Todo" }, start_date: "2026-01-01" });
      const result = applyTaskUpdate(task, { status: "In Progress" }, configWithStatuses);
      expect(result.task.start_date).toBe("2026-05-01");
      vi.useRealTimers();
    });

    it("rejects unknown status", () => {
      const task = makeTask();
      const result = applyTaskUpdate(task, { status: "NonExistent" }, configWithStatuses);
      expect(result.error).toContain("Unknown status");
      expect(result.error).toContain("NonExistent");
    });
  });

  describe("priority", () => {
    const configWithPriority = makeConfig({
      sync: {
        auto_create_issues: false,
        field_mapping: {
          start_date: "Start",
          end_date: "End",
          status: "Status",
          priority: "Priority",
        },
      },
    });

    it("sets valid priority in custom_fields", () => {
      const task = makeTask();
      const result = applyTaskUpdate(task, { priority: "high" }, configWithPriority);
      expect(result.error).toBeUndefined();
      expect(result.task.custom_fields["Priority"]).toBe("high");
    });

    it("normalizes priority to lowercase", () => {
      const task = makeTask();
      const result = applyTaskUpdate(task, { priority: "High" }, configWithPriority);
      expect(result.error).toBeUndefined();
      expect(result.task.custom_fields["Priority"]).toBe("high");
    });

    it("rejects invalid priority", () => {
      const task = makeTask();
      const result = applyTaskUpdate(task, { priority: "urgent" }, configWithPriority);
      expect(result.error).toContain("Invalid priority");
      expect(result.error).toContain("urgent");
    });

    it("rejects priority when field_mapping.priority is not configured", () => {
      const task = makeTask();
      const result = applyTaskUpdate(task, { priority: "high" }, config);
      expect(result.error).toContain("not configured");
    });
  });
});

// --- filterTasksForUpdate (bulk) ---

describe("filterTasksForUpdate", () => {
  const tasks = [
    makeTask({
      id: "owner/repo#1",
      state: "open",
      type: "task",
      milestone: "v1.0",
      labels: ["bug"],
    }),
    makeTask({
      id: "owner/repo#2",
      state: "open",
      type: "epic",
      milestone: null,
      labels: ["feature"],
    }),
    makeTask({
      id: "owner/repo#3",
      state: "closed",
      type: "task",
      milestone: "v1.0",
      labels: ["bug", "feature"],
    }),
    makeTask({ id: "owner/repo#4", state: "open", type: "task", milestone: null, labels: [] }),
  ];

  it("filters by state", () => {
    const result = filterTasksForUpdate(tasks, { filterState: "closed" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("owner/repo#3");
  });

  it("filters by type", () => {
    const result = filterTasksForUpdate(tasks, { filterType: "epic" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("owner/repo#2");
  });

  it("filters by milestone", () => {
    const result = filterTasksForUpdate(tasks, { filterMilestone: "v1.0" });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1", "owner/repo#3"]);
  });

  it("filters by milestone 'none' for unset", () => {
    const result = filterTasksForUpdate(tasks, { filterMilestone: "none" });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#2", "owner/repo#4"]);
  });

  it("filters by label", () => {
    const result = filterTasksForUpdate(tasks, { filterLabel: "feature" });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#2", "owner/repo#3"]);
  });

  it("combines filters with AND logic", () => {
    const result = filterTasksForUpdate(tasks, { filterState: "open", filterType: "task" });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["owner/repo#1", "owner/repo#4"]);
  });
});

// --- collectMilestones ---

describe("collectMilestones", () => {
  it("collects milestone-type tasks", () => {
    const tasks = [
      makeTask({
        id: "milestone:owner/repo#1",
        type: "milestone",
        title: "v1.0",
        date: "2026-06-01",
      }),
    ];
    const result = collectMilestones(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("v1.0");
    expect(result[0].dueDate).toBe("2026-06-01");
  });

  it("collects milestone_type tasks", () => {
    const tasks = [
      makeTask({
        id: "owner/repo#5",
        type: "milestone_type",
        title: "v1.0 Release",
        end_date: "2026-06-01",
      }),
    ];
    const result = collectMilestones(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("v1.0 Release");
    expect(result[0].dueDate).toBe("2026-06-01");
  });

  it("counts tasks referencing milestones", () => {
    const tasks = [
      makeTask({
        id: "milestone:owner/repo#1",
        type: "milestone",
        title: "v1.0",
        date: "2026-06-01",
      }),
      makeTask({ id: "owner/repo#2", milestone: "v1.0" }),
      makeTask({ id: "owner/repo#3", milestone: "v1.0" }),
    ];
    const result = collectMilestones(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].taskCount).toBe(2);
  });

  it("discovers milestones from task references only", () => {
    const tasks = [makeTask({ id: "owner/repo#1", milestone: "v2.0" })];
    const result = collectMilestones(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("v2.0");
    expect(result[0].taskId).toBeNull();
    expect(result[0].taskCount).toBe(1);
  });
});

// --- link operations ---

describe("addDependency", () => {
  it("adds a blocking dependency", () => {
    const task = makeTask();
    const result = addDependency(task, "owner/repo#2");
    expect(result.error).toBeUndefined();
    expect(result.task.blocked_by).toHaveLength(1);
    expect(result.task.blocked_by[0]).toEqual({
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
    expect(result.task.blocked_by).toHaveLength(1);
  });

  it("rejects self-reference dependency", () => {
    const task = makeTask({ id: "owner/repo#1" });
    const result = addDependency(task, "owner/repo#1");
    expect(result.error).toContain("cannot be blocked by itself");
    expect(result.task.blocked_by).toHaveLength(0);
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
    expect(result.task.blocked_by).toHaveLength(1);
    expect(result.task.blocked_by[0].task).toBe("owner/repo#3");
  });

  it("handles removing non-existent dependency", () => {
    const task = makeTask();
    const result = removeDependency(task, "owner/repo#99");
    expect(result.task.blocked_by).toHaveLength(0);
  });
});

describe("setParent", () => {
  it("rejects self-reference parent", () => {
    const tasks = [makeTask({ id: "owner/repo#1" })];
    const result = setParent(tasks, "owner/repo#1", "owner/repo#1");
    expect(result.error).toContain("cannot be its own parent");
  });

  it("rejects non-existent parent", () => {
    const tasks = [makeTask({ id: "owner/repo#1" })];
    const result = setParent(tasks, "owner/repo#1", "owner/repo#99");
    expect(result.error).toContain("not found");
  });

  it("sets parent and updates sub_tasks", () => {
    const tasks = [
      makeTask({ id: "owner/repo#1" }),
      makeTask({ id: "owner/repo#2", sub_tasks: [] }),
    ];
    const result = setParent(tasks, "owner/repo#1", "owner/repo#2");
    expect(result.error).toBeUndefined();
    const child = result.tasks!.find((t) => t.id === "owner/repo#1")!;
    const parent = result.tasks!.find((t) => t.id === "owner/repo#2")!;
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
    expect(result.error).toBeUndefined();
    const oldParent = result.tasks!.find((t) => t.id === "owner/repo#2")!;
    const newParent = result.tasks!.find((t) => t.id === "owner/repo#3")!;
    const child = result.tasks!.find((t) => t.id === "owner/repo#1")!;
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

// removeParent は返り値変更なし（Task[] のまま）— バリデーション不要のため
