import { describe, expect, it, vi } from "vitest";
import type { Task } from "@gh-gantt/shared";
import { applySubIssueLinks } from "../github/issues.js";
import { fetchIssueRelationships } from "../github/sub-issues.js";

const task = (id: string): Task => ({
  id,
  type: "task",
  github_issue: Number(id.split("#")[1]),
  github_repo: "example/public",
  parent: null,
  sub_tasks: [],
  title: id,
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
});

describe("[NFR-STABILITY-014-AC8] sub-issue優先順の往復同期", () => {
  it("GitHub subIssues connectionの順序をpull projectionへそのまま保存する", async () => {
    const gql = vi.fn(async () => ({
      repository: {
        issue: {
          subIssues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [3, 1, 2].map((number) => ({
              number,
              repository: { nameWithOwner: "example/public" },
            })),
          },
          blockedBy: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    }));
    const relationships = await fetchIssueRelationships(gql as never, "example", "public", 10);
    const tasks = [
      task("example/public#10"),
      task("example/public#1"),
      task("example/public#2"),
      task("example/public#3"),
    ];
    applySubIssueLinks(
      tasks,
      relationships.subIssues.map((child) => ({
        parentNumber: 10,
        parentRepo: "example/public",
        childNumber: child.number,
        childRepo: child.repository,
      })),
    );
    expect(tasks[0]!.sub_tasks).toEqual([
      "example/public#3",
      "example/public#1",
      "example/public#2",
    ]);
  });

  it("subIssuesとblockedByをcursor終端まで取得して100件超も保存する", async () => {
    const gql = vi.fn(async (_query: string, variables: { subIssuesCursor?: string }) => {
      const second = variables.subIssuesCursor === "sub-page-2";
      return {
        repository: {
          issue: {
            subIssues: {
              pageInfo: { hasNextPage: !second, endCursor: second ? null : "sub-page-2" },
              nodes: (second ? [101] : Array.from({ length: 100 }, (_, index) => index + 1)).map(
                (number) => ({ number, repository: { nameWithOwner: "example/public" } }),
              ),
            },
            blockedBy: {
              pageInfo: { hasNextPage: !second, endCursor: second ? null : "block-page-2" },
              nodes: (second ? [201] : Array.from({ length: 100 }, (_, index) => index + 101)).map(
                (number) => ({ number, repository: { nameWithOwner: "example/public" } }),
              ),
            },
          },
        },
      };
    });

    const relationships = await fetchIssueRelationships(gql as never, "example", "public", 100);
    expect(relationships.subIssues.map((item) => item.number)).toEqual([
      ...Array.from({ length: 100 }, (_, index) => index + 1),
      101,
    ]);
    expect(relationships.blockedBy).toHaveLength(101);
    expect(gql).toHaveBeenCalledTimes(2);
  });

  it("hasNextPageでcursorが前進しない場合は空集合に退行せずfail-closedする", async () => {
    const gql = vi.fn(async () => ({
      repository: {
        issue: {
          subIssues: {
            pageInfo: { hasNextPage: true, endCursor: null },
            nodes: [],
          },
          blockedBy: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    }));
    await expect(fetchIssueRelationships(gql as never, "example", "public", 100)).rejects.toThrow(
      "relationship cursorが前進しません",
    );
  });

  it("auth/rate-limit errorをunsupported扱いせずfail-closedする", async () => {
    const gql = vi.fn(async () => {
      throw new Error("403 Resource not accessible by integration; rate limit exceeded");
    });
    await expect(fetchIssueRelationships(gql as never, "example", "public", 100)).rejects.toThrow(
      "403 Resource not accessible",
    );
  });

  it("partial responseでrelationship connectionが欠けた場合はfail-closedする", async () => {
    const gql = vi.fn(async () => ({ repository: { issue: { subIssues: null } } }));
    await expect(fetchIssueRelationships(gql as never, "example", "public", 100)).rejects.toThrow(
      "relationship responseが不完全です",
    );
  });

  it("GraphQL schemaがrelationship fieldを明示的にunsupportedと返した場合だけ空集合へfallbackする", async () => {
    const gql = vi.fn(async () => {
      throw new Error('Cannot query field "subIssues" on type "Issue".');
    });
    await expect(fetchIssueRelationships(gql as never, "example", "public", 100)).resolves.toEqual({
      subIssues: [],
      blockedBy: [],
    });
  });
});
