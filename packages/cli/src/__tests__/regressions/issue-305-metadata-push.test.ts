/**
 * Issue #305: push が既存 Issue の assignees / labels / milestone の変更を GitHub に反映しない
 *
 * updateIssue (packages/cli/src/github/mutations.ts) は title / body しか送信せず、
 * labelIds / milestoneId / assigneeIds は draft → Issue 作成経路 (createIssue) でのみ
 * 使用されていた。そのため `gh-gantt update <id> --label / --assignee / --milestone` による
 * ローカル変更が push で GitHub に反映されず、次の pull でリモート値に巻き戻されていた。
 *
 * 修正: UpdateIssueInput の assigneeIds / labelIds / milestoneId (置換セマンティクス) を
 * updateIssue mutation に追加し、snapshot (syncFields) と差分があるフィールドだけを送信する。
 * 未解決名 (labelMap / milestoneMap / userIdMap で解決できない名前) を含むフィールドは
 * silent drop せず、そのフィールドだけ送信をスキップして警告を出し、snapshot を旧値に
 * 留めて次回 push で再試行可能にする。
 */
import { describe, expect, it, vi } from "vitest";
import type { Config, Task, TasksFile, SyncState } from "@gh-gantt/shared";
import { computeLocalDiff } from "../../sync/diff.js";
import { extractSyncFields, hashTask } from "../../sync/hash.js";
import { executePush } from "../../sync/push-executor.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "o/r",
    parent: null,
    sub_tasks: [],
    title: `Task ${id}`,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "",
    updated_at: "",
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
    project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
    sync: {
      auto_create_issues: true,
      field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
    },
    task_types: {},
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "", on_track: "", at_risk: "", overdue: "" },
    },
  } as Config;
}

function makeBatchIssueResponse(query: string): any {
  const matches = [...query.matchAll(/issue\(number:\s*(\d+)\)/g)];
  const repository: Record<string, any> = {};
  matches.forEach((match, index) => {
    repository[`i${index}`] = {
      number: Number(match[1]),
      updatedAt: "2026-01-01T00:00:00Z",
      stateReason: null,
      closedAt: null,
    };
  });
  return { repository };
}

/** updateIssue mutation の変数を記録し、metadata / user ID クエリを解決する mock gql */
function makeMockGql(recorded: { updateIssueVars: any[] }) {
  return vi.fn().mockImplementation(async (query: string, vars?: any) => {
    if (query.includes("issue(number:") && !query.includes("mutation")) {
      return makeBatchIssueResponse(query);
    }
    if (query.includes("updateIssue")) {
      recorded.updateIssueVars.push(vars);
      return { updateIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("closeIssue")) {
      return { closeIssue: { issue: { id: "ISSUE_1" } } };
    }
    if (query.includes("reopenIssue")) {
      return { reopenIssue: { issue: { id: "ISSUE_1" } } };
    }
    // repository metadata (labelMap / milestoneMap)
    if (query.includes("labels(first")) {
      return {
        repository: {
          labels: {
            nodes: [
              { id: "LABEL_BUG", name: "bug" },
              { id: "LABEL_FEATURE", name: "feature" },
            ],
          },
          milestones: { nodes: [{ id: "MS_1", title: "v1.0", number: 1 }] },
        },
      };
    }
    // fetchUserIds (u0: user(login: "alice") { id login })
    if (query.includes("user(login:")) {
      const logins = [...query.matchAll(/user\(login:\s*"([^"]+)"\)/g)].map((m) => m[1]);
      const result: Record<string, any> = {};
      logins.forEach((login, index) => {
        if (login === "alice") {
          result[`u${index}`] = { id: "USER_ALICE", login: "alice" };
        }
      });
      return result;
    }
    return {};
  });
}

function makeSyncState(previousTask: Task): SyncState {
  return {
    last_synced_at: "",
    project_node_id: "PVT_1",
    id_map: {
      "o/r#1": { issue_number: 1, issue_node_id: "ISSUE_1", project_item_id: "ITEM_1" },
    },
    field_ids: {},
    snapshots: {
      "o/r#1": {
        hash: hashTask(previousTask),
        synced_at: "",
        syncFields: extractSyncFields(previousTask),
        updated_at: "2026-01-01T00:00:00Z",
      },
    },
  };
}

function makeTasksFile(task: Task): TasksFile {
  return { tasks: [task], cache: { comments: {}, reactions: {} } };
}

describe("[NFR-STABILITY-002-AC4] [Issue #305] assignees / labels / milestone の変更が push で反映されないリグレッション", () => {
  it("assignees / labels / milestone の変更が diff で modified として検出される", () => {
    const previousTask = makeTask("o/r#1", { github_issue: 1, labels: ["bug"] });
    const task = makeTask("o/r#1", {
      github_issue: 1,
      assignees: ["alice"],
      labels: ["bug", "feature"],
      milestone: "v1.0",
    });

    const diffs = computeLocalDiff([task], makeSyncState(previousTask));

    expect(diffs).toContainEqual(expect.objectContaining({ id: "o/r#1", type: "modified" }));
  });

  it("assignees / labels / milestone の変更が updateIssue mutation の変数として送信される", async () => {
    const recorded = { updateIssueVars: [] as any[] };
    const previousTask = makeTask("o/r#1", { github_issue: 1, labels: ["bug"] });
    // `gh-gantt update o/r#1 --assignee alice --label feature --milestone v1.0` 相当の状態
    const task = makeTask("o/r#1", {
      github_issue: 1,
      assignees: ["alice"],
      labels: ["bug", "feature"],
      milestone: "v1.0",
    });

    const mockGql = makeMockGql(recorded);
    await executePush(
      mockGql as any,
      makeConfig(),
      makeTasksFile(task),
      makeSyncState(previousTask),
    );

    // 修正前は title / body のみ送信され、metadata は一切 GitHub に反映されなかった
    expect(recorded.updateIssueVars).toHaveLength(1);
    expect(recorded.updateIssueVars[0].assigneeIds).toEqual(["USER_ALICE"]);
    expect(recorded.updateIssueVars[0].labelIds).toEqual(["LABEL_BUG", "LABEL_FEATURE"]);
    expect(recorded.updateIssueVars[0].milestoneId).toBe("MS_1");
  });

  it("milestone のローカル解除が milestoneId: null として送信される", async () => {
    const recorded = { updateIssueVars: [] as any[] };
    const previousTask = makeTask("o/r#1", { github_issue: 1, milestone: "v1.0" });
    const task = makeTask("o/r#1", { github_issue: 1, milestone: null });

    const mockGql = makeMockGql(recorded);
    await executePush(
      mockGql as any,
      makeConfig(),
      makeTasksFile(task),
      makeSyncState(previousTask),
    );

    expect(recorded.updateIssueVars).toHaveLength(1);
    expect(recorded.updateIssueVars[0]).toHaveProperty("milestoneId", null);
  });

  it("未解決の label 名を含むフィールドは silent drop せず警告付きでスキップし、次回 push で再試行される", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorded = { updateIssueVars: [] as any[] };
      const previousTask = makeTask("o/r#1", { github_issue: 1, labels: ["bug"] });
      // labelMap に存在しない名前を含む → そのまま送るとリモートから label が剥がれる
      const task = makeTask("o/r#1", { github_issue: 1, labels: ["bug", "unknown-label"] });
      const tasksFile = makeTasksFile(task);

      const mockGql = makeMockGql(recorded);
      const { syncState: newSyncState } = await executePush(
        mockGql as any,
        makeConfig(),
        tasksFile,
        makeSyncState(previousTask),
      );

      // labels フィールドは送信されない (bug まで剥がす置換をしない)
      expect(recorded.updateIssueVars).toHaveLength(1);
      expect(recorded.updateIssueVars[0]).not.toHaveProperty("labelIds");
      // 警告として顕在化する (silent drop の禁止)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown-label"));
      // snapshot は旧値に留まり、次回 push で同じ変更が再試行される
      expect(newSyncState.snapshots["o/r#1"].syncFields?.labels).toEqual(["bug"]);
      const retryDiffs = computeLocalDiff(tasksFile.tasks, newSyncState);
      expect(retryDiffs).toContainEqual(expect.objectContaining({ id: "o/r#1", type: "modified" }));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
