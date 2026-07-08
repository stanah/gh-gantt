import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCreateCommand } from "../../commands/create.js";
import { createTaskLinkCommand } from "../../commands/task/link.js";
import { executePush } from "../../sync/push-executor.js";
import type { Config, SyncState, TasksFile } from "@gh-gantt/shared";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const mockConfig: Config = {
  version: "1",
  project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
  sync: {
    auto_create_issues: true,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
    epic: { label: "Epic", display: "bar", color: "#00f", github_label: null },
  },
  type_hierarchy: {},
  statuses: { field_name: "Status", values: {} },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
} as Config;

let currentTasksFile: TasksFile = { tasks: [], cache: { comments: {}, reactions: {} } };

vi.mock("../../store/config.js", () => ({
  ConfigStore: class {
    async read() {
      return mockConfig;
    }
  },
}));

vi.mock("../../store/tasks.js", () => ({
  TasksStore: class {
    async read() {
      return clone(currentTasksFile);
    }

    async write(data: TasksFile) {
      currentTasksFile = clone(data);
    }
  },
}));

/** create --parent 由来のタイトル → Issue 番号の対応で push 順序に依存しないモックを作る */
function makeMockGql(recorded: {
  addSubIssueCalls: Array<{ issueId: string; subIssueId: string }>;
  addBlockedByCalls: Array<{ issueId: string; blockingIssueId: string }>;
}) {
  const titleToNumber: Record<string, number> = {
    "親 Epic": 294,
    "子タスク A": 295,
    "子タスク B": 296,
  };
  return vi.fn().mockImplementation(async (query: string, vars?: any) => {
    if (query.includes("createIssue")) {
      const n = titleToNumber[vars?.title];
      if (!n) throw new Error(`予期しない createIssue title: ${vars?.title}`);
      return { createIssue: { issue: { id: `ISSUE_${n}`, number: n } } };
    }
    if (query.includes("addProjectV2ItemById")) {
      return { addProjectV2ItemById: { item: { id: `ITEM_${vars?.contentId}` } } };
    }
    if (query.includes("addSubIssue")) {
      recorded.addSubIssueCalls.push({ issueId: vars.issueId, subIssueId: vars.subIssueId });
      return { addSubIssue: { issue: { id: vars.issueId } } };
    }
    if (query.includes("addBlockedBy")) {
      recorded.addBlockedByCalls.push({
        issueId: vars.issueId,
        blockingIssueId: vars.blockingIssueId,
      });
      return { addBlockedBy: { issue: { id: vars.issueId } } };
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_X" } } };
    }
    // fetchRepositoryMetadata (labels / milestones)
    if (query.includes("labels") || query.includes("milestones")) {
      return { repository: { id: "REPO_1", labels: { nodes: [] }, milestones: { nodes: [] } } };
    }
    // fetchBatchUpdatedAt (issue(number: N) の alias バッチ)
    if (query.includes("issue(number:")) {
      const matches = [...query.matchAll(/issue\(number:\s*(\d+)\)/g)];
      const repository: Record<string, unknown> = {};
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
    // fetchRepositoryId
    if (query.includes("repository(")) {
      return { repository: { id: "REPO_1" } };
    }
    return {};
  });
}

describe("[NFR-STABILITY-002-AC6] [Issue #302] draft 親子一括 push の parent 参照置換リグレッション", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    currentTasksFile = { tasks: [], cache: { comments: {}, reactions: {} } };
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("create --parent draft-1 で一括作成した親子 draft を push すると parent が新 Issue ID に置換され sub-issue 関係が設定される", async () => {
    // 再現形 1 (Issue #302): 親 epic + 子タスクを draft 短縮形の --parent で一括作成し、
    // 子同士の依存を link で設定してから push する
    await createCreateCommand().parseAsync(["--title", "親 Epic", "--type", "epic", "--json"], {
      from: "user",
    });
    await createCreateCommand().parseAsync(
      ["--title", "子タスク A", "--type", "task", "--parent", "draft-1", "--json"],
      { from: "user" },
    );
    await createCreateCommand().parseAsync(
      ["--title", "子タスク B", "--type", "task", "--parent", "draft-1", "--json"],
      { from: "user" },
    );
    await createTaskLinkCommand().parseAsync(["draft-3", "--blocked-by", "draft-2"], {
      from: "user",
    });
    expect(process.exitCode).toBeUndefined();

    // 修正の核: create --parent が生の "draft-1" ではなく正規形で保存していること
    const childA = currentTasksFile.tasks.find((t) => t.title === "子タスク A");
    const childB = currentTasksFile.tasks.find((t) => t.title === "子タスク B");
    expect(childA?.parent).toBe("o/r#draft-1");
    expect(childB?.parent).toBe("o/r#draft-1");
    expect(childB?.blocked_by).toEqual([{ task: "o/r#draft-2", type: "finish-to-start", lag: 0 }]);

    // push: draft → 実 Issue 変換と関係同期
    const tasksFile = clone(currentTasksFile);
    const syncState: SyncState = {
      last_synced_at: "",
      project_node_id: "PVT_1",
      id_map: {},
      field_ids: {},
      snapshots: {},
    };
    const recorded = {
      addSubIssueCalls: [] as Array<{ issueId: string; subIssueId: string }>,
      addBlockedByCalls: [] as Array<{ issueId: string; blockingIssueId: string }>,
    };

    const { result, tasksFile: pushedTasksFile } = await executePush(
      makeMockGql(recorded) as any,
      mockConfig,
      tasksFile,
      syncState,
    );

    expect(result.created).toBe(3);

    // 子の parent 参照が親の新 Issue ID に置換されている (replaceTaskIdReferences が効く)
    const pushedEpic = pushedTasksFile.tasks.find((t) => t.title === "親 Epic");
    const pushedChildA = pushedTasksFile.tasks.find((t) => t.title === "子タスク A");
    const pushedChildB = pushedTasksFile.tasks.find((t) => t.title === "子タスク B");
    expect(pushedEpic?.id).toBe("o/r#294");
    expect(pushedChildA?.parent).toBe("o/r#294");
    expect(pushedChildB?.parent).toBe("o/r#294");
    expect(pushedEpic?.sub_tasks).toEqual(expect.arrayContaining(["o/r#295", "o/r#296"]));
    expect(pushedChildB?.blocked_by).toEqual([
      { task: "o/r#295", type: "finish-to-start", lag: 0 },
    ]);

    // sub-issue 関係が GitHub に設定されている (スキップされない)
    expect(recorded.addSubIssueCalls).toEqual(
      expect.arrayContaining([
        { issueId: "ISSUE_294", subIssueId: "ISSUE_295" },
        { issueId: "ISSUE_294", subIssueId: "ISSUE_296" },
      ]),
    );
    expect(recorded.addSubIssueCalls).toHaveLength(2);
    expect(recorded.addBlockedByCalls).toEqual([
      { issueId: "ISSUE_296", blockingIssueId: "ISSUE_295" },
    ]);

    // 「issue_node_id が取得できないため sub-issue 関係をスキップ」警告が出ていないこと
    const skipWarn = warnSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("sub-issue 関係をスキップ"),
    );
    expect(skipWarn).toBeUndefined();
  });

  it("番号指定の --parent 293 でも正規形に解決され push で sub-issue 関係が設定される", async () => {
    // 再現形 2 (Issue #302 コメント): 既存 Issue の番号を --parent に指定した場合
    currentTasksFile = {
      tasks: [
        {
          id: "o/r#293",
          type: "epic",
          github_issue: 293,
          github_repo: "o/r",
          parent: null,
          sub_tasks: [],
          title: "既存 Epic",
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
        },
      ],
      cache: { comments: {}, reactions: {} },
    };

    await createCreateCommand().parseAsync(
      ["--title", "子タスク A", "--type", "task", "--parent", "293", "--json"],
      { from: "user" },
    );
    expect(process.exitCode).toBeUndefined();

    const childA = currentTasksFile.tasks.find((t) => t.title === "子タスク A");
    expect(childA?.id).toBe("o/r#draft-1");
    expect(childA?.parent).toBe("o/r#293");

    const tasksFile = clone(currentTasksFile);
    const syncState: SyncState = {
      last_synced_at: "",
      project_node_id: "PVT_1",
      id_map: {
        "o/r#293": { issue_number: 293, issue_node_id: "ISSUE_293", project_item_id: "ITEM_293" },
      },
      field_ids: {},
      snapshots: {},
    };
    const recorded = {
      addSubIssueCalls: [] as Array<{ issueId: string; subIssueId: string }>,
      addBlockedByCalls: [] as Array<{ issueId: string; blockingIssueId: string }>,
    };

    // 既存 Epic (#293) には snapshot が無いため added 扱いになるが、
    // draft 子タスクの関係解決は id_map 照合で行われる
    await executePush(makeMockGql(recorded) as any, mockConfig, tasksFile, syncState);

    expect(recorded.addSubIssueCalls).toContainEqual({
      issueId: "ISSUE_293",
      subIssueId: "ISSUE_295",
    });
    const skipWarn = warnSpy.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("sub-issue 関係をスキップ"),
    );
    expect(skipWarn).toBeUndefined();
  });
});
