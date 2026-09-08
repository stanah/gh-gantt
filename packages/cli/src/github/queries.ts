export type OwnerType = "user" | "organization";

/**
 * 関係リンクの変更検出に使う軽量シグネチャ (#377)。
 * sub-issue / blockedBy の追加・削除は Issue の updatedAt を更新しないため、
 * 親 Issue と各接続の件数を items 一括取得に同梱して snapshot と比較する。
 * blockedBy / blocking は totalCount だけが必要なので first: 1 で取得コストを抑える。
 */
export const RELATIONSHIP_SIGNATURE_FRAGMENT = `
                parent { number repository { nameWithOwner } }
                subIssuesSummary { total }
                blockedBy(first: 1) { totalCount }
                blocking(first: 1) { totalCount }`;

function buildProjectV2Fragment(withRelationshipSignature: boolean): string {
  return `
        id
        title
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
            ... on ProjectV2Field {
              id
              name
            }
            ... on ProjectV2IterationField {
              id
              name
            }
          }
        }
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  field { ... on ProjectV2SingleSelectField { name } }
                  name
                }
                ... on ProjectV2ItemFieldTextValue {
                  field { ... on ProjectV2Field { name } }
                  text
                }
                ... on ProjectV2ItemFieldDateValue {
                  field { ... on ProjectV2Field { name } }
                  date
                }
                ... on ProjectV2ItemFieldNumberValue {
                  field { ... on ProjectV2Field { name } }
                  number
                }
                ... on ProjectV2ItemFieldIterationValue {
                  field { ... on ProjectV2IterationField { name } }
                  title
                }
              }
            }
            content {
              __typename
              ... on Issue {
                id
                number
                title
                body
                state
                stateReason
                issueType { id name }
                assignees(first: 10) { nodes { login } }
                labels(first: 20) { nodes { name } }
                milestone { title }
                createdAt
                updatedAt
                closedAt
                closedByPullRequestsReferences(first: 20) {
                  nodes {
                    number
                    title
                    state
                    url
                  }
                }
                repository { nameWithOwner }${withRelationshipSignature ? RELATIONSHIP_SIGNATURE_FRAGMENT : ""}
              }
            }
          }
        }`;
}

export interface ProjectQueryOptions {
  /**
   * 関係シグネチャ (parent / subIssuesSummary / blockedBy / blocking の件数) を同梱するか。
   * sub-issue 未対応の GitHub インスタンスではフィールド不在エラーになるため、
   * 呼び出し側がフォールバックとして false で再試行する (#377)
   */
  withRelationshipSignature?: boolean;
}

export function buildProjectQuery(ownerType: OwnerType, opts: ProjectQueryOptions = {}): string {
  return `
  query($owner: String!, $number: Int!, $cursor: String) {
    ${ownerType}(login: $owner) {
      projectV2(number: $number) {
${buildProjectV2Fragment(opts.withRelationshipSignature ?? true)}
      }
    }
  }
`;
}

/**
 * pre-check 用の軽量クエリ (#377)。items の Issue ごとに識別子と関係シグネチャだけを取得し、
 * updatedAt を動かさない関係変更を snapshot との比較で検出する。
 */
export function buildProjectRelationshipSignatureQuery(ownerType: OwnerType): string {
  return `
  query($owner: String!, $number: Int!, $cursor: String) {
    ${ownerType}(login: $owner) {
      projectV2(number: $number) {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content {
              __typename
              ... on Issue {
                number
                repository { nameWithOwner }${RELATIONSHIP_SIGNATURE_FRAGMENT}
              }
            }
          }
        }
      }
    }
  }
`;
}

export const OWNER_TYPE_QUERY = `
  query($login: String!) {
    repositoryOwner(login: $login) {
      __typename
    }
  }
`;

export const REPOSITORY_ID_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      id
    }
  }
`;

export const REPOSITORY_METADATA_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      labels(first: 100) {
        nodes { id name }
      }
      milestones(first: 50, states: OPEN) {
        nodes { id title number dueOn description closedAt state }
      }
    }
  }
`;

export function buildIssueUpdatedAtQuery(
  owner: string,
  repo: string,
  issueNumbers: number[],
): string {
  const fields = issueNumbers
    .map((n, i) => `i${i}: issue(number: ${n}) { number updatedAt stateReason closedAt }`)
    .join("\n      ");
  return `query {
    repository(owner: "${owner}", name: "${repo}") {
      ${fields}
    }
  }`;
}

export const ORG_ISSUE_TYPES_QUERY = `
  query($login: String!) {
    organization(login: $login) {
      issueTypes(first: 50) {
        nodes { id name description isEnabled }
      }
    }
  }
`;

export function buildUserIdsQuery(logins: string[]): string {
  const fields = logins
    .map((login, i) => `u${i}: user(login: "${login}") { id login }`)
    .join("\n    ");
  return `query { ${fields} }`;
}

export const ISSUE_COMMENTS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            author { login }
            body
            createdAt
            updatedAt
          }
        }
      }
    }
  }
`;

export const ISSUE_RELATIONSHIPS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $subIssuesCursor: String, $blockedByCursor: String, $blockingCursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        parent {
          number
          repository { nameWithOwner }
        }
        subIssues(first: 50, after: $subIssuesCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            repository { nameWithOwner }
          }
        }
        blockedBy(first: 50, after: $blockedByCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            repository { nameWithOwner }
          }
        }
        blocking(first: 50, after: $blockingCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`;

/** create応答がunknownの場合にcorrelation markerで照合するライブquery。 */
export const MUTATION_CORRELATION_ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }, states: [OPEN, CLOSED]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          body
          createdAt
          repository { nameWithOwner }
          projectItems(first: 100) { nodes { id project { id } } }
        }
      }
    }
  }
`;

/** relation/state stepのリモート事後条件を照合するライブquery。 */
export const MUTATION_POSTCONDITION_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $assigneesCursor: String, $labelsCursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
        number
        title
        body
        state
        stateReason
        issueType { name }
        assignees(first: 100, after: $assigneesCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { login }
        }
        labels(first: 100, after: $labelsCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
        milestone { title }
        parent { number repository { nameWithOwner } }
      }
    }
  }
`;

/** Issueが属するProject itemをcursor終端まで探索するquery。 */
export const MUTATION_ISSUE_PROJECT_ITEMS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        projectItems(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id project { id } }
        }
      }
    }
  }
`;

/** Project itemのfield valuesをcursor終端まで取得するquery。 */
export const MUTATION_PROJECT_ITEM_FIELDS_QUERY = `
  query($itemId: ID!, $cursor: String) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        fieldValues(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              field { ... on ProjectV2SingleSelectField { name } }
              name
            }
            ... on ProjectV2ItemFieldTextValue {
              field { ... on ProjectV2Field { name } }
              text
            }
            ... on ProjectV2ItemFieldDateValue {
              field { ... on ProjectV2Field { name } }
              date
            }
            ... on ProjectV2ItemFieldNumberValue {
              field { ... on ProjectV2Field { name } }
              number
            }
            ... on ProjectV2ItemFieldIterationValue {
              field { ... on ProjectV2IterationField { name } }
              title
            }
          }
        }
      }
    }
  }
`;

/**
 * loop complete の PR evidence ゲート用に PR 単体の live 状態を取得する（ADR-019）。
 *
 * ゲート判定に使うのは state のみ。reviewDecision / reviewThreads / statusCheckRollup
 * は拒否時の診断表示と prEvidence 記録のための参考情報。reviewThreads と contexts は
 * first: 100 で打ち切る。closingIssuesReferences は Run Graph adapter が一致を見つけるか、
 * 不一致を確定できる cursor 終端まで取得する。
 */
export const PULL_REQUEST_GATE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $closingIssuesCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        state
        isDraft
        reviewDecision
        closingIssuesReferences(first: 100, after: $closingIssuesCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            repository { nameWithOwner }
          }
        }
        reviewThreads(first: 100) {
          nodes { isResolved }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { status }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const ISSUES_SINCE_QUERY = `
  query($owner: String!, $repo: String!, $since: DateTime!) {
    repository(owner: $owner, name: $repo) {
      issues(filterBy: { since: $since }, first: 1) {
        totalCount
      }
    }
  }
`;
