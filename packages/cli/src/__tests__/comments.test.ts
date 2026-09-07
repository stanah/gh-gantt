import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommentsStore } from "../store/comments.js";
import { fetchAllComments, fetchIssueComments } from "../github/comments.js";
import { saveCommentsCheckpoint } from "../commands/pull.js";
import { COMMENTS_FILE, GANTT_DIR } from "@gh-gantt/shared";
import type { CommentsFile } from "@gh-gantt/shared";

describe("CommentsStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-gantt-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("returns empty CommentsFile when file does not exist", async () => {
    const store = new CommentsStore(dir);
    const data = await store.read();
    expect(data.version).toBe("2");
    expect(data.issue_updated_at).toEqual({});
    expect(data.fetched_at).toEqual({});
    expect(data.comments).toEqual({});
  });

  it("writes and reads round-trip", async () => {
    const store = new CommentsStore(dir);
    const file: CommentsFile = {
      version: "2",
      fetched_at: { "o/r#1": "2026-01-01T00:00:00Z" },
      issue_updated_at: {},
      comments: {
        "o/r#1": [
          {
            id: "C_1",
            author: "alice",
            body: "hello",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };
    await store.write(file);
    const loaded = await store.read();
    expect(loaded).toEqual(file);
  });
});

describe("fetchAllComments", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeGql(
    commentsByNumber: Record<number, Array<{ id: string; author: string; body: string }>>,
  ) {
    return async (_query: string, vars: any) => ({
      repository: {
        issue: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: (commentsByNumber[vars.number] ?? []).map((c) => ({
              id: c.id,
              author: { login: c.author },
              body: c.body,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            })),
          },
        },
      },
    });
  }

  const items = [
    { taskId: "o/r#1", owner: "o", repo: "r", issueNumber: 1 },
    { taskId: "o/r#2", owner: "o", repo: "r", issueNumber: 2 },
    { taskId: "o/r#3", owner: "o", repo: "r", issueNumber: 3 },
  ];

  it("skips already-fetched tasks (resumability)", async () => {
    const gql = vi.fn(
      makeGql({
        2: [{ id: "C_2", author: "bob", body: "world" }],
        3: [{ id: "C_3", author: "carol", body: "!" }],
      }),
    );

    const existing: CommentsFile = {
      version: "2",
      fetched_at: { "o/r#1": "2026-01-01T00:00:00Z" },
      issue_updated_at: {},
      comments: {
        "o/r#1": [
          {
            id: "C_1",
            author: "alice",
            body: "hello",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };

    const saveProgress = vi.fn(async () => {});
    const result = await fetchAllComments(gql as any, items, existing, saveProgress);

    // Should NOT have queried issue #1
    expect(gql).toHaveBeenCalledTimes(2);
    expect(gql.mock.calls.every((c: any) => c[1].number !== 1)).toBe(true);

    // Should have fetched #2 and #3
    expect(result.comments["o/r#2"]).toHaveLength(1);
    expect(result.comments["o/r#3"]).toHaveLength(1);

    // Original #1 preserved
    expect(result.comments["o/r#1"]).toHaveLength(1);
  });

  it("calls saveProgress after each batch", async () => {
    const gql = makeGql({
      1: [{ id: "C_1", author: "alice", body: "a" }],
      2: [{ id: "C_2", author: "bob", body: "b" }],
      3: [{ id: "C_3", author: "carol", body: "c" }],
    });

    const empty: CommentsFile = {
      version: "2",
      fetched_at: {},
      issue_updated_at: {},
      comments: {},
    };
    const saveProgress = vi.fn(async () => {});
    await fetchAllComments(gql as any, items, empty, saveProgress);

    // 3 items fit in a single batch (BATCH_SIZE=10), so saveProgress is called once
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it("continues on individual issue error", async () => {
    const gql = async (_query: string, vars: any) => {
      if (vars.number === 2) throw new Error("Not found");
      return {
        repository: {
          issue: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: `C_${vars.number}`,
                  author: { login: "a" },
                  body: "ok",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ],
            },
          },
        },
      };
    };

    const empty: CommentsFile = {
      version: "2",
      fetched_at: {},
      issue_updated_at: {},
      comments: {},
    };
    const saveProgress = vi.fn(async () => {});
    const result = await fetchAllComments(gql as any, items, empty, saveProgress);

    // #1 and #3 should succeed; #2 should be skipped
    expect(result.comments["o/r#1"]).toHaveLength(1);
    expect(result.comments["o/r#3"]).toHaveLength(1);
    expect(result.comments["o/r#2"]).toBeUndefined();
    // 3 items in 1 batch → 1 saveProgress call
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it("re-fetches all when force is true", async () => {
    const gql = vi.fn(
      makeGql({
        1: [{ id: "C_1_new", author: "alice", body: "updated" }],
        2: [{ id: "C_2", author: "bob", body: "world" }],
        3: [{ id: "C_3", author: "carol", body: "!" }],
      }),
    );

    const existing: CommentsFile = {
      version: "2",
      fetched_at: { "o/r#1": "2026-01-01T00:00:00Z" },
      issue_updated_at: {},
      comments: {
        "o/r#1": [
          {
            id: "C_1",
            author: "alice",
            body: "hello",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };

    const saveProgress = vi.fn(async () => {});
    const result = await fetchAllComments(gql as any, items, existing, saveProgress, {
      force: true,
    });

    // All 3 should be fetched
    expect(gql).toHaveBeenCalledTimes(3);
    expect(result.comments["o/r#1"]?.[0].id).toBe("C_1_new");
  });
});

describe("コメントのチェックポイント保存", () => {
  it("コメント一括分を書き込んだ直後に永続公開する", async () => {
    const write = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    const data: CommentsFile = {
      version: "2",
      fetched_at: {},
      issue_updated_at: {},
      comments: {},
    };

    await saveCommentsCheckpoint({ commentsStore: { write }, flush }, data);

    expect(write).toHaveBeenCalledWith(data);
    expect(flush).toHaveBeenCalledOnce();
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]);
  });
});

describe("fetchIssueComments", () => {
  it("handles pagination across multiple pages", async () => {
    let callCount = 0;
    const gql = async (_query: string, _vars: any) => {
      callCount++;
      if (callCount === 1) {
        return {
          repository: {
            issue: {
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                nodes: [
                  {
                    id: "C_1",
                    author: { login: "alice" },
                    body: "page1",
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                  },
                ],
              },
            },
          },
        };
      }
      return {
        repository: {
          issue: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "C_2",
                  author: { login: "bob" },
                  body: "page2",
                  createdAt: "2026-01-02T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
              ],
            },
          },
        },
      };
    };

    const result = await fetchIssueComments(gql as any, "o", "r", 1);
    expect(callCount).toBe(2);
    expect(result).toHaveLength(2);
    expect(result[0].body).toBe("page1");
    expect(result[1].body).toBe("page2");
  });

  it("returns empty array when issue is null", async () => {
    const gql = async () => ({ repository: { issue: null } });
    const result = await fetchIssueComments(gql as any, "o", "r", 999);
    expect(result).toEqual([]);
  });
});

describe("[FR-SYNC-008-AC4] version 1 の comments.json を読み込み、fetched_at より新しい updated_at を持つ Issue だけコメントを再取得する", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-gantt-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("version 1 のファイルを issue_updated_at 空の version 2 として読み込む", async () => {
    await mkdir(join(dir, GANTT_DIR), { recursive: true });
    await writeFile(
      join(dir, GANTT_DIR, COMMENTS_FILE),
      JSON.stringify({
        version: "1",
        fetched_at: { "o/r#1": "2026-01-01T00:00:00Z" },
        comments: { "o/r#1": [makeComment("C_1", "old")] },
      }),
    );
    const store = new CommentsStore(dir);
    const loaded = await store.read();
    expect(loaded.version).toBe("2");
    expect(loaded.issue_updated_at).toEqual({});
    expect(loaded.fetched_at).toEqual({ "o/r#1": "2026-01-01T00:00:00Z" });
    expect(loaded.comments["o/r#1"]).toHaveLength(1);
  });

  it("issue_updated_at の記録がない Issue は updated_at が fetched_at より新しい場合だけ再取得する", async () => {
    const gql = vi.fn(makeGqlV2({ 1: [makeComment("C_1", "new")], 2: [makeComment("C_2", "x")] }));
    const legacy: CommentsFile = {
      version: "2",
      fetched_at: { "o/r#1": "2026-01-01T00:00:00Z", "o/r#2": "2026-01-01T00:00:00Z" },
      issue_updated_at: {},
      comments: { "o/r#1": [makeComment("C_1", "old")], "o/r#2": [makeComment("C_2", "x")] },
    };
    const result = await fetchAllComments(
      gql as any,
      [
        { ...baseItems[0], updatedAt: "2026-01-02T00:00:00Z" },
        { ...baseItems[1], updatedAt: "2025-12-31T00:00:00Z" },
      ],
      legacy,
      async () => {},
    );
    expect(gql).toHaveBeenCalledTimes(1);
    expect(gql.mock.calls[0][1].number).toBe(1);
    expect(result.comments["o/r#1"]?.[0].body).toBe("new");
    expect(result.issue_updated_at["o/r#1"]).toBe("2026-01-02T00:00:00Z");
    expect(result.issue_updated_at["o/r#2"]).toBeUndefined();
    expect(result.version).toBe("2");
  });
});

function makeComment(id: string, body: string, updatedAt = "2026-01-01T00:00:00Z") {
  return { id, author: "alice", body, created_at: "2026-01-01T00:00:00Z", updated_at: updatedAt };
}

function makeGqlV2(
  commentsByNumber: Record<
    number,
    Array<{ id: string; author: string; body: string; created_at: string; updated_at: string }>
  >,
) {
  return async (_query: string, vars: any) => ({
    repository: {
      issue: {
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: (commentsByNumber[vars.number] ?? []).map((c) => ({
            id: c.id,
            author: { login: c.author },
            body: c.body,
            createdAt: c.created_at,
            updatedAt: c.updated_at,
          })),
        },
      },
    },
  });
}

const baseItems = [
  { taskId: "o/r#1", owner: "o", repo: "r", issueNumber: 1 },
  { taskId: "o/r#2", owner: "o", repo: "r", issueNumber: 2 },
  { taskId: "o/r#3", owner: "o", repo: "r", issueNumber: 3 },
];

const fetchedAll: () => CommentsFile = () => ({
  version: "2",
  fetched_at: {
    "o/r#1": "2026-01-01T00:00:00Z",
    "o/r#2": "2026-01-01T00:00:00Z",
    "o/r#3": "2026-01-01T00:00:00Z",
  },
  issue_updated_at: {
    "o/r#1": "2026-01-01T00:00:00Z",
    "o/r#2": "2026-01-01T00:00:00Z",
    "o/r#3": "2026-01-01T00:00:00Z",
  },
  comments: {
    "o/r#1": [makeComment("C_1", "old"), makeComment("C_1b", "to be deleted")],
    "o/r#2": [makeComment("C_2", "x")],
    "o/r#3": [makeComment("C_3", "y")],
  },
});

describe("[FR-SYNC-008-AC1] 取得済み Issue でも updated_at が前回取得時と異なればコメントを再取得し、追加・編集・削除が反映される", () => {
  it("updated_at が変わった Issue のコメントを置き換える", async () => {
    const gql = vi.fn(
      makeGqlV2({
        1: [makeComment("C_1", "edited", "2026-01-05T00:00:00Z"), makeComment("C_1c", "added")],
      }),
    );
    const result = await fetchAllComments(
      gql as any,
      [
        { ...baseItems[0], updatedAt: "2026-01-05T00:00:00Z" },
        { ...baseItems[1], updatedAt: "2026-01-01T00:00:00Z" },
        { ...baseItems[2], updatedAt: "2026-01-01T00:00:00Z" },
      ],
      fetchedAll(),
      async () => {},
    );
    const comments = result.comments["o/r#1"];
    expect(comments.map((c) => c.id)).toEqual(["C_1", "C_1c"]);
    expect(comments[0].body).toBe("edited");
    expect(comments[0].updated_at).toBe("2026-01-05T00:00:00Z");
    expect(result.issue_updated_at["o/r#1"]).toBe("2026-01-05T00:00:00Z");
    expect(result.issue_updated_at["o/r#2"]).toBe("2026-01-01T00:00:00Z");
  });
});

describe("[FR-SYNC-008-AC2] updated_at が変わらない取得済み Issue には GitHub API を呼ばない", () => {
  it("全 Issue の updated_at が記録と一致すれば API 呼び出しは 0 回", async () => {
    const gql = vi.fn(makeGqlV2({}));
    const saveProgress = vi.fn(async () => {});
    const result = await fetchAllComments(
      gql as any,
      baseItems.map((item) => ({ ...item, updatedAt: "2026-01-01T00:00:00Z" })),
      fetchedAll(),
      saveProgress,
    );
    expect(gql).toHaveBeenCalledTimes(0);
    expect(result.comments["o/r#1"]).toHaveLength(2);
  });

  it("変わった Issue だけに API を呼び、他の Issue のコメントは保持する", async () => {
    const gql = vi.fn(makeGqlV2({ 2: [makeComment("C_2", "x2")] }));
    const result = await fetchAllComments(
      gql as any,
      [
        { ...baseItems[0], updatedAt: "2026-01-01T00:00:00Z" },
        { ...baseItems[1], updatedAt: "2026-01-03T00:00:00Z" },
        { ...baseItems[2], updatedAt: "2026-01-01T00:00:00Z" },
      ],
      fetchedAll(),
      async () => {},
    );
    expect(gql).toHaveBeenCalledTimes(1);
    expect(gql.mock.calls[0][1].number).toBe(2);
    expect(result.comments["o/r#1"]).toHaveLength(2);
    expect(result.comments["o/r#2"]?.[0].body).toBe("x2");
    expect(result.comments["o/r#3"]).toHaveLength(1);
  });
});

describe("[FR-SYNC-008-AC3] --force-comments では updated_at にかかわらず全 Issue のコメントを再取得する", () => {
  it("記録と一致していても force なら全件取得する", async () => {
    const gql = vi.fn(
      makeGqlV2({
        1: [makeComment("C_1", "f1")],
        2: [makeComment("C_2", "f2")],
        3: [makeComment("C_3", "f3")],
      }),
    );
    const result = await fetchAllComments(
      gql as any,
      baseItems.map((item) => ({ ...item, updatedAt: "2026-01-01T00:00:00Z" })),
      fetchedAll(),
      async () => {},
      { force: true },
    );
    expect(gql).toHaveBeenCalledTimes(3);
    expect(result.comments["o/r#1"]?.[0].body).toBe("f1");
  });
});
