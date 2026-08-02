import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, SyncState, Task, TasksFile } from "@gh-gantt/shared";
import { createTaskCloseCommand } from "../commands/task/close.js";
import { createTaskLinkCommand } from "../commands/task/link.js";
import { createTaskUpdateCommand } from "../commands/task/update.js";
import { executeWriteThroughPush } from "../commands/task/write-through-push.js";
import { withProjectStorage } from "../store/project-storage.js";
import { computeLocalDiff } from "../sync/diff.js";
import { extractSyncFields, hashTask } from "../sync/hash.js";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
}));

vi.mock("../github/client.js", () => ({
  createGraphQLClient: createClientMock,
}));

function makeConfig(autoPush = true): Config {
  return {
    version: "1",
    project: {
      name: "テスト",
      github: { owner: "owner", repo: "repo", project_number: 1 },
    },
    sync: {
      auto_create_issues: false,
      auto_push: autoPush,
      field_mapping: { start_date: "Start", end_date: "End" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000000", github_label: null },
      feature: { label: "Feature", display: "bar", color: "#111111", github_label: null },
    },
    type_hierarchy: { task: [], feature: [] },
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: {
        critical_path: "#ff0000",
        on_track: "#00ff00",
        at_risk: "#ffff00",
        overdue: "#ff0000",
      },
    },
  };
}

function makeTask(issueNumber: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `owner/repo#${issueNumber}`,
    type: "task",
    github_issue: issueNumber,
    github_repo: "owner/repo",
    parent: null,
    sub_tasks: [],
    title: `タスク${issueNumber}`,
    body: null,
    acceptance_criteria: [],
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeGraphQLClient(
  options: {
    failIssueId?: string;
    failAddSubIssue?: boolean;
    updatedAtAfterMutation?: string;
    initialUpdatedAtByIssueId?: Record<string, string>;
  } = {},
) {
  const mutatedIssueIds = new Set<string>();
  return vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes("issue(number:") && !query.includes("mutation")) {
      const issueNumbers = [...query.matchAll(/issue\(number:\s*(\d+)\)/g)].map((match) =>
        Number(match[1]),
      );
      return {
        repository: Object.fromEntries(
          issueNumbers.map((number, index) => [
            `i${index}`,
            {
              number,
              updatedAt:
                mutatedIssueIds.has(`ISSUE_${number}`) && options.updatedAtAfterMutation
                  ? options.updatedAtAfterMutation
                  : (options.initialUpdatedAtByIssueId?.[`ISSUE_${number}`] ??
                    "2026-01-01T00:00:00Z"),
              stateReason: null,
              closedAt: null,
            },
          ]),
        ),
      };
    }
    if (query.includes("updateIssue") && variables?.issueId === options.failIssueId) {
      throw new Error("外部 API エラー");
    }
    if (query.includes("updateIssue")) {
      if (typeof variables?.issueId === "string") mutatedIssueIds.add(variables.issueId);
      return { updateIssue: { issue: { id: variables?.issueId } } };
    }
    if (query.includes("closeIssue")) {
      return { closeIssue: { issue: { id: variables?.issueId } } };
    }
    if (query.includes("reopenIssue")) {
      return { reopenIssue: { issue: { id: variables?.issueId } } };
    }
    if (query.includes("addSubIssue")) {
      if (options.failAddSubIssue) {
        throw new Error("sub-issue API エラー");
      }
      return { addSubIssue: { issue: { id: variables?.issueId } } };
    }
    if (query.includes("addBlockedBy")) {
      return { addIssueRelation: { issue: { id: variables?.issueId } } };
    }
    return {};
  });
}

async function initializeProject(
  root: string,
  tasks: Task[],
  snapshotTasks: Task[] = tasks,
  config = makeConfig(),
  tasksFileOverrides: Partial<TasksFile> = {},
): Promise<void> {
  const snapshots = Object.fromEntries(
    snapshotTasks.map((task) => [
      task.id,
      {
        hash: hashTask(task),
        synced_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        syncFields: extractSyncFields(task),
      },
    ]),
  );
  const syncState: SyncState = {
    last_synced_at: "2026-01-01T00:00:00Z",
    project_node_id: "PROJECT_1",
    id_map: Object.fromEntries(
      tasks
        .filter((task) => task.github_issue !== null)
        .map((task) => [
          task.id,
          {
            issue_number: task.github_issue!,
            issue_node_id: `ISSUE_${task.github_issue}`,
            project_item_id: `ITEM_${task.github_issue}`,
          },
        ]),
    ),
    field_ids: {},
    snapshots,
  };

  await withProjectStorage(root, { mode: "write", scope: "all" }, async (storage) => {
    await storage.configStore.write(config);
    await storage.tasksStore.write({
      tasks,
      cache: { comments: {}, reactions: {} },
      ...tasksFileOverrides,
    });
    await storage.stateStore.write(syncState);
    await storage.flush();
  });
}

async function readProject(root: string) {
  return withProjectStorage(root, { mode: "read", scope: "shared-cache" }, async (storage) => ({
    tasksFile: await storage.tasksStore.read(),
    syncState: await storage.stateStore.read(),
  }));
}

async function updateProjectSyncState(
  root: string,
  update: (syncState: SyncState) => void,
): Promise<void> {
  await withProjectStorage(root, { mode: "write", scope: "shared-cache" }, async (storage) => {
    const syncState = await storage.stateStore.read();
    update(syncState);
    await storage.stateStore.write(syncState);
    await storage.flush();
  });
}

describe("[FR-SYNC-003-AC7] 変更系コマンドを write-through push できる", () => {
  let projectRoot: string;
  let originalCwd: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    projectRoot = await mkdtemp(join(tmpdir(), "gh-gantt-write-through-"));
    process.chdir(projectRoot);
    createClientMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("update は変更した task だけを同期し、無関係な dirty task を保持する", async () => {
    const baseTask1 = makeTask(1);
    const baseTask2 = makeTask(2);
    const dirtyTask2 = {
      ...baseTask2,
      title: "未送信の変更",
      title_current: "ローカル",
      title_incoming: "リモート",
    } as Task;
    await initializeProject(
      projectRoot,
      [baseTask1, dirtyTask2],
      [baseTask1, baseTask2],
      makeConfig(),
      { has_conflicts: true },
    );
    const gql = makeGraphQLClient();
    createClientMock.mockResolvedValue(gql);

    await createTaskUpdateCommand().parseAsync(["1", "--title", "write-through 後"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    const issueIds = gql.mock.calls
      .filter(([query]) => (query as string).includes("updateIssue"))
      .map(([, variables]) => variables?.issueId);
    expect(issueIds).toEqual(["ISSUE_1"]);
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#2",
    ]);
    expect(syncState.last_synced_at).toBe("2026-01-01T00:00:00Z");
  });

  it("executeWriteThroughPush は永続化した最終 TasksFile を返す", async () => {
    const baseTask = makeTask(1);
    const dirtyTask = { ...baseTask, title: "変更後" };
    await initializeProject(projectRoot, [dirtyTask], [baseTask]);
    const gql = makeGraphQLClient({
      updatedAtAfterMutation: "2026-01-02T00:00:00Z",
    });

    const writeThroughResult = await withProjectStorage(
      projectRoot,
      { mode: "write", scope: "shared-cache" },
      async (storage) => {
        const config = await storage.configStore.read();
        const tasksFile = await storage.tasksStore.read();
        return executeWriteThroughPush(storage, config, tasksFile, ["owner/repo#1"], {
          createClient: async () => gql as never,
        });
      },
    );

    expect(writeThroughResult.tasksFile.tasks[0]).toMatchObject({
      id: "owner/repo#1",
      title: "変更後",
      updated_at: "2026-01-02T00:00:00Z",
    });
    const persisted = await readProject(projectRoot);
    expect(writeThroughResult.tasksFile).toEqual(persisted.tasksFile);
  });

  it("update --json は write-through 後の updated_at を出力する", async () => {
    const task = makeTask(1);
    await initializeProject(projectRoot, [task]);
    createClientMock.mockResolvedValue(
      makeGraphQLClient({
        updatedAtAfterMutation: "2026-01-02T00:00:00Z",
      }),
    );

    await createTaskUpdateCommand().parseAsync(["1", "--title", "JSON更新", "--json"], {
      from: "user",
    });

    const jsonOutput = vi
      .mocked(console.log)
      .mock.calls.map(([value]) => value)
      .find((value): value is string => typeof value === "string" && value.includes('"id"'));
    expect(jsonOutput).toBeDefined();
    expect(JSON.parse(jsonOutput!)).toMatchObject({
      id: "owner/repo#1",
      title: "JSON更新",
      updated_at: "2026-01-02T00:00:00Z",
    });
  });

  it("bulk update は実際に成功した task だけを同期する", async () => {
    const task1 = makeTask(1, { labels: ["対象"] });
    const task2 = makeTask(2, { type: "feature", labels: ["対象"] });
    const config = {
      ...makeConfig(),
      require_review_for_types: ["feature"],
    };
    await initializeProject(projectRoot, [task1, task2], [task1, task2], config);
    const gql = makeGraphQLClient();
    createClientMock.mockResolvedValue(gql);

    await createTaskUpdateCommand().parseAsync(["--filter-label", "対象", "--state", "closed"], {
      from: "user",
    });

    const { tasksFile } = await readProject(projectRoot);
    const issueIds = gql.mock.calls
      .filter(([query]) => (query as string).includes("updateIssue"))
      .map(([, variables]) => variables?.issueId);
    expect(issueIds).toEqual(["ISSUE_1"]);
    expect(tasksFile.tasks.find((task) => task.id === "owner/repo#1")?.state).toBe("closed");
    expect(tasksFile.tasks.find((task) => task.id === "owner/repo#2")?.state).toBe("open");
  });

  it("close はローカル flush 後に閉じた task を同期する", async () => {
    const task = makeTask(1);
    await initializeProject(projectRoot, [task]);
    const gql = makeGraphQLClient();
    createClientMock.mockResolvedValue(gql);

    await createTaskCloseCommand().parseAsync(["1"], { from: "user" });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(gql.mock.calls.some(([query]) => (query as string).includes("closeIssue"))).toBe(true);
    expect(tasksFile.tasks[0].state).toBe("closed");
    expect(computeLocalDiff(tasksFile.tasks, syncState)).toEqual([]);
  });

  it("link は source と親子 mirror の実変更 task だけを同期する", async () => {
    const child = makeTask(1);
    const parent = makeTask(2);
    const unrelated = makeTask(3);
    await initializeProject(projectRoot, [child, parent, unrelated]);
    const gql = makeGraphQLClient();
    createClientMock.mockResolvedValue(gql);

    await createTaskLinkCommand().parseAsync(["1", "--set-parent", "2"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    const issueIds = gql.mock.calls
      .filter(([query]) => (query as string).includes("updateIssue"))
      .map(([, variables]) => variables?.issueId)
      .sort();
    expect(issueIds).toEqual(["ISSUE_1", "ISSUE_2"]);
    expect(computeLocalDiff(tasksFile.tasks, syncState)).toEqual([]);
  });

  it("--no-push はローカル変更だけを flush し client を生成しない", async () => {
    const task = makeTask(1);
    await initializeProject(projectRoot, [task]);

    await createTaskUpdateCommand().parseAsync(["1", "--title", "ローカルのみ", "--no-push"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(tasksFile.tasks[0].title).toBe("ローカルのみ");
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#1",
    ]);
  });

  it("auto_push: false はローカル変更だけを flush し client を生成しない", async () => {
    const task = makeTask(1);
    await initializeProject(projectRoot, [task], [task], makeConfig(false));

    await createTaskCloseCommand().parseAsync(["1"], { from: "user" });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(tasksFile.tasks[0].state).toBe("closed");
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#1",
    ]);
  });

  it("未解決 marker がある対象だけを skip しローカル差分を保持する", async () => {
    const task = makeTask(1) as Task & Record<string, unknown>;
    task.title_current = "ローカル";
    task.title_incoming = "リモート";
    await initializeProject(projectRoot, [task], [makeTask(1)], makeConfig(), {
      has_conflicts: true,
    });

    await createTaskUpdateCommand().parseAsync(["1", "--title", "競合中の変更"], { from: "user" });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(tasksFile.tasks[0].title).toBe("競合中の変更");
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#1",
    ]);
  });

  it("複数 target の一部が skipped なら成功済み snapshot を保ち残存 ID をエラー通知する", async () => {
    const task1 = makeTask(1, { labels: ["対象"] });
    const task2 = makeTask(2, { labels: ["対象"] });
    await initializeProject(projectRoot, [task1, task2]);
    await updateProjectSyncState(projectRoot, (syncState) => {
      delete syncState.id_map["owner/repo#2"];
    });
    const gql = makeGraphQLClient();
    createClientMock.mockResolvedValue(gql);

    await createTaskUpdateCommand().parseAsync(["--filter-label", "対象", "--title", "一括変更"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to update task:",
      expect.stringContaining("owner/repo#2"),
    );
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#2",
    ]);
    expect(syncState.snapshots["owner/repo#1"]?.syncFields?.title).toBe("一括変更");
    expect(syncState.snapshots["owner/repo#2"]?.syncFields?.title).toBe("タスク2");
  });

  it("既存 task の後続 API 失敗時は先行成功の task と snapshot を永続化する", async () => {
    const task1 = makeTask(1, { labels: ["対象"] });
    const task2 = makeTask(2, { labels: ["対象"] });
    await initializeProject(projectRoot, [task1, task2]);
    const gql = makeGraphQLClient({
      failIssueId: "ISSUE_2",
      updatedAtAfterMutation: "2026-01-02T00:00:00Z",
    });
    createClientMock.mockResolvedValue(gql);

    await createTaskUpdateCommand().parseAsync(["--filter-label", "対象", "--title", "一括変更"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(process.exitCode).toBe(1);
    expect(
      gql.mock.calls
        .filter(([query]) => (query as string).includes("updateIssue"))
        .map(([, variables]) => variables?.issueId),
    ).toEqual(["ISSUE_1", "ISSUE_2"]);
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#2",
    ]);
    expect(syncState.snapshots["owner/repo#1"]?.syncFields?.title).toBe("一括変更");
    expect(syncState.snapshots["owner/repo#1"]?.updated_at).toBe("2026-01-02T00:00:00Z");
    expect(syncState.snapshots["owner/repo#2"]?.syncFields?.title).toBe("タスク2");
  });

  it("draft target は client 生成前に拒否しローカル差分を保持する", async () => {
    const baseDraft = makeTask(1, {
      id: "owner/repo#draft-1",
      github_issue: null,
      title: "変更前 draft",
    });
    const dirtyDraft = { ...baseDraft, title: "変更後 draft" };
    await initializeProject(projectRoot, [dirtyDraft], [baseDraft]);

    await createTaskUpdateCommand().parseAsync(["draft-1", "--title", "コマンド更新 draft"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(process.exitCode).toBe(1);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Failed to update task:",
      expect.stringContaining("既存 Issue"),
    );
    expect(tasksFile.tasks[0]).toMatchObject({
      id: "owner/repo#draft-1",
      title: "コマンド更新 draft",
    });
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#draft-1",
    ]);
  });

  it("link group の child に marker があれば旧親と新親を含む全 target を送信しない", async () => {
    const baseChild = makeTask(1, { parent: "owner/repo#2" });
    const oldParent = makeTask(2, { sub_tasks: ["owner/repo#1"] });
    const newParent = makeTask(3);
    const conflictedChild = {
      ...baseChild,
      title_current: "ローカル",
      title_incoming: "リモート",
    } as Task;
    await initializeProject(
      projectRoot,
      [conflictedChild, oldParent, newParent],
      [baseChild, oldParent, newParent],
      makeConfig(),
      { has_conflicts: true },
    );

    await createTaskLinkCommand().parseAsync(["1", "--set-parent", "3"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(
      computeLocalDiff(tasksFile.tasks, syncState)
        .map((diff) => diff.id)
        .sort(),
    ).toEqual(["owner/repo#1", "owner/repo#2", "owner/repo#3"]);
    expect(syncState.snapshots["owner/repo#1"]?.syncFields?.parent).toBe("owner/repo#2");
    expect(syncState.snapshots["owner/repo#2"]?.syncFields?.sub_tasks).toEqual(["owner/repo#1"]);
    expect(syncState.snapshots["owner/repo#3"]?.syncFields?.sub_tasks).toEqual([]);
  });

  it("link relation API 失敗時は group snapshot を前進させず新しい updated_at で再送できる", async () => {
    const child = makeTask(1);
    const parent = makeTask(2);
    await initializeProject(projectRoot, [child, parent]);
    const gql = makeGraphQLClient({
      failAddSubIssue: true,
      updatedAtAfterMutation: "2026-01-02T00:00:00Z",
    });
    createClientMock.mockResolvedValue(gql);

    await createTaskLinkCommand().parseAsync(["1", "--set-parent", "2"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to link task:",
      expect.stringContaining("owner/repo#1"),
    );
    expect(
      computeLocalDiff(tasksFile.tasks, syncState)
        .map((diff) => diff.id)
        .sort(),
    ).toEqual(["owner/repo#1", "owner/repo#2"]);
    expect(syncState.snapshots["owner/repo#1"]?.syncFields?.parent).toBeNull();
    expect(syncState.snapshots["owner/repo#2"]?.syncFields?.sub_tasks).toEqual([]);
    expect(syncState.snapshots["owner/repo#1"]?.updated_at).toBe("2026-01-02T00:00:00Z");
    expect(syncState.snapshots["owner/repo#2"]?.updated_at).toBe("2026-01-01T00:00:00Z");
  });

  it("link group の後続 Issue 更新失敗時は先行成功の watermark を保って全差分を再送できる", async () => {
    const child = makeTask(1);
    const parent = makeTask(2);
    await initializeProject(projectRoot, [child, parent]);
    const gql = makeGraphQLClient({
      failIssueId: "ISSUE_2",
      updatedAtAfterMutation: "2026-01-02T00:00:00Z",
    });
    createClientMock.mockResolvedValue(gql);

    await createTaskLinkCommand().parseAsync(["1", "--set-parent", "2"], {
      from: "user",
    });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(process.exitCode).toBe(1);
    expect(
      gql.mock.calls
        .filter(([query]) => (query as string).includes("updateIssue"))
        .map(([, variables]) => variables?.issueId),
    ).toEqual(["ISSUE_1", "ISSUE_2"]);
    expect(
      computeLocalDiff(tasksFile.tasks, syncState)
        .map((diff) => diff.id)
        .sort(),
    ).toEqual(["owner/repo#1", "owner/repo#2"]);
    expect(syncState.snapshots["owner/repo#1"]?.syncFields?.parent).toBeNull();
    expect(syncState.snapshots["owner/repo#2"]?.syncFields?.sub_tasks).toEqual([]);
    expect(syncState.snapshots["owner/repo#1"]?.updated_at).toBe("2026-01-02T00:00:00Z");
    expect(syncState.snapshots["owner/repo#2"]?.updated_at).toBe("2026-01-01T00:00:00Z");

    process.exitCode = undefined;
    const retryGql = makeGraphQLClient({
      initialUpdatedAtByIssueId: {
        ISSUE_1: "2026-01-02T00:00:00Z",
        ISSUE_2: "2026-01-01T00:00:00Z",
      },
      updatedAtAfterMutation: "2026-01-03T00:00:00Z",
    });
    await withProjectStorage(
      projectRoot,
      { mode: "write", scope: "shared-cache" },
      async (storage) => {
        const config = await storage.configStore.read();
        const currentTasksFile = await storage.tasksStore.read();
        await executeWriteThroughPush(
          storage,
          config,
          currentTasksFile,
          ["owner/repo#1", "owner/repo#2"],
          {
            createClient: async () => retryGql as never,
            atomicTargetGroups: [["owner/repo#1", "owner/repo#2"]],
          },
        );
      },
    );

    const retried = await readProject(projectRoot);
    expect(process.exitCode).toBeUndefined();
    expect(computeLocalDiff(retried.tasksFile.tasks, retried.syncState)).toEqual([]);
  });

  it("API 失敗時は exit code を失敗にし、ローカル差分を再送可能なまま保持する", async () => {
    const task = makeTask(1);
    await initializeProject(projectRoot, [task]);
    createClientMock.mockResolvedValue(makeGraphQLClient({ failIssueId: "ISSUE_1" }));

    await createTaskUpdateCommand().parseAsync(["1", "--title", "再送する変更"], { from: "user" });

    const { tasksFile, syncState } = await readProject(projectRoot);
    expect(process.exitCode).toBe(1);
    expect(tasksFile.tasks[0].title).toBe("再送する変更");
    expect(computeLocalDiff(tasksFile.tasks, syncState).map((diff) => diff.id)).toEqual([
      "owner/repo#1",
    ]);
  });
});
