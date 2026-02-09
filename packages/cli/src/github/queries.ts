export const PROJECT_QUERY = `
  query($owner: String!, $number: Int!, $cursor: String) {
    user(login: $owner) {
      projectV2(number: $number) {
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
              ... on Issue {
                id
                number
                title
                body
                state
                stateReason
                assignees(first: 10) { nodes { login } }
                labels(first: 20) { nodes { name } }
                milestone { title }
                createdAt
                updatedAt
                closedAt
                repository { nameWithOwner }
              }
            }
          }
        }
      }
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
        nodes { id title number }
      }
    }
  }
`;

export function buildUserIdsQuery(logins: string[]): string {
  const fields = logins.map((login, i) => `u${i}: user(login: "${login}") { id login }`).join("\n    ");
  return `query { ${fields} }`;
}

export const SUB_ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        subIssues(first: 50) {
          nodes {
            number
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`;
