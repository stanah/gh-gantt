import { describe, it, expect } from "vitest";
import { resolveTaskType, resolveTaskTypeBinding } from "../sync/type-resolver.js";
import type { TaskType } from "@gh-gantt/shared";

const taskTypes: Record<string, TaskType> = {
  task: {
    label: "Task",
    display: "bar",
    color: "#27AE60",
    github_label: null,
    github_field_value: "Task",
  },
  epic: {
    label: "Epic",
    display: "summary",
    color: "#8E44AD",
    github_label: "epic",
    github_field_value: "Epic",
  },
  bug: {
    label: "Bug",
    display: "bar",
    color: "#E74C3C",
    github_label: "bug",
    github_field_value: "Bug",
  },
  milestone: { label: "Milestone", display: "milestone", color: "#E74C3C", github_label: null },
};

describe("[FR-HIER-004-AC1] ラベルや Issue Type からタスクタイプを正しく解決できる", () => {
  it("resolves type from custom field value (highest priority)", () => {
    const result = resolveTaskType(["bug"], { Type: "Epic" }, taskTypes, "Type");
    expect(result).toBe("epic");
  });

  it("falls back to label when custom field has no match", () => {
    const result = resolveTaskType(["bug"], { Type: "Unknown" }, taskTypes, "Type");
    expect(result).toBe("bug");
  });

  it("falls back to label when no type field is configured", () => {
    const result = resolveTaskType(["epic"], { Type: "Epic" }, taskTypes, null);
    expect(result).toBe("epic");
  });

  it("falls back to label when typeFieldName is undefined", () => {
    const result = resolveTaskType(["bug"], {}, taskTypes, undefined);
    expect(result).toBe("bug");
  });

  it("milestone presence does NOT affect type resolution", () => {
    const typesWithMilestone: Record<string, TaskType> = {
      ...taskTypes,
    };
    // Even with a milestone display type available, issues with a milestone
    // field should NOT resolve to milestone type — milestones come from
    // native GitHub Milestones now, not from issue properties.
    const result = resolveTaskType([], {}, typesWithMilestone, "Type");
    expect(result).toBe("task");
  });

  it("returns 'task' as default when no match", () => {
    const result = resolveTaskType([], {}, taskTypes, "Type");
    expect(result).toBe("task");
  });

  it("returns 'task' with empty custom field value", () => {
    const result = resolveTaskType([], { Type: "" }, taskTypes, "Type");
    expect(result).toBe("task");
  });

  it("backward compatible: works with label-only task types", () => {
    const labelOnlyTypes: Record<string, TaskType> = {
      task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
      bug: { label: "Bug", display: "bar", color: "#E74C3C", github_label: "bug" },
    };
    const result = resolveTaskType(["bug"], {}, labelOnlyTypes);
    expect(result).toBe("bug");
  });

  it("resolves type from issueType (highest priority over custom field)", () => {
    const issueTypeTypes: Record<string, TaskType> = {
      task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
      epic: {
        label: "Epic",
        display: "summary",
        color: "#8E44AD",
        github_label: null,
        github_issue_type: "Epic",
      },
      bug: {
        label: "Bug",
        display: "bar",
        color: "#E74C3C",
        github_label: "bug",
        github_field_value: "Bug",
      },
    };
    // issueType "Epic" should win over label "bug" and custom field "Bug"
    const result = resolveTaskType(["bug"], { Type: "Bug" }, issueTypeTypes, "Type", "Epic");
    expect(result).toBe("epic");
  });

  it("falls back to custom field when issueType has no match", () => {
    const result = resolveTaskType([], { Type: "Epic" }, taskTypes, "Type", "Unknown");
    expect(result).toBe("epic");
  });

  it("falls back to custom field when issueType is null", () => {
    const result = resolveTaskType([], { Type: "Bug" }, taskTypes, "Type", null);
    expect(result).toBe("bug");
  });

  it("live照合はIssue Type・field・labelのbindingを優先順で使いunmappedをdefault denyする", () => {
    const bindings: Record<string, TaskType> = {
      issueBound: {
        label: "表示名A",
        display: "bar",
        color: "#111",
        github_label: "label-a",
        github_field_value: "Field A",
        github_issue_type: "Issue A",
      },
      fieldBound: {
        label: "表示名B",
        display: "bar",
        color: "#222",
        github_label: "label-b",
        github_field_value: "Field B",
        github_issue_type: "Issue B",
      },
      labelBound: {
        label: "表示名C",
        display: "bar",
        color: "#333",
        github_label: "label-c",
        github_field_value: "Field C",
        github_issue_type: "Issue C",
      },
    };
    expect(
      resolveTaskTypeBinding(["label-c"], { Type: "Field B" }, bindings, "Type", "Issue A"),
    ).toBe("issueBound");
    expect(resolveTaskTypeBinding(["label-c"], { Type: "Field B" }, bindings, "Type", null)).toBe(
      "fieldBound",
    );
    expect(resolveTaskTypeBinding(["label-c"], {}, bindings, "Type", null)).toBe("labelBound");
    expect(resolveTaskTypeBinding([], {}, bindings, "Type", "Unmapped")).toBeNull();
  });
});
