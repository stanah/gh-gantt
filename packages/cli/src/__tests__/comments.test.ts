import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommentsStore } from "../store/comments.js";
import { fetchAllComments, fetchIssueComments } from "../github/comments.js";
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
    expect(data.version).toBe("1");
    expect(data.fetched_at).toEqual({});
    expect(data.comments).toEqual({});
  });

  it("writes and reads round-trip", async () => {
    const store = new CommentsStore(dir);
    const file: CommentsFile = {
      version: "1",
      fetched_at: { "o/r#1": "2026-01-01T00:00:00Z" },
      comments: {
        "o/r#1": [
          { id: "C_1", author: "alice", body: "hello", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        ],
      },
    };
    await store.write(file);
    const loaded = await store.read();
    expect(loaded).toEqual(file);
  });
});

describe("fetchAllComments", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  function makeGql(commentsByNumber: Record<number, Array<{ id: string; author: string; body: string }>>) {
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
    const gql = vi.fn(makeGql({
      2: [{ id: "C_2", author: "bob", body: "world" }],
      3: [{ id: "C_3", author: "carol", body: "!" }],
    }));

    const existing: CommentsFile = {
      version: "1",
      fetched_at: { "o/r#1": "2026-01-01T00:00:00Z" },
      comments: { "o/r#1": [{ id: "C_1", author: "alice", body: "hello", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] },
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

  it("calls saveProgress after each issue fetch", async () => {
    const gql = makeGql({
      1: [{ id: "C_1", author: "alice", body: "a" }],
      2: [{ id: "C_2", author: "bob", body: "b" }],
      3: [{ id: "C_3", author: "carol", body: "c" }],
    });

    const empty: CommentsFile = { version: "1", fetched_at: {}, comments: {} };
    const saveProgress = vi.fn(async () => {});
    await fetchAllComments(gql as any, items, empty, saveProgress);

    expect(saveProgress).toHaveBeenCalledTimes(3);
  });

  it("continues on individual issue error", async () => {
    let callCount = 0;
    const gql = async (_query: string, vars: any) => {
      callCount++;
      if (vars.number === 2) throw new Error("Not found");
      return {
        repository: {
          issue: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: `C_${vars.number}`, author: { login: "a" }, body: "ok", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
            },
          },
        },
      };
    };

    const empty: CommentsFile = { version: "1", fetched_at: {}, comments: {} };
    const saveProgress = vi.fn(async () => {});
    const result = await fetchAllComments(gql as any, items, empty, saveProgress);

    // #1 and #3 should succeed; #2 should be skipped
    expect(result.comments["o/r#1"]).toHaveLength(1);
    expect(result.comments["o/r#3"]).toHaveLength(1);
    expect(result.comments["o/r#2"]).toBeUndefined();
    expect(saveProgress).toHaveBeenCalledTimes(2);
  });

  it("re-fetches all when force is true", async () => {
    const gql = vi.fn(makeGql({
      1: [{ id: "C_1_new", author: "alice", body: "updated" }],
      2: [{ id: "C_2", author: "bob", body: "world" }],
      3: [{ id: "C_3", author: "carol", body: "!" }],
    }));

    const existing: CommentsFile = {
      version: "1",
      fetched_at: { "o/r#1": "2026-01-01T00:00:00Z" },
      comments: { "o/r#1": [{ id: "C_1", author: "alice", body: "hello", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] },
    };

    const saveProgress = vi.fn(async () => {});
    const result = await fetchAllComments(gql as any, items, existing, saveProgress, { force: true });

    // All 3 should be fetched
    expect(gql).toHaveBeenCalledTimes(3);
    expect(result.comments["o/r#1"]?.[0].id).toBe("C_1_new");
  });
});

describe("fetchIssueComments", () => {
  it("handles pagination across multiple pages", async () => {
    let callCount = 0;
    const gql = async (_query: string, vars: any) => {
      callCount++;
      if (callCount === 1) {
        return {
          repository: {
            issue: {
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                nodes: [
                  { id: "C_1", author: { login: "alice" }, body: "page1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
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
                { id: "C_2", author: { login: "bob" }, body: "page2", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" },
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
