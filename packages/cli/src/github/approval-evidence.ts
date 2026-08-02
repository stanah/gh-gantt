import type { graphql } from "@octokit/graphql";
import type {
  GitHubApprovalCommentRef,
  GitHubApprovalEvidencePort,
  LiveGitHubApprovalEvidence,
} from "../work-graph/human-approval-authority.js";

const LIVE_APPROVAL_COMMENT_QUERY = `
  query MutationApprovalComment($commentId: ID!) {
    viewer { id }
    node(id: $commentId) {
      ... on IssueComment {
        id
        body
        createdAt
        updatedAt
        author {
          __typename
          login
          ... on User { id }
          ... on Bot { id }
          ... on Organization { id }
        }
        issue {
          number
          repository { nameWithOwner }
        }
      }
    }
  }
`;

interface ApprovalQueryResult {
  viewer: { id: string };
  node: null | {
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
    author: null | { __typename: "User" | "Bot" | "Organization"; id: string; login: string };
    issue: { number: number; repository: { nameWithOwner: string } };
  };
}

/** GitHub node IDからcommentを毎回live取得し、cacheを承認判断へ使わない。 */
export class GitHubLiveApprovalEvidenceAdapter implements GitHubApprovalEvidencePort {
  constructor(private readonly gql: typeof graphql) {}

  async readLiveComment(ref: GitHubApprovalCommentRef): Promise<LiveGitHubApprovalEvidence> {
    const result = await this.gql<ApprovalQueryResult>(LIVE_APPROVAL_COMMENT_QUERY, {
      commentId: ref.commentId,
    });
    const comment = result.node;
    if (!comment || !comment.author) {
      return {
        repository: ref.repository,
        issueNumber: ref.issueNumber,
        commentId: ref.commentId,
        body: "",
        author: { nodeId: "deleted", login: "deleted", type: "Bot" },
        viewerNodeId: result.viewer.id,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        deleted: true,
      };
    }
    return {
      repository: comment.issue.repository.nameWithOwner.toLowerCase(),
      issueNumber: comment.issue.number,
      commentId: comment.id,
      body: comment.body,
      author: {
        nodeId: comment.author.id,
        login: comment.author.login,
        type: comment.author.__typename,
      },
      viewerNodeId: result.viewer.id,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      deleted: false,
    };
  }
}
