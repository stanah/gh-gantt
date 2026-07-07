export type OwnerType = "user" | "organization";

const PROJECT_V2_FRAGMENT = `
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
                repository { nameWithOwner }
              }
            }
          }
        }`;

export function buildProjectQuery(ownerType: OwnerType): string {
  return `
  query($owner: String!, $number: Int!, $cursor: String) {
    ${ownerType}(login: $owner) {
      projectV2(number: $number) {
${PROJECT_V2_FRAGMENT}
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
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        subIssues(first: 50) {
          nodes {
            number
            repository { nameWithOwner }
          }
        }
        blockedBy(first: 50) {
          nodes {
            number
            repository { nameWithOwner }
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
 * は拒否時の診断表示と prEvidence 記録のための参考情報。reviewThreads と contexts の
 * ページングは first: 100 で打ち切る（診断用途のため許容。ADR-019 参照）。
 */
export const PULL_REQUEST_GATE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        state
        reviewDecision
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
