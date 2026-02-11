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

export async function fetchIssueRelationships(
  gql: typeof graphql,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueRelationships> {
  try {
    const result: any = await gql(ISSUE_RELATIONSHIPS_QUERY, { owner, repo, number: issueNumber });
    const issue = result.repository.issue;
    return {
      subIssues: (issue.subIssues?.nodes ?? []).map((si: any) => ({
        number: si.number,
        repository: si.repository.nameWithOwner,
      })),
      blockedBy: (issue.blockedBy?.nodes ?? []).map((bi: any) => ({
        number: bi.number,
        repository: bi.repository.nameWithOwner,
      })),
    };
  } catch {
    // Relationships API may not be available for all repos
    return { subIssues: [], blockedBy: [] };
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
