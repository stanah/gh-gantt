import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config, SyncState, Task } from "@gh-gantt/shared";
import {
  buildContextSummary,
  createContextCommand,
  parseOpenPullRequestsJson,
} from "../commands/context.js";

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

const mockConfig: Config = {
  version: "1",
  project: { name: "test", github: { owner: "owner", repo: "repo", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: {
      start_date: "Start",
      end_date: "End",
      status: "Status",
      priority: "Priority",
    },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
    epic: { label: "Epic", display: "summary", color: "#00f", github_label: "epic" },
  },
  type_hierarchy: {},
  statuses: {
    field_name: "Status",
    values: {
      Todo: { color: "#ccc", done: false, category: "todo" },
      "In Progress": { color: "#00f", done: false, starts_work: true, category: "in_progress" },
      "In Review": { color: "#0ff", done: false, starts_work: true, category: "in_review" },
      Done: { color: "#0f0", done: true, category: "done" },
    },
  },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

const mockSyncState: SyncState = {
  last_synced_at: "2026-05-03T00:00:00Z",
  project_node_id: "PVT_1",
  id_map: {},
  field_ids: {},
  snapshots: {},
};

const mockOpenPullRequests = [
  {
    number: 10,
    title: "context コマンドを追加",
    url: "https://github.com/owner/repo/pull/10",
    head_ref_name: "feat/context",
    updated_at: "2026-05-02T12:00:00Z",
    closing_issues: [139],
  },
];

let mockTasks: Task[] = [];

vi.mock("../store/config.js", () => ({
  ConfigStore: class {
    async read() {
      return mockConfig;
    }
  },
}));

vi.mock("../store/tasks.js", () => ({
  TasksStore: class {
    async read() {
      return { tasks: mockTasks, cache: { comments: {}, reactions: {} } };
    }
  },
}));

vi.mock("../store/state.js", () => ({
  SyncStateStore: class {
    async read() {
      return mockSyncState;
    }
  },
}));

describe("[FR-CLI-008-AC1] context コマンドがプロジェクト文脈を復元できる", () => {
  it("作業中タスク・open PR・直近更新タスク・ブロッカー・推奨次アクションを集約する", () => {
    const tasks = [
      makeTask({
        id: "owner/repo#139",
        github_issue: 139,
        title: "context コマンド新設",
        assignees: ["stanah"],
        linked_prs: [10],
        updated_at: "2026-05-02T10:00:00Z",
        custom_fields: { Status: "In Progress", Priority: "high" },
        start_date: "2026-04-25",
        end_date: "2026-04-30",
      }),
      makeTask({
        id: "owner/repo#140",
        github_issue: 140,
        title: "doctor stale 検出",
        updated_at: "2026-05-01T10:00:00Z",
        custom_fields: { Status: "Todo" },
        blocked_by: [{ task: "owner/repo#141", type: "finish-to-start", lag: 0 }],
      }),
      makeTask({
        id: "owner/repo#141",
        github_issue: 141,
        title: "未完了ブロッカー",
        updated_at: "2026-04-20T10:00:00Z",
        custom_fields: { Status: "Todo" },
      }),
      makeTask({
        id: "owner/repo#142",
        github_issue: 142,
        title: "完了済みタスク",
        state: "closed",
        closed_at: "2026-05-02T11:00:00Z",
        updated_at: "2026-05-02T11:00:00Z",
        custom_fields: { Status: "Done" },
      }),
    ];

    const summary = buildContextSummary({
      config: mockConfig,
      tasks,
      syncState: mockSyncState,
      openPullRequests: mockOpenPullRequests,
      now: new Date("2026-05-03T00:00:00Z"),
    });

    expect(summary.in_progress_tasks.map((task) => task.id)).toEqual(["owner/repo#139"]);
    expect(summary.open_pull_requests.map((pr) => pr.number)).toEqual([10]);
    expect(summary.recently_updated_tasks.map((task) => task.id)).toEqual([
      "owner/repo#142",
      "owner/repo#139",
      "owner/repo#140",
    ]);
    expect(summary.blocked_tasks).toEqual([
      expect.objectContaining({
        id: "owner/repo#140",
        blocked_by: [expect.objectContaining({ id: "owner/repo#141", state: "open" })],
      }),
    ]);
    expect(summary.recommended_next_actions[0]).toEqual(
      expect.objectContaining({ kind: "continue_task", task_id: "owner/repo#139" }),
    );
  });

  it("設定済みの完了 status は名前が作業中でも作業中タスクに含めない", () => {
    const config: Config = {
      ...mockConfig,
      statuses: {
        ...mockConfig.statuses,
        values: {
          ...mockConfig.statuses.values,
          "In Progress": { color: "#0f0", done: true, category: "done" },
        },
      },
    };
    const summary = buildContextSummary({
      config,
      tasks: [
        makeTask({
          id: "owner/repo#139",
          github_issue: 139,
          title: "完了済み status 名が作業中に見えるタスク",
          custom_fields: { Status: "In Progress" },
        }),
      ],
      syncState: mockSyncState,
      now: new Date("2026-05-03T00:00:00Z"),
    });

    expect(summary.in_progress_tasks).toEqual([]);
    expect(summary.recommended_next_actions).not.toContainEqual(
      expect.objectContaining({ kind: "continue_task" }),
    );
  });

  it("open PR は更新日時の降順で安定して推奨アクションに使う", () => {
    const summary = buildContextSummary({
      config: mockConfig,
      tasks: [],
      syncState: mockSyncState,
      openPullRequests: [
        {
          number: 10,
          title: "古い PR",
          url: "https://github.com/owner/repo/pull/10",
          head_ref_name: "feat/old",
          updated_at: "2026-05-01T00:00:00Z",
          closing_issues: [],
        },
        {
          number: 20,
          title: "新しい PR",
          url: "https://github.com/owner/repo/pull/20",
          head_ref_name: "feat/new",
          updated_at: "2026-05-03T00:00:00Z",
          closing_issues: [],
        },
        {
          number: 30,
          title: "更新日時なし PR",
          url: "https://github.com/owner/repo/pull/30",
          head_ref_name: "feat/null",
          updated_at: null,
          closing_issues: [],
        },
      ],
      now: new Date("2026-05-03T00:00:00Z"),
    });

    expect(summary.open_pull_requests.map((pr) => pr.number)).toEqual([20, 10, 30]);
    expect(summary.recommended_next_actions[0]).toEqual(
      expect.objectContaining({ kind: "review_pr", pr_number: 20 }),
    );
  });
});

describe("[FR-CLI-008-AC2] context --json が機械可読な JSON を出力する", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockTasks = [
      makeTask({
        id: "owner/repo#139",
        github_issue: 139,
        title: "context コマンド新設",
        updated_at: "2026-05-02T10:00:00Z",
        custom_fields: { Status: "In Progress" },
      }),
    ];
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockTasks = [];
  });

  it("summary オブジェクトを JSON として出力する", async () => {
    const cmd = createContextCommand({
      now: () => new Date("2026-05-03T00:00:00Z"),
      fetchOpenPullRequests: async () => mockOpenPullRequests,
    });

    await cmd.parseAsync(["context", "--json"], { from: "user" });

    expect(logSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.project).toMatchObject({ owner: "owner", repo: "repo", project_number: 1 });
    expect(parsed.in_progress_tasks[0]).toMatchObject({
      id: "owner/repo#139",
      title: "context コマンド新設",
    });
    expect(parsed.open_pull_requests[0]).toMatchObject({ number: 10 });
    expect(parsed.recommended_next_actions[0]).toMatchObject({ kind: "continue_task" });
  });

  it("--offline は open PR 取得を呼ばず warning を出力する", async () => {
    const fetchOpenPullRequests = vi.fn(async () => mockOpenPullRequests);
    const cmd = createContextCommand({
      now: () => new Date("2026-05-03T00:00:00Z"),
      fetchOpenPullRequests,
    });

    await cmd.parseAsync(["context", "--json", "--offline"], { from: "user" });

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(fetchOpenPullRequests).not.toHaveBeenCalled();
    expect(parsed.open_pull_requests).toEqual([]);
    expect(parsed.warnings).toContain("open PR の取得を --offline でスキップしました");
  });

  it("--recent-days で直近更新タスクの期間を変更できる", async () => {
    mockTasks = [
      makeTask({
        id: "owner/repo#139",
        github_issue: 139,
        title: "最近のタスク",
        updated_at: "2026-05-02T10:00:00Z",
        custom_fields: { Status: "In Progress" },
      }),
      makeTask({
        id: "owner/repo#140",
        github_issue: 140,
        title: "古いタスク",
        updated_at: "2026-04-30T10:00:00Z",
        custom_fields: { Status: "Todo" },
      }),
    ];
    const cmd = createContextCommand({
      now: () => new Date("2026-05-03T00:00:00Z"),
      fetchOpenPullRequests: async () => [],
    });

    await cmd.parseAsync(["context", "--json", "--recent-days", "2"], { from: "user" });

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.recently_updated_tasks.map((task: { id: string }) => task.id)).toEqual([
      "owner/repo#139",
    ]);
    expect(parsed.counts.recently_updated_tasks).toBe(1);
  });

  it("--pr-limit を open PR 取得に渡す", async () => {
    const fetchOpenPullRequests = vi.fn(async () => mockOpenPullRequests);
    const cmd = createContextCommand({
      now: () => new Date("2026-05-03T00:00:00Z"),
      fetchOpenPullRequests,
    });

    await cmd.parseAsync(["context", "--json", "--pr-limit", "75"], { from: "user" });

    expect(fetchOpenPullRequests).toHaveBeenCalledWith(mockConfig, { limit: 75 });
  });

  it("gh CLI の PR JSON を検証して summary に変換する", () => {
    const parsed = parseOpenPullRequestsJson(
      JSON.stringify([
        {
          number: 196,
          title: "context コマンドを追加",
          url: "https://github.com/owner/repo/pull/196",
          headRefName: "feat/context",
          updatedAt: "2026-05-03T00:00:00Z",
          reviewDecision: "CHANGES_REQUESTED",
          closingIssuesReferences: [{ number: 139 }],
        },
      ]),
    );

    expect(parsed).toEqual([
      {
        number: 196,
        title: "context コマンドを追加",
        url: "https://github.com/owner/repo/pull/196",
        head_ref_name: "feat/context",
        updated_at: "2026-05-03T00:00:00Z",
        review_decision: "CHANGES_REQUESTED",
        closing_issues: [139],
      },
    ]);
  });

  it("gh CLI の PR JSON 形式が壊れている場合は失敗する", () => {
    expect(() => parseOpenPullRequestsJson(JSON.stringify([{ number: "196" }]))).toThrow();
  });
});
