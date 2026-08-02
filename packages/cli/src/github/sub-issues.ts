import type { graphql } from "@octokit/graphql";
import { ISSUE_RELATIONSHIPS_QUERY } from "./queries.js";

export interface SubIssueLink {
  parentNumber: number;
  parentRepo: string;
  childNumber: number;
  childRepo: string;
}

export interface BlockedByLink {
  blockedNumber: number;
  blockedRepo: string;
  blockingNumber: number;
  blockingRepo: string;
}

export interface IssueRelationships {
  subIssues: Array<{ number: number; repository: string }>;
  blockedBy: Array<{ number: number; repository: string }>;
}

class RelationshipPaginationError extends Error {}

function isExplicitlyUnsupportedRelationshipCapability(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot query field ["'](?:subIssues|blockedBy)["'] on type ["']Issue["']|Field ["'](?:subIssues|blockedBy)["'] .*does(?: not|n't) exist on type ["']Issue["']/i.test(
    message,
  );
}

export async function fetchIssueRelationships(
  gql: typeof graphql,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueRelationships> {
  try {
    const relationships: IssueRelationships = { subIssues: [], blockedBy: [] };
    let subIssuesCursor: string | null = null;
    let blockedByCursor: string | null = null;
    let hasNextSubIssues = true;
    let hasNextBlockedBy = true;
    while (hasNextSubIssues || hasNextBlockedBy) {
      const result: any = await gql(ISSUE_RELATIONSHIPS_QUERY, {
        owner,
        repo,
        number: issueNumber,
        subIssuesCursor,
        blockedByCursor,
      });
      const issue = result?.repository?.issue;
      if (
        !issue ||
        !issue.subIssues ||
        !Array.isArray(issue.subIssues.nodes) ||
        !issue.subIssues.pageInfo ||
        !issue.blockedBy ||
        !Array.isArray(issue.blockedBy.nodes) ||
        !issue.blockedBy.pageInfo
      ) {
        throw new Error("relationship responseが不完全です");
      }
      relationships.subIssues.push(
        ...(issue.subIssues?.nodes ?? []).map((si: any) => ({
          number: si.number,
          repository: si.repository.nameWithOwner,
        })),
      );
      relationships.blockedBy.push(
        ...(issue.blockedBy?.nodes ?? []).map((bi: any) => ({
          number: bi.number,
          repository: bi.repository.nameWithOwner,
        })),
      );
      hasNextSubIssues = issue.subIssues?.pageInfo?.hasNextPage === true;
      hasNextBlockedBy = issue.blockedBy?.pageInfo?.hasNextPage === true;
      const nextSubIssuesCursor = issue.subIssues?.pageInfo?.endCursor ?? null;
      const nextBlockedByCursor = issue.blockedBy?.pageInfo?.endCursor ?? null;
      if (
        (hasNextSubIssues && (!nextSubIssuesCursor || nextSubIssuesCursor === subIssuesCursor)) ||
        (hasNextBlockedBy && (!nextBlockedByCursor || nextBlockedByCursor === blockedByCursor))
      ) {
        throw new RelationshipPaginationError("relationship cursorが前進しません");
      }
      subIssuesCursor = hasNextSubIssues ? nextSubIssuesCursor : subIssuesCursor;
      blockedByCursor = hasNextBlockedBy ? nextBlockedByCursor : blockedByCursor;
    }
    return {
      subIssues: [
        ...new Map(
          relationships.subIssues.map((item) => [`${item.repository}#${item.number}`, item]),
        ).values(),
      ],
      blockedBy: [
        ...new Map(
          relationships.blockedBy.map((item) => [`${item.repository}#${item.number}`, item]),
        ).values(),
      ],
    };
  } catch (error) {
    if (error instanceof RelationshipPaginationError) throw error;
    if (isExplicitlyUnsupportedRelationshipCapability(error)) {
      return { subIssues: [], blockedBy: [] };
    }
    throw error;
  }
}

export async function fetchAllIssueRelationshipLinks(
  gql: typeof graphql,
  items: Array<{ number: number; repository: string }>,
): Promise<{ subIssueLinks: SubIssueLink[]; blockedByLinks: BlockedByLink[] }> {
  const BATCH_SIZE = 10;
  const subIssueLinks: SubIssueLink[] = [];
  const blockedByLinks: BlockedByLink[] = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (item) => {
        const [owner, repo] = item.repository.split("/");
        const rels = await fetchIssueRelationships(gql, owner, repo, item.number);
        return {
          subIssues: rels.subIssues.map((child) => ({
            parentNumber: item.number,
            parentRepo: item.repository,
            childNumber: child.number,
            childRepo: child.repository,
          })),
          blockedBy: rels.blockedBy.map((blocker) => ({
            blockedNumber: item.number,
            blockedRepo: item.repository,
            blockingNumber: blocker.number,
            blockingRepo: blocker.repository,
          })),
        };
      }),
    );
    for (const r of results) {
      subIssueLinks.push(...r.subIssues);
      blockedByLinks.push(...r.blockedBy);
    }
  }

  return { subIssueLinks, blockedByLinks };
}

// Backward-compatible wrapper
export async function fetchAllSubIssueLinks(
  gql: typeof graphql,
  items: Array<{ number: number; repository: string }>,
): Promise<SubIssueLink[]> {
  const { subIssueLinks } = await fetchAllIssueRelationshipLinks(gql, items);
  return subIssueLinks;
}
