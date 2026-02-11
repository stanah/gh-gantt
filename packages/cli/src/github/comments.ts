import type { graphql } from "@octokit/graphql";
import type { Comment, CommentsFile } from "@gh-gantt/shared";
import { ISSUE_COMMENTS_QUERY } from "./queries.js";

const DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    const connection = result.repository.issue.comments;
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

  for (const item of items) {
    if (!options?.force && data.fetched_at[item.taskId]) {
      skipped++;
      continue;
    }

    try {
      if (fetched > 0) await delay(DELAY_MS);

      const comments = await fetchIssueComments(
        gql,
        item.owner,
        item.repo,
        item.issueNumber,
      );

      data.comments[item.taskId] = comments;
      data.fetched_at[item.taskId] = new Date().toISOString();
      fetched++;

      await saveProgress(data);
    } catch (err: any) {
      if (err?.status === 403 || err?.message?.includes("rate limit")) {
        console.warn(`Rate limited after fetching ${fetched} issues. Re-run to continue.`);
        await saveProgress(data);
        break;
      }
      console.warn(`Failed to fetch comments for ${item.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Comments: ${fetched} fetched, ${skipped} cached`);
  return data;
}
