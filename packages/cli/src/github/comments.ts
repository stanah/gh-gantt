import type { graphql } from "@octokit/graphql";
import type { Comment, CommentsFile } from "@gh-gantt/shared";
import { ISSUE_COMMENTS_QUERY } from "./queries.js";

const BATCH_SIZE = 10;

export async function fetchIssueComments(
  gql: typeof graphql,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Comment[]> {
  const comments: Comment[] = [];
  let cursor: string | null = null;

  for (;;) {
    const result: any = await gql(ISSUE_COMMENTS_QUERY, {
      owner,
      repo,
      number: issueNumber,
      cursor,
    });

    const issue = result.repository?.issue;
    if (!issue) return comments;

    const connection = issue.comments;
    for (const node of connection.nodes) {
      comments.push({
        id: node.id,
        author: node.author?.login ?? "ghost",
        body: node.body,
        created_at: node.createdAt,
        updated_at: node.updatedAt,
      });
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return comments;
}

export interface FetchAllCommentsOptions {
  force?: boolean;
}

export async function fetchAllComments(
  gql: typeof graphql,
  items: Array<{ taskId: string; owner: string; repo: string; issueNumber: number }>,
  existing: CommentsFile,
  saveProgress: (data: CommentsFile) => Promise<void>,
  options?: FetchAllCommentsOptions,
): Promise<CommentsFile> {
  const data: CommentsFile = {
    version: "1",
    fetched_at: { ...existing.fetched_at },
    comments: { ...existing.comments },
  };

  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let rateLimited = false;

  const toFetch = items.filter((item) => {
    if (!options?.force && data.fetched_at[item.taskId]) {
      skipped++;
      return false;
    }
    return true;
  });

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    if (rateLimited) break;

    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          const comments = await fetchIssueComments(gql, item.owner, item.repo, item.issueNumber);
          return { item, comments, error: null };
        } catch (err: any) {
          return { item, comments: null, error: err };
        }
      }),
    );

    for (const { item, comments, error } of results) {
      if (error) {
        if (error?.status === 403 || error?.message?.includes("rate limit")) {
          console.warn(`Rate limited after fetching ${fetched} issues. Re-run to continue.`);
          rateLimited = true;
          continue;
        }
        console.warn(
          `Failed to fetch comments for ${item.taskId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed++;
      } else if (comments) {
        data.comments[item.taskId] = comments;
        data.fetched_at[item.taskId] = new Date().toISOString();
        fetched++;
      }
    }

    await saveProgress(data);
  }

  console.log(
    `Comments: ${fetched} fetched, ${skipped} cached${failed > 0 ? `, ${failed} failed` : ""}`,
  );
  return data;
}
