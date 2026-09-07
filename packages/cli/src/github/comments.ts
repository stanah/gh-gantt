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

export interface FetchCommentsItem {
  taskId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  /** tasks が保持する Issue の updated_at。増分判定に使う。未指定なら取得済みはスキップする */
  updatedAt?: string;
}

/**
 * 取得済み Issue を再取得すべきか判定する。
 *
 * - 未取得なら取得する
 * - updated_at が不明なら従来どおり取得済みをスキップする
 * - 前回観測した issue_updated_at があればそれと等値比較する
 * - version 1 由来で issue_updated_at がなければ fetched_at との時刻比較にフォールバックする
 */
export function shouldRefetchComments(item: FetchCommentsItem, data: CommentsFile): boolean {
  const fetchedAt = data.fetched_at[item.taskId];
  if (!fetchedAt) return true;
  if (!item.updatedAt) return false;

  const observed = data.issue_updated_at[item.taskId];
  if (observed !== undefined) return observed !== item.updatedAt;

  const updatedMs = Date.parse(item.updatedAt);
  const fetchedMs = Date.parse(fetchedAt);
  if (Number.isNaN(updatedMs) || Number.isNaN(fetchedMs)) return true;
  return updatedMs > fetchedMs;
}

export async function fetchAllComments(
  gql: typeof graphql,
  items: FetchCommentsItem[],
  existing: CommentsFile,
  saveProgress: (data: CommentsFile) => Promise<void>,
  options?: FetchAllCommentsOptions,
): Promise<CommentsFile> {
  const data: CommentsFile = {
    version: "2",
    fetched_at: { ...existing.fetched_at },
    issue_updated_at: { ...existing.issue_updated_at },
    comments: { ...existing.comments },
  };

  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let rateLimited = false;

  const toFetch = items.filter((item) => {
    if (!options?.force && !shouldRefetchComments(item, data)) {
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
        if (item.updatedAt) {
          data.issue_updated_at[item.taskId] = item.updatedAt;
        } else {
          delete data.issue_updated_at[item.taskId];
        }
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
