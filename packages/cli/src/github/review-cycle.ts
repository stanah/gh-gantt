import { z } from "zod";

export interface ReviewCycleComment {
  id: string;
  body: string;
  author: { login: string } | null;
  createdAt: string;
}

export interface ReviewCycleThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  comments: { nodes: ReviewCycleComment[] };
}

export interface ReviewCycleReview {
  id: string;
  state: string;
  body: string;
  author: { login: string } | null;
  submittedAt: string | null;
}

export interface ReviewCyclePullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision: string | null;
  reviewThreads: { nodes: ReviewCycleThread[] };
  reviews: { nodes: ReviewCycleReview[] };
}

export interface ReviewCycleSummary {
  pr: {
    id: string;
    number: number;
    title: string;
    url: string;
    headRefName: string;
    headRefOid: string;
    reviewDecision: string | null;
  };
  unresolvedThreads: Array<{
    id: string;
    path: string;
    line: number | null;
    startLine: number | null;
    isOutdated: boolean;
    author: string;
    bodyPreview: string;
    source: "bot" | "human";
  }>;
  changesRequestedReviews: Array<{
    id: string;
    author: string;
    submittedAt: string | null;
    bodyPreview: string;
    source: "bot" | "human";
  }>;
}

export const REVIEW_CYCLE_QUERY = /* GraphQL */ `
  query ReviewCycle(
    $owner: String!
    $name: String!
    $prNumber: Int!
    $headRefName: String!
    $byNumber: Boolean!
    $byHead: Boolean!
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $prNumber) @include(if: $byNumber) {
        ...ReviewCyclePullRequest
      }
      pullRequests(
        headRefName: $headRefName
        states: OPEN
        first: 1
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) @include(if: $byHead) {
        nodes {
          ...ReviewCyclePullRequest
        }
      }
    }
  }

  fragment ReviewCyclePullRequest on PullRequest {
    id
    number
    title
    url
    state
    headRefName
    headRefOid
    reviewDecision
    reviewThreads(first: 100) {
      nodes {
        id
        isResolved
        isOutdated
        path
        line
        startLine
        comments(first: 20) {
          nodes {
            id
            body
            createdAt
            author {
              login
            }
          }
        }
      }
    }
    reviews(last: 50) {
      nodes {
        id
        state
        body
        submittedAt
        author {
          login
        }
      }
    }
  }
`;

export interface ReviewCycleQueryResponse {
  repository: {
    pullRequest?: ReviewCyclePullRequest | null;
    pullRequests?: { nodes: ReviewCyclePullRequest[] } | null;
  } | null;
}

export function parseRepo(value: string): { owner: string; name: string } {
  const [owner, name, extra] = value.split("/");
  if (!owner || !name || extra) {
    throw new Error(`Invalid repo: ${value}. Expected owner/name.`);
  }
  return { owner, name };
}

export function selectPullRequest(data: ReviewCycleQueryResponse): ReviewCyclePullRequest | null {
  const repo = data.repository;
  if (!repo) return null;
  if (repo.pullRequest) return repo.pullRequest;
  return repo.pullRequests?.nodes[0] ?? null;
}

export function summarizeReviewCycle(pr: ReviewCyclePullRequest): ReviewCycleSummary {
  const unresolvedThreads = pr.reviewThreads.nodes
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const firstComment = thread.comments.nodes[0];
      const author = firstComment?.author?.login ?? "unknown";
      return {
        id: thread.id,
        path: thread.path,
        line: thread.line,
        startLine: thread.startLine,
        isOutdated: thread.isOutdated,
        author,
        bodyPreview: preview(firstComment?.body ?? ""),
        source: classifyAuthor(author),
      };
    });

  const latestReviews = latestReviewsByAuthor(pr.reviews.nodes);
  const changesRequestedReviews =
    pr.reviewDecision === "CHANGES_REQUESTED" ? latestReviews.filter(isChangesRequestedReview) : [];

  return {
    pr: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      reviewDecision: pr.reviewDecision,
    },
    unresolvedThreads,
    changesRequestedReviews: changesRequestedReviews.map((review) => {
      const author = review.author?.login ?? "unknown";
      return {
        id: review.id,
        author,
        submittedAt: review.submittedAt,
        bodyPreview: preview(review.body),
        source: classifyAuthor(author),
      };
    }),
  };
}

export function hasPendingReviewWork(summary: ReviewCycleSummary): boolean {
  return summary.unresolvedThreads.length > 0 || summary.changesRequestedReviews.length > 0;
}

export function formatReviewCycleSummary(
  summary: ReviewCycleSummary,
  opts: { fromCache?: boolean } = {},
): string {
  const lines: string[] = [];
  const cacheLabel = opts.fromCache ? " (cached)" : "";
  lines.push(`PR #${summary.pr.number}: ${summary.pr.title}${cacheLabel}`);
  lines.push(summary.pr.url);

  if (!hasPendingReviewWork(summary)) {
    lines.push("未解決レビューコメントはありません。");
    return lines.join("\n");
  }

  lines.push(`未解決 review thread: ${summary.unresolvedThreads.length}`);
  for (const thread of summary.unresolvedThreads) {
    const range =
      thread.startLine && thread.line && thread.startLine !== thread.line
        ? `${thread.startLine}-${thread.line}`
        : String(thread.line ?? thread.startLine ?? "?");
    const outdated = thread.isOutdated ? " outdated" : "";
    lines.push(
      `- ${thread.id} ${thread.path}:${range} by ${thread.author} [${thread.source}${outdated}] ${thread.bodyPreview}`,
    );
  }

  if (summary.changesRequestedReviews.length > 0) {
    lines.push(`Changes requested review: ${summary.changesRequestedReviews.length}`);
    for (const review of summary.changesRequestedReviews) {
      lines.push(`- ${review.id} by ${review.author} [${review.source}] ${review.bodyPreview}`);
    }
  }

  lines.push("");
  lines.push("標準手順:");
  lines.push("1. 各指摘を精査し、妥当なものだけ修正する");
  lines.push("2. 対応結果は pending review に返信を積み、submit で 1 回通知する");
  lines.push("3. 対応済み thread は GraphQL alias mutation でまとめて resolve する");
  lines.push("4. `gh-gantt review-cycle submit --plan <json>` を使う");
  return lines.join("\n");
}

export const ReviewCyclePlanSchema = z
  .object({
    repo: z
      .string()
      .regex(/^[^/]+\/[^/]+$/)
      .optional(),
    pr: z.number().int().positive(),
    reviewBody: z.string().min(1).default("レビュー指摘へ対応しました。"),
    replies: z
      .array(
        z.object({
          threadId: z.string().min(1),
          body: z.string().min(1),
        }),
      )
      .default([]),
    resolveThreadIds: z.array(z.string().min(1)).default([]),
  })
  .refine((value) => value.replies.length > 0 || value.resolveThreadIds.length > 0, {
    message: "replies または resolveThreadIds の少なくとも一方が必要です",
  });

export type ReviewCyclePlan = z.infer<typeof ReviewCyclePlanSchema>;

export const CREATE_PENDING_REVIEW_MUTATION = /* GraphQL */ `
  mutation CreatePendingReview($pullRequestId: ID!, $commitOID: GitObjectID, $body: String) {
    addPullRequestReview(
      input: { pullRequestId: $pullRequestId, commitOID: $commitOID, body: $body }
    ) {
      pullRequestReview {
        id
      }
    }
  }
`;

export const SUBMIT_PENDING_REVIEW_MUTATION = /* GraphQL */ `
  mutation SubmitPendingReview($pullRequestReviewId: ID!, $body: String!) {
    submitPullRequestReview(
      input: { pullRequestReviewId: $pullRequestReviewId, event: COMMENT, body: $body }
    ) {
      pullRequestReview {
        id
        state
      }
    }
  }
`;

export function buildThreadRepliesMutation(replyCount: number): string | null {
  if (replyCount === 0) return null;

  const variables = ["$pullRequestReviewId: ID!"];
  const fields: string[] = [];
  for (let i = 0; i < replyCount; i++) {
    variables.push(`$threadId${i}: ID!`, `$body${i}: String!`);
    fields.push(`  reply${i}: addPullRequestReviewThreadReply(
    input: {
      pullRequestReviewId: $pullRequestReviewId
      pullRequestReviewThreadId: $threadId${i}
      body: $body${i}
    }
  ) {
    comment {
      id
    }
  }`);
  }
  return `mutation AddReviewThreadReplies(${variables.join(", ")}) {\n${fields.join("\n")}\n}`;
}

export function buildResolveReviewThreadsMutation(threadCount: number): string | null {
  if (threadCount === 0) return null;

  const variables: string[] = [];
  const fields: string[] = [];
  for (let i = 0; i < threadCount; i++) {
    variables.push(`$threadId${i}: ID!`);
    fields.push(`  resolve${i}: resolveReviewThread(input: { threadId: $threadId${i} }) {
    thread {
      id
      isResolved
    }
  }`);
  }
  return `mutation ResolveReviewThreads(${variables.join(", ")}) {\n${fields.join("\n")}\n}`;
}

export function buildThreadReplyVariables(
  pullRequestReviewId: string,
  replies: ReviewCyclePlan["replies"],
): Record<string, string> {
  const variables: Record<string, string> = { pullRequestReviewId };
  replies.forEach((reply, index) => {
    variables[`threadId${index}`] = reply.threadId;
    variables[`body${index}`] = reply.body;
  });
  return variables;
}

export function buildResolveThreadVariables(threadIds: string[]): Record<string, string> {
  return Object.fromEntries(threadIds.map((threadId, index) => [`threadId${index}`, threadId]));
}

function classifyAuthor(login: string): "bot" | "human" {
  const normalized = login.toLowerCase();
  return normalized.endsWith("[bot]") ||
    normalized.includes("coderabbit") ||
    normalized.includes("copilot")
    ? "bot"
    : "human";
}

function latestReviewsByAuthor(reviews: ReviewCycleReview[]): ReviewCycleReview[] {
  const sorted = [...reviews].sort((a, b) => reviewTimestamp(a) - reviewTimestamp(b));
  const latest = new Map<string, ReviewCycleReview>();
  for (const review of sorted) {
    const key = review.author?.login ?? review.id;
    latest.set(key, review);
  }
  return [...latest.values()];
}

function isChangesRequestedReview(review: ReviewCycleReview): boolean {
  return review.state === "CHANGES_REQUESTED";
}

function reviewTimestamp(review: ReviewCycleReview): number {
  return review.submittedAt ? Date.parse(review.submittedAt) || 0 : 0;
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}
