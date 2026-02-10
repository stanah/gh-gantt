import { describe, it, expect } from "vitest";
import { resolveTaskType } from "../sync/type-resolver.js";
import type { TaskType } from "@gh-gantt/shared";

const taskTypes: Record<string, TaskType> = {
  task: { label: "Task", display: "bar", color: "#27AE60", github_label: null, github_field_value: "Task" },
  epic: { label: "Epic", display: "summary", color: "#8E44AD", github_label: "epic", github_field_value: "Epic" },
  bug: { label: "Bug", display: "bar", color: "#E74C3C", github_label: "bug", github_field_value: "Bug" },
  milestone_type: { label: "Milestone", display: "milestone", color: "#E74C3C", github_label: null },
};

describe("resolveTaskType", () => {
  it("resolves type from custom field value (highest priority)", () => {
    const result = resolveTaskType(
      ["bug"],
      null,
      { Type: "Epic" },
      taskTypes,
      "Type",
    );
    expect(result).toBe("epic");
  });

  it("falls back to label when custom field has no match", () => {
    const result = resolveTaskType(
      ["bug"],
      null,
      { Type: "Unknown" },
      taskTypes,
      "Type",
    );
    expect(result).toBe("bug");
  });

  it("falls back to label when no type field is configured", () => {
    const result = resolveTaskType(
      ["epic"],
      null,
      { Type: "Epic" },
      taskTypes,
      null,
    );
    expect(result).toBe("epic");
  });

  it("falls back to label when typeFieldName is undefined", () => {
    const result = resolveTaskType(
      ["bug"],
      null,
      {},
      taskTypes,
      undefined,
    );
    expect(result).toBe("bug");
  });

  it("resolves milestone type when milestone is set and no label/field match", () => {
    const result = resolveTaskType(
      [],
      "v1.0",
      {},
      taskTypes,
      "Type",
    );
    expect(result).toBe("milestone_type");
  });

  it("custom field takes priority over milestone", () => {
    const result = resolveTaskType(
      [],
      "v1.0",
      { Type: "Bug" },
      taskTypes,
      "Type",
    );
    expect(result).toBe("bug");
  });

  it("label takes priority over milestone", () => {
    const result = resolveTaskType(
      ["epic"],
      "v1.0",
      {},
      taskTypes,
      "Type",
    );
    expect(result).toBe("epic");
  });

  it("returns 'task' as default when no match", () => {
    const result = resolveTaskType(
      [],
      null,
      {},
      taskTypes,
      "Type",
    );
    expect(result).toBe("task");
  });

  it("returns 'task' with empty custom field value", () => {
    const result = resolveTaskType(
      [],
      null,
      { Type: "" },
      taskTypes,
      "Type",
    );
    expect(result).toBe("task");
  });

  it("backward compatible: works with label-only task types", () => {
    const labelOnlyTypes: Record<string, TaskType> = {
      task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
      bug: { label: "Bug", display: "bar", color: "#E74C3C", github_label: "bug" },
    };
    const result = resolveTaskType(
      ["bug"],
      null,
      {},
      labelOnlyTypes,
    );
    expect(result).toBe("bug");
  });
});
