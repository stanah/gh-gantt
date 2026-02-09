import type { graphql } from "@octokit/graphql";
import { PROJECT_QUERY } from "./queries.js";

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
