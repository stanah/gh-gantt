import { describe, it, expect, vi } from "vitest";
import { fetchProject } from "../github/projects.js";

function makeProjectResponse(items: any[]) {
  return {
    user: {
      projectV2: {
        id: "PVT_x",
        title: "Test Project",
        fields: { nodes: [] },
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: items,
        },
      },
    },
  };
}

function makeIssueItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-issue",
    fieldValues: { nodes: [] },
    content: {
      __typename: "Issue",
      id: "I_1",
      number: 1,
      title: "Issue Title",
      body: "body",
      state: "OPEN",
      stateReason: null,
      issueType: null,
      assignees: { nodes: [] },
      labels: { nodes: [] },
      milestone: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      closedAt: null,
      repository: { nameWithOwner: "owner/repo" },
      ...overrides,
    },
  };
}

function makePullRequestItem() {
  return {
    id: "item-pr",
    fieldValues: { nodes: [] },
    // GraphQL は一致しないフラグメントに対して __typename のみ返す。
    // Issue 固有のフィールド（state, assignees など）は存在しない。
    content: {
      __typename: "PullRequest",
    },
  };
}

function makeDraftIssueItem() {
  return {
    id: "item-draft",
    fieldValues: { nodes: [] },
    content: {
      __typename: "DraftIssue",
    },
  };
}

describe("fetchProject", () => {
  it("[Issue #159] Issue 項目の state を小文字で返す", async () => {
    const gql = vi.fn().mockResolvedValueOnce(makeProjectResponse([makeIssueItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content?.state).toBe("open");
    expect(result.items[0].content?.number).toBe(1);
  });

  it("[Issue #159] PullRequest 項目をクラッシュさせずスキップする", async () => {
    const gql = vi
      .fn()
      .mockResolvedValueOnce(makeProjectResponse([makeIssueItem(), makePullRequestItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    // Issue のみ残り、PR はフィルタアウトされること。
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content?.number).toBe(1);
  });

  it("[Issue #159] DraftIssue 項目をスキップする", async () => {
    const gql = vi
      .fn()
      .mockResolvedValueOnce(makeProjectResponse([makeIssueItem(), makeDraftIssueItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content?.number).toBe(1);
  });

  it("[Issue #159] PullRequest のみのプロジェクトを正常に処理する", async () => {
    const gql = vi.fn().mockResolvedValueOnce(makeProjectResponse([makePullRequestItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    expect(result.items).toHaveLength(0);
    expect(result.projectTitle).toBe("Test Project");
  });
});
