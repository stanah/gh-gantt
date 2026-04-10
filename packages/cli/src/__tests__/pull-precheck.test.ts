import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config, SyncState, TasksFile } from "@gh-gantt/shared";

// executePull は内部で fetchProject, checkRemoteChanges 等を呼ぶ。
// これらを mock するため vi.mock を使う。
vi.mock("../github/projects.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../github/projects.js")>();
  return {
    ...original,
    fetchProject: vi.fn(),
    fetchRepositoryMetadata: vi.fn(),
    checkRemoteChanges: vi.fn(),
  };
});

vi.mock("../github/sub-issues.js", () => ({
  fetchAllIssueRelationshipLinks: vi.fn().mockResolvedValue({
    subIssueLinks: [],
    blockedByLinks: [],
  }),
}));

import { executePull } from "../sync/pull-executor.js";
import { fetchProject, fetchRepositoryMetadata, checkRemoteChanges } from "../github/projects.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);

function makeConfig(): Config {
  return {
    project: {
      github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
    },
    sync: { auto_create_issues: false },
    task_types: {},
  } as Config;
}

function makeEmptySyncState(): SyncState {
  return {
    last_synced_at: "2026-04-01T00:00:00Z",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots: {},
  };
}

function makeEmptyTasksFile(): TasksFile {
  return { tasks: [], cache: { comments: {}, reactions: {} } };
}

const gql = vi.fn();

describe("[Issue #157] pull pre-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchRepoMeta.mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    });
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [],
    });
  });

  it("pre-check で変化なし → fetchProject が呼ばれず skipped=true", async () => {
    mockCheckRemote.mockResolvedValue(false);
    const syncState = makeEmptySyncState();

    const { result } = await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState);

    expect(mockCheckRemote).toHaveBeenCalledOnce();
    expect(mockFetchProject).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });

  it("pre-check で変化あり → fetchProject が呼ばれる", async () => {
    mockCheckRemote.mockResolvedValue(true);
    const syncState = makeEmptySyncState();

    const { result } = await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState);

    expect(mockCheckRemote).toHaveBeenCalledOnce();
    expect(mockFetchProject).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(false);
  });

  it("fullFetch=true → checkRemoteChanges が呼ばれず fetchProject が呼ばれる", async () => {
    const syncState = makeEmptySyncState();

    await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState, {
      fullFetch: true,
    });

    expect(mockCheckRemote).not.toHaveBeenCalled();
    expect(mockFetchProject).toHaveBeenCalledOnce();
  });

  it("force=true → checkRemoteChanges が呼ばれず fetchProject が呼ばれる", async () => {
    const syncState = makeEmptySyncState();

    await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState, { force: true });

    expect(mockCheckRemote).not.toHaveBeenCalled();
    expect(mockFetchProject).toHaveBeenCalledOnce();
  });

  it("last_synced_at が空 → checkRemoteChanges が呼ばれず fetchProject が呼ばれる", async () => {
    const syncState = { ...makeEmptySyncState(), last_synced_at: "" };

    await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState);

    expect(mockCheckRemote).not.toHaveBeenCalled();
    expect(mockFetchProject).toHaveBeenCalledOnce();
  });
});
