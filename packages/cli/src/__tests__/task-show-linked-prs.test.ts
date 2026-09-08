import { describe, it, expect } from "vitest";
import type { Task } from "@gh-gantt/shared";
import { formatLinkedPullRequests, formatTask } from "../commands/task/show.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1",
    type: "task",
    github_issue: 1,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: "テストタスク",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

describe("[FR-CLI-002-AC3] show は関連 PR を番号・状態・タイトル・URL つきで表示し、Draft PR は state が open でも draft と判別できる", () => {
  it("Draft / Open / Merged / Closed の 4 状態を区別して 1 行ずつ表示する", () => {
    const task = makeTask({
      linked_prs: [
        {
          number: 100,
          title: "Draft change",
          state: "open",
          url: "https://github.com/owner/repo/pull/100",
          is_draft: true,
        },
        {
          number: 101,
          title: "Open change",
          state: "open",
          url: "https://github.com/owner/repo/pull/101",
          is_draft: false,
        },
        {
          number: 102,
          title: "Merged change",
          state: "merged",
          url: "https://github.com/owner/repo/pull/102",
        },
        { number: 103, title: "Closed change", state: "closed", url: null },
      ],
    });

    const output = formatTask(task);

    expect(output).toContain("Linked PRs:");
    expect(output).toContain("  #100 [draft] Draft change https://github.com/owner/repo/pull/100");
    expect(output).toContain("  #101 [open] Open change https://github.com/owner/repo/pull/101");
    expect(output).toContain(
      "  #102 [merged] Merged change https://github.com/owner/repo/pull/102",
    );
    expect(output).toContain("  #103 [closed] Closed change");
    // Linked PRs は Blocked by の直後、Acceptance Criteria の前に出る
    expect(output.indexOf("Blocked by:")).toBeLessThan(output.indexOf("Linked PRs:"));
    expect(output.indexOf("Linked PRs:")).toBeLessThan(output.indexOf("Acceptance Criteria:"));
  });

  it("is_draft の無い既存 cache の PR は open と表示し、legacy の number 参照は番号のみ表示する", () => {
    expect(
      formatLinkedPullRequests([
        42,
        { number: 7, title: "Legacy cache", state: "open", url: "https://example.test/7" },
      ]),
    ).toEqual(["  #42", "  #7 [open] Legacy cache https://example.test/7"]);
  });

  it("関連 PR が無ければ - を表示する", () => {
    expect(formatLinkedPullRequests([])).toEqual(["  -"]);
    expect(formatTask(makeTask())).toContain("Linked PRs:\n  -\n");
  });
});
