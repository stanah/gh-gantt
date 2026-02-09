import type { graphql } from "@octokit/graphql";
import { SUB_ISSUES_QUERY } from "./queries.js";

export interface SubIssueLink {
  parentNumber: number;
  parentRepo: string;
  childNumber: number;
  childRepo: string;
}

export async function fetchSubIssues(
  gql: typeof graphql,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Array<{ number: number; repository: string }>> {
  try {
    const result: any = await gql(SUB_ISSUES_QUERY, { owner, repo, number: issueNumber });
    const subIssues = result.repository.issue.subIssues.nodes;
    return subIssues.map((si: any) => ({
      number: si.number,
      repository: si.repository.nameWithOwner,
    }));
  } catch {
    // Sub-issues API may not be available for all repos
    return [];
  }
}

export async function fetchAllSubIssueLinks(
  gql: typeof graphql,
  items: Array<{ number: number; repository: string }>,
): Promise<SubIssueLink[]> {
  const links: SubIssueLink[] = [];

  for (const item of items) {
    const [owner, repo] = item.repository.split("/");
    const subIssues = await fetchSubIssues(gql, owner, repo, item.number);
    for (const child of subIssues) {
      links.push({
        parentNumber: item.number,
        parentRepo: item.repository,
        childNumber: child.number,
        childRepo: child.repository,
      });
    }
  }

  return links;
}
