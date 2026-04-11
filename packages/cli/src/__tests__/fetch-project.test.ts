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
    // GraphQL returns only __typename for non-matching fragments.
    // Issue-specific fields (state, assignees, etc.) are absent.
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
  it("returns Issue items with lowercase state", async () => {
    const gql = vi.fn().mockResolvedValueOnce(makeProjectResponse([makeIssueItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content?.state).toBe("open");
    expect(result.items[0].content?.number).toBe(1);
  });

  it("skips PullRequest items instead of crashing", async () => {
    const gql = vi
      .fn()
      .mockResolvedValueOnce(makeProjectResponse([makeIssueItem(), makePullRequestItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    // Only the Issue should be kept; PR should be filtered out.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content?.number).toBe(1);
  });

  it("skips DraftIssue items", async () => {
    const gql = vi
      .fn()
      .mockResolvedValueOnce(makeProjectResponse([makeIssueItem(), makeDraftIssueItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content?.__typename ?? "Issue").toBe("Issue");
  });

  it("handles a project with only PullRequests gracefully", async () => {
    const gql = vi.fn().mockResolvedValueOnce(makeProjectResponse([makePullRequestItem()])) as any;
    const result = await fetchProject(gql, "stanah", 5, "user");
    expect(result.items).toHaveLength(0);
    expect(result.projectTitle).toBe("Test Project");
  });
});
