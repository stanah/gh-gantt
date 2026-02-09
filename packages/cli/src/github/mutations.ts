import type { graphql } from "@octokit/graphql";

const UPDATE_ISSUE_MUTATION = `
  mutation($issueId: ID!, $title: String, $body: String) {
    updateIssue(input: { id: $issueId, title: $title, body: $body }) {
      issue { id }
    }
  }
`;

const CLOSE_ISSUE_MUTATION = `
  mutation($issueId: ID!) {
    closeIssue(input: { issueId: $issueId }) {
      issue { id }
    }
  }
`;

const REOPEN_ISSUE_MUTATION = `
  mutation($issueId: ID!) {
    reopenIssue(input: { issueId: $issueId }) {
      issue { id }
    }
  }
`;

const UPDATE_PROJECT_ITEM_FIELD = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }
    ) {
      projectV2Item { id }
    }
  }
`;

export async function updateIssue(
  gql: typeof graphql,
  issueNodeId: string,
  fields: { title?: string; body?: string },
): Promise<void> {
  await gql(UPDATE_ISSUE_MUTATION, {
    issueId: issueNodeId,
    ...fields,
  });
}

export async function setIssueState(
  gql: typeof graphql,
  issueNodeId: string,
  state: "open" | "closed",
): Promise<void> {
  if (state === "closed") {
    await gql(CLOSE_ISSUE_MUTATION, { issueId: issueNodeId });
  } else {
    await gql(REOPEN_ISSUE_MUTATION, { issueId: issueNodeId });
  }
}

export async function updateProjectItemField(
  gql: typeof graphql,
  projectId: string,
  itemId: string,
  fieldId: string,
  value: Record<string, unknown>,
): Promise<void> {
  await gql(UPDATE_PROJECT_ITEM_FIELD, {
    projectId,
    itemId,
    fieldId,
    value,
  });
}
