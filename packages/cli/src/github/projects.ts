import type { graphql } from "@octokit/graphql";
import { PROJECT_QUERY, REPOSITORY_ID_QUERY, REPOSITORY_METADATA_QUERY, buildUserIdsQuery } from "./queries.js";

export interface RawProjectItem {
  id: string;
  fieldValues: Record<string, unknown>;
  content: {
    nodeId: string;
    number: number;
    title: string;
    body: string | null;
    state: string;
    stateReason: string | null;
    assignees: string[];
    labels: string[];
    milestone: string | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    repository: string;
  } | null;
}

export interface RawProjectData {
  projectNodeId: string;
  projectTitle: string;
  fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
  items: RawProjectItem[];
}

export async function fetchProject(
  gql: typeof graphql,
  owner: string,
  projectNumber: number,
): Promise<RawProjectData> {
  const items: RawProjectItem[] = [];
  let cursor: string | null = null;
  let projectNodeId = "";
  let projectTitle = "";
  let fields: RawProjectData["fields"] = [];

  do {
    const result: any = await gql(PROJECT_QUERY, { owner, number: projectNumber, cursor });
    const project = result.user.projectV2;
    projectNodeId = project.id;
    projectTitle = project.title;
    fields = project.fields.nodes;

    for (const item of project.items.nodes) {
      if (!item.content) continue;
      const content = item.content;
      const fieldMap: Record<string, unknown> = {};
      for (const fv of item.fieldValues.nodes) {
        if (fv.field?.name) {
          fieldMap[fv.field.name] = fv.name ?? fv.text ?? fv.date ?? fv.number ?? fv.title;
        }
      }
      items.push({
        id: item.id,
        fieldValues: fieldMap,
        content: {
          nodeId: content.id,
          number: content.number,
          title: content.title,
          body: content.body,
          state: content.state.toLowerCase(),
          stateReason: content.stateReason,
          assignees: content.assignees.nodes.map((a: any) => a.login),
          labels: content.labels.nodes.map((l: any) => l.name),
          milestone: content.milestone?.title ?? null,
          createdAt: content.createdAt,
          updatedAt: content.updatedAt,
          closedAt: content.closedAt,
          repository: content.repository.nameWithOwner,
        },
      });
    }

    cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (cursor);

  return { projectNodeId, projectTitle, fields, items };
}

export interface RawMilestone {
  id: string;
  title: string;
  number: number;
  dueOn: string | null;
  description: string | null;
  closedAt: string | null;
  state: string; // "OPEN" | "CLOSED"
}

export interface RepositoryMetadata {
  labelMap: Map<string, string>; // name → node ID
  milestoneMap: Map<string, string>; // title → node ID
  milestones: RawMilestone[];
}

export async function fetchRepositoryMetadata(
  gql: typeof graphql,
  owner: string,
  repo: string,
): Promise<RepositoryMetadata> {
  const result: any = await gql(REPOSITORY_METADATA_QUERY, { owner, repo });
  const labelMap = new Map<string, string>();
  for (const l of result.repository.labels.nodes) {
    labelMap.set(l.name, l.id);
  }
  const milestoneMap = new Map<string, string>();
  const milestones: RawMilestone[] = [];
  for (const m of result.repository.milestones.nodes) {
    milestoneMap.set(m.title, m.id);
    milestones.push({
      id: m.id,
      title: m.title,
      number: m.number,
      dueOn: m.dueOn ?? null,
      description: m.description ?? null,
      closedAt: m.closedAt ?? null,
      state: m.state ?? "OPEN",
    });
  }
  return { labelMap, milestoneMap, milestones };
}

export async function fetchUserIds(
  gql: typeof graphql,
  logins: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (logins.length === 0) return map;
  const query = buildUserIdsQuery(logins);
  const result: any = await gql(query);
  for (let i = 0; i < logins.length; i++) {
    const user = result[`u${i}`];
    if (user) map.set(user.login, user.id);
  }
  return map;
}

export async function fetchRepositoryId(
  gql: typeof graphql,
  owner: string,
  repo: string,
): Promise<string> {
  const result: any = await gql(REPOSITORY_ID_QUERY, { owner, repo });
  return result.repository.id;
}
