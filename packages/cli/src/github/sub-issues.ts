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
  /** この Issue が block している Issue。blocker 側だけが更新された pull でも辺を復元するために取得する (#350) */
  blocking: Array<{ number: number; repository: string }>;
  /** 親 Issue。子側だけが更新された pull でも親子の辺を復元できるよう取得する (#350) */
  parent: { number: number; repository: string } | null;
}

class RelationshipPaginationError extends Error {}

function isExplicitlyUnsupportedRelationshipCapability(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot query field ["'](?:parent|subIssues|blockedBy|blocking)["'] on type ["']Issue["']|Field ["'](?:parent|subIssues|blockedBy|blocking)["'] .*does(?: not|n't) exist on type ["']Issue["']/i.test(
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
    const relationships: IssueRelationships = {
      subIssues: [],
      blockedBy: [],
      blocking: [],
      parent: null,
    };
    let subIssuesCursor: string | null = null;
    let blockedByCursor: string | null = null;
    let blockingCursor: string | null = null;
    let hasNextSubIssues = true;
    let hasNextBlockedBy = true;
    let hasNextBlocking = true;
    while (hasNextSubIssues || hasNextBlockedBy || hasNextBlocking) {
      const result: any = await gql(ISSUE_RELATIONSHIPS_QUERY, {
        owner,
        repo,
        number: issueNumber,
        subIssuesCursor,
        blockedByCursor,
        blockingCursor,
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
      if (issue.parent?.number != null && issue.parent?.repository?.nameWithOwner) {
        relationships.parent = {
          number: issue.parent.number,
          repository: issue.parent.repository.nameWithOwner,
        };
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
      // blocking は無い応答 (旧 schema や既存 fixture) も許容し、空として扱う
      relationships.blocking.push(
        ...(issue.blocking?.nodes ?? []).map((bi: any) => ({
          number: bi.number,
          repository: bi.repository.nameWithOwner,
        })),
      );
      hasNextSubIssues = issue.subIssues?.pageInfo?.hasNextPage === true;
      hasNextBlockedBy = issue.blockedBy?.pageInfo?.hasNextPage === true;
      hasNextBlocking = issue.blocking?.pageInfo?.hasNextPage === true;
      const nextSubIssuesCursor = issue.subIssues?.pageInfo?.endCursor ?? null;
      const nextBlockedByCursor = issue.blockedBy?.pageInfo?.endCursor ?? null;
      const nextBlockingCursor = issue.blocking?.pageInfo?.endCursor ?? null;
      if (
        (hasNextSubIssues && (!nextSubIssuesCursor || nextSubIssuesCursor === subIssuesCursor)) ||
        (hasNextBlockedBy && (!nextBlockedByCursor || nextBlockedByCursor === blockedByCursor)) ||
        (hasNextBlocking && (!nextBlockingCursor || nextBlockingCursor === blockingCursor))
      ) {
        throw new RelationshipPaginationError("relationship cursorが前進しません");
      }
      subIssuesCursor = hasNextSubIssues ? nextSubIssuesCursor : subIssuesCursor;
      blockedByCursor = hasNextBlockedBy ? nextBlockedByCursor : blockedByCursor;
      blockingCursor = hasNextBlocking ? nextBlockingCursor : blockingCursor;
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
      blocking: [
        ...new Map(
          relationships.blocking.map((item) => [`${item.repository}#${item.number}`, item]),
        ).values(),
      ],
      parent: relationships.parent,
    };
  } catch (error) {
    if (error instanceof RelationshipPaginationError) throw error;
    if (isExplicitlyUnsupportedRelationshipCapability(error)) {
      return { subIssues: [], blockedBy: [], blocking: [], parent: null };
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
  // 子側の parent から復元した辺。親側の subIssues 順序を正準に保つため、
  // subIssues 由来の辺をすべて並べた後に追加する。
  const parentDerivedLinks: SubIssueLink[] = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (item) => {
        const [owner, repo] = item.repository.split("/");
        const rels = await fetchIssueRelationships(gql, owner, repo, item.number);
        return {
          parentDerived: rels.parent
            ? [
                {
                  parentNumber: rels.parent.number,
                  parentRepo: rels.parent.repository,
                  childNumber: item.number,
                  childRepo: item.repository,
                },
              ]
            : [],
          subIssues: rels.subIssues.map((child) => ({
            parentNumber: item.number,
            parentRepo: item.repository,
            childNumber: child.number,
            childRepo: child.repository,
          })),
          blockedBy: [
            ...rels.blockedBy.map((blocker) => ({
              blockedNumber: item.number,
              blockedRepo: item.repository,
              blockingNumber: blocker.number,
              blockingRepo: blocker.repository,
            })),
            // この Issue が block している側の辺。blocked 側が取得対象でなくても復元できる
            ...rels.blocking.map((blocked) => ({
              blockedNumber: blocked.number,
              blockedRepo: blocked.repository,
              blockingNumber: item.number,
              blockingRepo: item.repository,
            })),
          ],
        };
      }),
    );
    for (const r of results) {
      subIssueLinks.push(...r.subIssues);
      blockedByLinks.push(...r.blockedBy);
      parentDerivedLinks.push(...r.parentDerived);
    }
  }

  return { subIssueLinks: [...subIssueLinks, ...parentDerivedLinks], blockedByLinks };
}

// Backward-compatible wrapper
export async function fetchAllSubIssueLinks(
  gql: typeof graphql,
  items: Array<{ number: number; repository: string }>,
): Promise<SubIssueLink[]> {
  const { subIssueLinks } = await fetchAllIssueRelationshipLinks(gql, items);
  return subIssueLinks;
}
