import type { graphql } from "@octokit/graphql";
import type { RelationshipSignature } from "@gh-gantt/shared";
import {
  type OwnerType,
  buildProjectQuery,
  buildProjectRelationshipSignatureQuery,
  OWNER_TYPE_QUERY,
  REPOSITORY_ID_QUERY,
  REPOSITORY_METADATA_QUERY,
  ORG_ISSUE_TYPES_QUERY,
  buildUserIdsQuery,
  ISSUES_SINCE_QUERY,
} from "./queries.js";
import { isExplicitlyUnsupportedRelationshipCapability } from "./sub-issues.js";

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
    issueType: string | null;
    repository: string;
    linkedPullRequests: Array<{
      number: number;
      title: string;
      state: string;
      /** GitHub の isDraft。Draft PR は state が open のまま isDraft が true になる */
      isDraft: boolean;
      url: string | null;
    }>;
    /**
     * 関係リンクの変更検出用シグネチャ (#377)。
     * 未対応インスタンスで取得できなかった場合は null。省略・null は「不明」として
     * 関係リンクを再取得する側に倒す
     */
    relationships?: RelationshipSignature | null;
  } | null;
}

/** ProjectV2 items の Issue content から関係シグネチャを組み立てる。フィールド不在なら null */
export function toRelationshipSignature(content: any): RelationshipSignature | null {
  if (
    !content ||
    content.subIssuesSummary?.total == null ||
    content.blockedBy?.totalCount == null ||
    content.blocking?.totalCount == null
  ) {
    return null;
  }
  const parent =
    content.parent?.number != null && content.parent?.repository?.nameWithOwner
      ? `${content.parent.repository.nameWithOwner}#${content.parent.number}`
      : null;
  return {
    parent,
    sub_issues_total: content.subIssuesSummary.total,
    blocked_by_total: content.blockedBy.totalCount,
    blocking_total: content.blocking.totalCount,
  };
}

/** ProjectV2 items を cursor で全ページ走査し、各ページの projectV2 node を callback に渡す */
async function forEachProjectPage(
  gql: typeof graphql,
  query: string,
  ownerType: OwnerType,
  owner: string,
  projectNumber: number,
  onPage: (project: any) => void,
): Promise<void> {
  let cursor: string | null = null;
  do {
    const result: any = await gql(query, { owner, number: projectNumber, cursor });
    const project = result[ownerType].projectV2;
    onPage(project);
    cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (cursor);
}

export interface ProjectRelationshipSignatureEntry {
  number: number;
  repository: string;
  relationships: RelationshipSignature;
}

/**
 * pre-check 用に project items の関係シグネチャだけを軽量取得する (#377)。
 * sub-issue 未対応のインスタンスでフィールドが存在しない場合は null を返す。
 */
export async function fetchProjectRelationshipSignatures(
  gql: typeof graphql,
  owner: string,
  projectNumber: number,
  ownerType?: OwnerType,
): Promise<ProjectRelationshipSignatureEntry[] | null> {
  const resolvedOwnerType = ownerType ?? (await detectOwnerType(gql, owner));
  const entries: ProjectRelationshipSignatureEntry[] = [];
  try {
    await forEachProjectPage(
      gql,
      buildProjectRelationshipSignatureQuery(resolvedOwnerType),
      resolvedOwnerType,
      owner,
      projectNumber,
      (project) => {
        for (const item of project.items.nodes) {
          const content = item.content;
          if (!content || (content.__typename && content.__typename !== "Issue")) continue;
          const relationships = toRelationshipSignature(content);
          if (!relationships) continue;
          entries.push({
            number: content.number,
            repository: content.repository.nameWithOwner,
            relationships,
          });
        }
      },
    );
  } catch (error) {
    if (isExplicitlyUnsupportedRelationshipCapability(error)) return null;
    throw error;
  }
  return entries;
}

export interface RawIssueType {
  id: string;
  name: string;
  description: string | null;
}

export interface RawProjectData {
  projectNodeId: string;
  projectTitle: string;
  fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
  items: RawProjectItem[];
  /**
   * 関係シグネチャを取得できたか (#377)。sub-issue / blockedBy 未対応のインスタンスで
   * フィールド不在のためシグネチャ無しで再取得した場合は false。
   * false のとき呼び出し側は updated_at のみの従来判定に戻る。省略時は true 扱い
   */
  relationshipSignatureSupported?: boolean;
}

export async function detectOwnerType(gql: typeof graphql, login: string): Promise<OwnerType> {
  const result: any = await gql(OWNER_TYPE_QUERY, { login });
  const typename = result.repositoryOwner?.__typename;
  if (typename === "Organization") return "organization";
  if (typename === "User") return "user";
  throw new Error(`Could not resolve "${login}" as a GitHub user or organization`);
}

export async function fetchProject(
  gql: typeof graphql,
  owner: string,
  projectNumber: number,
  ownerType?: OwnerType,
): Promise<RawProjectData> {
  const resolvedOwnerType = ownerType ?? (await detectOwnerType(gql, owner));

  // 関係シグネチャ同梱で取得し、sub-issue 未対応インスタンスでフィールド不在なら
  // シグネチャ無し (relationships: null) で再試行する (#377)
  try {
    return await fetchProjectPages(gql, owner, projectNumber, resolvedOwnerType, true);
  } catch (error) {
    if (!isExplicitlyUnsupportedRelationshipCapability(error)) throw error;
    return fetchProjectPages(gql, owner, projectNumber, resolvedOwnerType, false);
  }
}

async function fetchProjectPages(
  gql: typeof graphql,
  owner: string,
  projectNumber: number,
  ownerType: OwnerType,
  withRelationshipSignature: boolean,
): Promise<RawProjectData> {
  const query = buildProjectQuery(ownerType, { withRelationshipSignature });

  const items: RawProjectItem[] = [];
  let projectNodeId = "";
  let projectTitle = "";
  let fields: RawProjectData["fields"] = [];

  await forEachProjectPage(gql, query, ownerType, owner, projectNumber, (project) => {
    projectNodeId = project.id;
    projectTitle = project.title;
    fields = project.fields.nodes;

    for (const item of project.items.nodes) {
      if (!item.content) continue;
      const content = item.content;
      // Issue 以外の content（PullRequest, DraftIssue）はスキップする（gh-gantt は Issue のみを対象）。
      // このガードがないと、`state` など Issue 専用フィールド参照で後続処理がクラッシュする。
      if (content.__typename && content.__typename !== "Issue") continue;
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
          issueType: content.issueType?.name ?? null,
          repository: content.repository.nameWithOwner,
          linkedPullRequests: (content.closedByPullRequestsReferences?.nodes ?? []).map(
            (pr: any) => ({
              number: pr.number,
              title: pr.title,
              state: String(pr.state).toLowerCase(),
              isDraft: pr.isDraft === true,
              url: pr.url ?? null,
            }),
          ),
          relationships: withRelationshipSignature ? toRelationshipSignature(content) : null,
        },
      });
    }
  });

  return {
    projectNodeId,
    projectTitle,
    fields,
    items,
    relationshipSignatureSupported: withRelationshipSignature,
  };
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

export async function fetchOrgIssueTypes(
  gql: typeof graphql,
  org: string,
): Promise<RawIssueType[]> {
  try {
    const result: any = await gql(ORG_ISSUE_TYPES_QUERY, { login: org });
    const nodes = result.organization?.issueTypes?.nodes ?? [];
    return nodes
      .filter((n: any) => n.isEnabled)
      .map((n: any) => ({
        id: n.id,
        name: n.name,
        description: n.description ?? null,
      }));
  } catch (err) {
    console.warn(
      `⚠ Organization Issue Types の取得に失敗 (${org}): ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

export async function fetchRepositoryId(
  gql: typeof graphql,
  owner: string,
  repo: string,
): Promise<string> {
  const result: any = await gql(REPOSITORY_ID_QUERY, { owner, repo });
  return result.repository.id;
}

// since 以降にリモートで更新された Issue が存在するか確認する
export async function checkRemoteChanges(
  gql: typeof graphql,
  owner: string,
  repo: string,
  since: string,
): Promise<boolean> {
  const result: any = await gql(ISSUES_SINCE_QUERY, { owner, repo, since });
  const totalCount = result?.repository?.issues?.totalCount;
  if (typeof totalCount !== "number") {
    throw new Error(
      `pre-check のレスポンスが不正です (repository.issues.totalCount が取得できませんでした)`,
    );
  }
  return totalCount > 0;
}
