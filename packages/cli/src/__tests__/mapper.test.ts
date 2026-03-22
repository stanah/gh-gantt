import { describe, it, expect } from "vitest";
import { mapRemoteItemToTask } from "../sync/mapper.js";

// mergeRemoteIntoLocal was removed in sync-engine-redesign.
// Tests for the new 3-way merge logic are in three-way-merge.test.ts.

describe("mapRemoteItemToTask", () => {
  it("returns null for items without content", () => {
    const item = { id: "item1", content: null, fieldValues: {} };
    const config = {
      project: { github: { owner: "o", repo: "r", project_number: 1 } },
      sync: {
        field_mapping: { start_date: "Start", end_date: "End", type: "" },
        auto_create_issues: false,
      },
      task_types: { task: { github_label: null } },
      statuses: { field_name: "Status", values: {} },
      type_hierarchy: {},
    } as any;
    expect(mapRemoteItemToTask(item, config)).toBeNull();
  });
});
