import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Comment, CommentsFile, Task } from "@gh-gantt/shared";
import {
  buildShowJson,
  createTaskShowCommand,
  formatTask,
  hasIssueComments,
  resolveTaskComments,
} from "../commands/task/show.js";

const storage = vi.hoisted(() => ({
  config: { project: { github: { owner: "owner", repo: "repo" } } },
  tasks: [] as unknown[],
  commentsFile: {
    version: "2",
    fetched_at: {},
    issue_updated_at: {},
    comments: {},
  } as CommentsFile,
}));

vi.mock("../store/project-storage.js", () => ({
  withProjectStorage: vi.fn(
    async (
      _root: string,
      _options: unknown,
      fn: (session: {
        configStore: { read(): Promise<unknown> };
        tasksStore: { read(): Promise<unknown> };
        commentsStore: { read(): Promise<CommentsFile> };
      }) => Promise<void>,
    ) => {
      await fn({
        configStore: { read: async () => storage.config },
        tasksStore: { read: async () => ({ tasks: storage.tasks }) },
        commentsStore: { read: async () => storage.commentsFile },
      });
    },
  ),
}));

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

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "C_1",
    author: "alice",
    body: "hello",
    created_at: "2026-04-02T00:00:00Z",
    updated_at: "2026-04-02T00:00:00Z",
    ...overrides,
  };
}

const notFetched: CommentsFile = {
  version: "2",
  fetched_at: {},
  issue_updated_at: {},
  comments: {},
};

describe("[FR-CLI-019-AC1] show は取得済みコメントを投稿者・日時・本文つきで作成日時の昇順に表示し、本文の Markdown はそのまま出力する", () => {
  it("投稿者・日時・本文を作成日時の昇順で表示する", () => {
    const task = makeTask();
    const commentsFile: CommentsFile = {
      version: "2",
      issue_updated_at: {},
      fetched_at: { "owner/repo#1": "2026-04-05T00:00:00Z" },
      comments: {
        "owner/repo#1": [
          makeComment({
            id: "C_2",
            author: "bob",
            body: "later",
            created_at: "2026-04-03T00:00:00Z",
          }),
          makeComment({
            id: "C_1",
            author: "alice",
            body: "first",
            created_at: "2026-04-02T00:00:00Z",
          }),
        ],
      },
    };

    const output = formatTask(task, resolveTaskComments(task, commentsFile));

    expect(output).toContain("--- Comments (2) ---");
    const aliceIndex = output.indexOf("alice");
    const bobIndex = output.indexOf("bob");
    expect(aliceIndex).toBeGreaterThan(-1);
    expect(aliceIndex).toBeLessThan(bobIndex);
    expect(output).toContain("2026-04-02T00:00:00Z");
    expect(output).toContain("first");
    expect(output).toContain("later");
  });

  it("本文の Markdown をそのまま出力し、編集されたコメントには編集日時を付ける", () => {
    const task = makeTask();
    const markdown = "## 見出し\n\n- item\n\n```ts\nconst x = 1;\n```";
    const commentsFile: CommentsFile = {
      version: "2",
      issue_updated_at: {},
      fetched_at: { "owner/repo#1": "2026-04-05T00:00:00Z" },
      comments: {
        "owner/repo#1": [makeComment({ body: markdown, updated_at: "2026-04-04T00:00:00Z" })],
      },
    };

    const output = formatTask(task, resolveTaskComments(task, commentsFile));

    expect(output).toContain(markdown);
    expect(output).toContain("edited 2026-04-04T00:00:00Z");
  });

  it("取得済みでコメントが 0 件なら 0 件である旨を表示する", () => {
    const task = makeTask();
    const commentsFile: CommentsFile = {
      version: "2",
      issue_updated_at: {},
      fetched_at: { "owner/repo#1": "2026-04-05T00:00:00Z" },
      comments: { "owner/repo#1": [] },
    };

    const output = formatTask(task, resolveTaskComments(task, commentsFile));

    expect(output).toContain("--- Comments (0) ---");
    expect(output).not.toContain("pull --with-comments");
  });
});

describe("[FR-CLI-019-AC2] show --json の出力は task のフィールドを維持したまま comments 配列と comments_fetched_at を含む", () => {
  it("task のフィールドに加えて comments と comments_fetched_at を返す", () => {
    const task = makeTask();
    const comment = makeComment();
    const commentsFile: CommentsFile = {
      version: "2",
      issue_updated_at: {},
      fetched_at: { "owner/repo#1": "2026-04-05T00:00:00Z" },
      comments: { "owner/repo#1": [comment] },
    };

    const json = buildShowJson(task, resolveTaskComments(task, commentsFile));

    expect(json).toMatchObject({
      id: "owner/repo#1",
      title: "テストタスク",
      comments: [comment],
      comments_fetched_at: "2026-04-05T00:00:00Z",
    });
  });
});

describe("[FR-CLI-019-AC3] コメント未取得の Issue では show は未取得である旨と pull --with-comments による取得方法を案内し、--json では comments を null にする", () => {
  it("人間向け表示では未取得と取得方法を案内する", () => {
    const task = makeTask();

    const output = formatTask(task, resolveTaskComments(task, notFetched));

    expect(output).toMatch(/^Comments:\s+not fetched/m);
    expect(output).toContain("gh-gantt pull --with-comments");
  });

  it("GitHub Issue を持たない draft task と milestone には未取得の案内を出さない", async () => {
    storage.tasks = [makeTask({ id: "owner/repo#draft-1", github_issue: null })];
    storage.commentsFile = notFetched;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTaskShowCommand().parseAsync(["owner/repo#draft-1"], { from: "user" });
    expect(String(log.mock.calls.at(-1)?.[0])).not.toContain("not fetched");

    await createTaskShowCommand().parseAsync(["owner/repo#draft-1", "--json"], { from: "user" });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).not.toHaveProperty("comments");

    expect(hasIssueComments(makeTask({ id: "milestone:owner/repo#1", github_issue: 1 }))).toBe(
      false,
    );
    expect(hasIssueComments(makeTask())).toBe(true);
  });

  it("--json では comments と comments_fetched_at を null にする", () => {
    const task = makeTask();

    const json = buildShowJson(task, resolveTaskComments(task, notFetched));

    expect(json.comments).toBeNull();
    expect(json.comments_fetched_at).toBeNull();
  });
});

describe("show コマンドは commentsStore からコメントを読む", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    storage.tasks = [makeTask()];
    storage.commentsFile = {
      version: "2",
      issue_updated_at: {},
      fetched_at: { "owner/repo#1": "2026-04-05T00:00:00Z" },
      comments: { "owner/repo#1": [makeComment({ body: "from store" })] },
    };
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("--json で commentsStore のコメントを含めて出力する", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTaskShowCommand().parseAsync(["1", "--json"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    const parsed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(parsed.comments).toEqual([expect.objectContaining({ body: "from store" })]);
    expect(parsed.comments_fetched_at).toBe("2026-04-05T00:00:00Z");
  });

  it("人間向け表示で commentsStore のコメントを表示する", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTaskShowCommand().parseAsync(["1"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(String(log.mock.calls.at(-1)?.[0])).toContain("from store");
  });
});
