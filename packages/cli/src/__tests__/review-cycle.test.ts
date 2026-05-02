import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildResolveReviewThreadsMutation,
  buildResolveThreadVariables,
  buildThreadRepliesMutation,
  buildThreadReplyVariables,
  formatReviewCycleSummary,
  ReviewCyclePlanSchema,
  summarizeReviewCycle,
  type ReviewCyclePullRequest,
} from "../github/review-cycle.js";

function makePullRequest(overrides: Partial<ReviewCyclePullRequest> = {}): ReviewCyclePullRequest {
  return {
    id: "PR_1",
    number: 174,
    title: "レビューサイクルを整備する",
    url: "https://github.com/stanah/gh-gantt/pull/174",
    state: "OPEN",
    headRefName: "codex/issue-174-review-cycle",
    headRefOid: "abc123",
    reviewDecision: "CHANGES_REQUESTED",
    reviewThreads: {
      nodes: [
        {
          id: "thread-bot",
          isResolved: false,
          isOutdated: false,
          path: "packages/cli/src/commands/review-cycle.ts",
          line: 42,
          startLine: 40,
          comments: {
            nodes: [
              {
                id: "comment-bot",
                body: "Bot review comment",
                author: { login: "coderabbitai[bot]" },
                createdAt: "2026-05-02T00:00:00Z",
              },
            ],
          },
        },
        {
          id: "thread-human",
          isResolved: false,
          isOutdated: true,
          path: "docs/adr/ADR-010-three-layer-workflow-guard.md",
          line: 88,
          startLine: 88,
          comments: {
            nodes: [
              {
                id: "comment-human",
                body: "Human review comment",
                author: { login: "stanah" },
                createdAt: "2026-05-02T00:01:00Z",
              },
            ],
          },
        },
        {
          id: "thread-resolved",
          isResolved: true,
          isOutdated: false,
          path: "README.md",
          line: 1,
          startLine: 1,
          comments: { nodes: [] },
        },
      ],
    },
    reviews: {
      nodes: [
        {
          id: "review-bot",
          state: "CHANGES_REQUESTED",
          body: "Changes requested by Copilot",
          author: { login: "Copilot" },
          submittedAt: "2026-05-02T00:02:00Z",
        },
        {
          id: "review-comment",
          state: "COMMENTED",
          body: "Comment only",
          author: { login: "stanah" },
          submittedAt: "2026-05-02T00:03:00Z",
        },
      ],
    },
    ...overrides,
  };
}

describe("[NFR-STABILITY-005-AC1] PR 後レビューサイクル検出", () => {
  it("Bot と人間の未解決 review thread / changes requested review を要約する", () => {
    const summary = summarizeReviewCycle(makePullRequest());

    expect(summary.unresolvedThreads).toHaveLength(2);
    expect(summary.unresolvedThreads.map((thread) => thread.source)).toEqual(["bot", "human"]);
    expect(summary.unresolvedThreads[1]?.isOutdated).toBe(true);
    expect(summary.changesRequestedReviews).toHaveLength(1);
    expect(summary.changesRequestedReviews[0]?.source).toBe("bot");

    const output = formatReviewCycleSummary(summary);
    expect(output).toContain("pending review");
    expect(output).toContain("GraphQL alias mutation");
  });

  it("現在の review decision が changes requested でなければ過去の requested review は未対応扱いしない", () => {
    const summary = summarizeReviewCycle(
      makePullRequest({
        reviewDecision: "APPROVED",
        reviews: {
          nodes: [
            {
              id: "review-old-request",
              state: "CHANGES_REQUESTED",
              body: "古い request changes",
              author: { login: "stanah" },
              submittedAt: "2026-05-02T00:00:00Z",
            },
          ],
        },
      }),
    );

    expect(summary.changesRequestedReviews).toEqual([]);
  });

  it("同じ reviewer の古い requested review は最新 review で上書きする", () => {
    const summary = summarizeReviewCycle(
      makePullRequest({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: {
          nodes: [
            {
              id: "review-old-request",
              state: "CHANGES_REQUESTED",
              body: "古い request changes",
              author: { login: "stanah" },
              submittedAt: "2026-05-02T00:00:00Z",
            },
            {
              id: "review-new-comment",
              state: "COMMENTED",
              body: "最新はコメントのみ",
              author: { login: "stanah" },
              submittedAt: "2026-05-02T00:01:00Z",
            },
            {
              id: "review-bot-request",
              state: "CHANGES_REQUESTED",
              body: "Bot の request changes",
              author: { login: "coderabbitai[bot]" },
              submittedAt: "2026-05-02T00:02:00Z",
            },
          ],
        },
      }),
    );

    expect(summary.changesRequestedReviews.map((review) => review.id)).toEqual([
      "review-bot-request",
    ]);
  });

  it("Claude hooks が PR 作成後・push 後・次セッション開始時に review-cycle check を起動する", async () => {
    const raw = await readFile(resolve(import.meta.dirname, "../../../../.claude/settings.json"), {
      encoding: "utf-8",
    });
    const packageJsonRaw = await readFile(
      resolve(import.meta.dirname, "../../../../package.json"),
      {
        encoding: "utf-8",
      },
    );
    const settings = JSON.parse(raw) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>>;
    };
    const packageJson = JSON.parse(packageJsonRaw) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["review:check"]).toBe(
      "tsx packages/cli/src/index.ts review-cycle check",
    );
    const postToolUseCommands = settings.hooks.PostToolUse.flatMap((entry) =>
      entry.hooks.map((hook) => `${entry.matcher ?? ""} ${hook.command ?? ""}`),
    );
    const promptCommands = settings.hooks.UserPromptSubmit.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command ?? ""),
    );

    expect(postToolUseCommands).toContain(
      "Bash(gh pr create*) pnpm --silent review:check -- --current-branch --max-age-seconds 0 --hook",
    );
    expect(postToolUseCommands).toContain(
      "Bash(git push*) pnpm --silent review:check -- --current-branch --max-age-seconds 0 --hook",
    );
    expect(promptCommands).toContain(
      "pnpm --silent review:check -- --current-branch --max-age-seconds 600 --hook",
    );
  });
});

describe("[NFR-STABILITY-005-AC2] PR レビュー対応投稿", () => {
  it("pending review に既存 thread への返信を追加する aliased mutation を生成する", () => {
    const mutation = buildThreadRepliesMutation(2);

    expect(mutation).toContain("reply0: addPullRequestReviewThreadReply");
    expect(mutation).toContain("reply1: addPullRequestReviewThreadReply");
    expect(mutation).toContain("pullRequestReviewId: $pullRequestReviewId");
    expect(mutation).toContain("pullRequestReviewThreadId: $threadId0");
    expect(mutation).toContain("pullRequestReviewThreadId: $threadId1");
  });

  it("対応済み thread を GraphQL alias mutation で一括 resolve する", () => {
    const mutation = buildResolveReviewThreadsMutation(2);

    expect(mutation).toContain("resolve0: resolveReviewThread");
    expect(mutation).toContain("resolve1: resolveReviewThread");
    expect(mutation).toContain("threadId: $threadId0");
    expect(mutation).toContain("threadId: $threadId1");
  });

  it("submit plan を Zod で検証し、返信と resolve の変数を生成する", () => {
    const plan = ReviewCyclePlanSchema.parse({
      repo: "stanah/gh-gantt",
      pr: 174,
      reviewBody: "対応しました。",
      replies: [{ threadId: "thread-1", body: "修正しました。" }],
      resolveThreadIds: ["thread-1", "thread-2"],
    });

    expect(buildThreadReplyVariables("review-1", plan.replies)).toEqual({
      pullRequestReviewId: "review-1",
      threadId0: "thread-1",
      body0: "修正しました。",
    });
    expect(buildResolveThreadVariables(plan.resolveThreadIds)).toEqual({
      threadId0: "thread-1",
      threadId1: "thread-2",
    });
  });

  it("空の submit plan は拒否する", () => {
    expect(() =>
      ReviewCyclePlanSchema.parse({
        pr: 174,
        replies: [],
        resolveThreadIds: [],
      }),
    ).toThrow();
  });
});
