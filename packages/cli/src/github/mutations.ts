import type { graphql } from "@octokit/graphql";

const CREATE_ISSUE_MUTATION = `
  mutation($repositoryId: ID!, $title: String!, $body: String, $labelIds: [ID!], $milestoneId: ID, $assigneeIds: [ID!]) {
    createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, labelIds: $labelIds, milestoneId: $milestoneId, assigneeIds: $assigneeIds }) {
      issue {
        id
        number
      }
    }
  }
`;

const ADD_PROJECT_V2_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item {
        id
      }
    }
  }
`;

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

export interface CreateIssueOptions {
  title: string;
  body?: string;
  labelIds?: string[];
  milestoneId?: string;
  assigneeIds?: string[];
}

export async function createIssue(
  gql: typeof graphql,
  repositoryId: string,
  options: CreateIssueOptions,
): Promise<{ issueId: string; issueNumber: number }> {
  const result: any = await gql(CREATE_ISSUE_MUTATION, {
    repositoryId,
    title: options.title,
    body: options.body ?? undefined,
    labelIds: options.labelIds?.length ? options.labelIds : undefined,
    milestoneId: options.milestoneId ?? undefined,
    assigneeIds: options.assigneeIds?.length ? options.assigneeIds : undefined,
  });
  return {
    issueId: result.createIssue.issue.id,
    issueNumber: result.createIssue.issue.number,
  };
}

export async function addProjectItem(
  gql: typeof graphql,
  projectId: string,
  contentId: string,
): Promise<string> {
  const result: any = await gql(ADD_PROJECT_V2_ITEM_MUTATION, {
    projectId,
    contentId,
  });
  return result.addProjectV2ItemById.item.id;
}

const ADD_SUB_ISSUE_MUTATION = `
  mutation($issueId: ID!, $subIssueId: ID!) {
    addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
      issue { id }
      subIssue { id }
    }
  }
`;

export async function addSubIssue(
  gql: typeof graphql,
  parentIssueNodeId: string,
  childIssueNodeId: string,
): Promise<void> {
  await gql(ADD_SUB_ISSUE_MUTATION, {
    issueId: parentIssueNodeId,
    subIssueId: childIssueNodeId,
  });
}

const REMOVE_SUB_ISSUE_MUTATION = `
  mutation($issueId: ID!, $subIssueId: ID!) {
    removeSubIssue(input: { parentIssueId: $issueId, subIssueId: $subIssueId }) {
      issue { id }
      subIssue { id }
    }
  }
`;

export async function removeSubIssue(
  gql: typeof graphql,
  parentIssueNodeId: string,
  childIssueNodeId: string,
): Promise<void> {
  await gql(REMOVE_SUB_ISSUE_MUTATION, {
    issueId: parentIssueNodeId,
    subIssueId: childIssueNodeId,
  });
}

const ADD_BLOCKED_BY_MUTATION = `
  mutation($issueId: ID!, $blockingIssueId: ID!) {
    addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
      blockedIssue { id }
      blockingIssue { id }
    }
  }
`;

export async function addBlockedByIssue(
  gql: typeof graphql,
  issueNodeId: string,
  blockingIssueNodeId: string,
): Promise<void> {
  await gql(ADD_BLOCKED_BY_MUTATION, {
    issueId: issueNodeId,
    blockingIssueId: blockingIssueNodeId,
  });
}

const REMOVE_BLOCKED_BY_MUTATION = `
  mutation($blockedIssueId: ID!, $blockingIssueId: ID!) {
    removeBlockedBy(input: { blockedIssueId: $blockedIssueId, blockingIssueId: $blockingIssueId }) {
      blockedIssue { id }
      blockingIssue { id }
    }
  }
`;

export async function removeBlockedByIssue(
  gql: typeof graphql,
  blockedIssueNodeId: string,
  blockingIssueNodeId: string,
): Promise<void> {
  await gql(REMOVE_BLOCKED_BY_MUTATION, {
    blockedIssueId: blockedIssueNodeId,
    blockingIssueId: blockingIssueNodeId,
  });
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

export async function createGithubMilestone(
  token: string,
  owner: string,
  repo: string,
  options: { title: string; description?: string; dueOn?: string },
): Promise<{ number: number; nodeId: string }> {
  const body: Record<string, string> = { title: options.title };
  if (options.description) body.description = options.description;
  if (options.dueOn) body.due_on = `${options.dueOn}T00:00:00Z`;

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/milestones`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create milestone: ${response.status} ${text}`);
  }

  const data: any = await response.json();
  return { number: data.number, nodeId: data.node_id };
}
