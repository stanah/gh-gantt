/**
 * Issue #299 の ProjectStorage Interface に対する最初の RED tracer。
 *
 * 公開 seam は `withProjectStorage(root, access, callback)` とし、caller は
 * git-common-dir、legacy migration、generation、lease の実装詳細を扱わない。
 * process identity / liveness だけは、別 process の競合を決定論的に再現するため
 * `createProjectStorageDependencies` から注入する。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageCommand } from "../../commands/storage.js";
import { pullCommand } from "../../commands/pull.js";
import {
  createProjectStorageDependencies,
  withProjectStorage,
} from "../../store/project-storage.js";

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

const TASKS_V1 = `${JSON.stringify(
  { tasks: [], cache: { comments: {}, reactions: {} } },
  null,
  2,
)}\n`;

const TASKS_V2 = `${JSON.stringify(
  {
    tasks: [],
    cache: {
      comments: {
        marker: [{ author: "tester", body: "v2", created_at: "2026-01-01" }],
      },
      reactions: {},
    },
  },
  null,
  2,
)}\n`;

const SYNC_STATE_V1 = `${JSON.stringify(
  {
    last_synced_at: "2026-07-30T00:00:00.000Z",
    project_node_id: "PVT_test",
    id_map: {},
    field_ids: {},
    snapshots: {},
  },
  null,
  2,
)}\n`;

const SYNC_STATE_V2 = `${JSON.stringify(
  {
    last_synced_at: "2026-07-30T01:00:00.000Z",
    project_node_id: "PVT_test",
    id_map: {},
    field_ids: {},
    snapshots: {},
  },
  null,
  2,
)}\n`;

const COMMENTS_V1 = `${JSON.stringify({ version: "1", fetched_at: {}, comments: {} }, null, 2)}\n`;

const CONFIG_V1 = `${JSON.stringify(
  {
    version: "1",
    project: {
      name: "Issue 299 fixture",
      github: { owner: "fixture", repo: "repository", project_number: 1 },
    },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000000", github_label: null },
    },
    type_hierarchy: { task: [] },
    statuses: { field_name: "Status", values: { Done: { color: "#00ff00", done: true } } },
    gantt: {
      default_view: "month",
      working_days: [1, 2, 3, 4, 5],
      colors: {
        critical_path: "#ff0000",
        on_track: "#00ff00",
        at_risk: "#ffff00",
        overdue: "#ff0000",
      },
    },
  },
  null,
  2,
)}\n`;

const CONFIG_OTHER_PROJECT = `${JSON.stringify(
  {
    ...JSON.parse(CONFIG_V1),
    project: {
      name: "Issue 299 other fixture",
      github: { owner: "fixture", repo: "other-repository", project_number: 2 },
    },
  },
  null,
  2,
)}\n`;

type SharedStorageSlot = "tasks" | "sync-state" | "comments";

function gitCommandEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function runGit(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    env: gitCommandEnvironment(),
  });
  return result.stdout.trim();
}

async function makeRepositoryWithLinkedWorktree(): Promise<{
  repository: string;
  linked: string;
  commonDir: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "gh-gantt-issue-299-git-"));
  createdRoots.push(parent);
  const repository = join(parent, "repository");
  const linked = join(parent, "linked");
  await mkdir(repository);
  await execFileAsync("git", ["init", "--initial-branch=main", repository], {
    env: gitCommandEnvironment(),
  });
  await runGit(repository, "config", "user.email", "issue-299@example.invalid");
  await runGit(repository, "config", "user.name", "Issue 299 Test");
  await mkdir(join(repository, ".gantt-sync"), { recursive: true });
  await writeFile(join(repository, ".gantt-sync", "gantt.config.json"), CONFIG_V1);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await runGit(repository, "add", "README.md", ".gantt-sync/gantt.config.json");
  await runGit(repository, "commit", "-m", "test: fixture");
  await runGit(repository, "worktree", "add", "-b", "fixture-linked", linked);

  const rawCommonDir = await runGit(linked, "rev-parse", "--git-common-dir");
  const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(linked, rawCommonDir);
  return { repository, linked, commonDir };
}

async function makeStandaloneRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gh-gantt-issue-299-standalone-"));
  createdRoots.push(root);
  return root;
}

async function writeLegacy(
  root: string,
  files: Partial<Record<"tasks.json" | "sync-state.json" | "comments.json", string>>,
): Promise<void> {
  const directory = join(root, ".gantt-sync");
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(join(directory, name), content)),
  );
}

async function readSlot(root: string, slot: SharedStorageSlot): Promise<string> {
  return withProjectStorage(root, { mode: "read" }, async (storage) => {
    const value =
      slot === "tasks"
        ? await storage.tasksStore.read()
        : slot === "sync-state"
          ? await storage.stateStore.read()
          : await storage.commentsStore.read();
    return `${JSON.stringify(value, null, 2)}\n`;
  });
}

async function publishSharedCache(
  root: string,
  tasks = TASKS_V1,
  syncState = SYNC_STATE_V1,
  comments = COMMENTS_V1,
): Promise<void> {
  await withProjectStorage(root, { mode: "write", scope: "shared-cache" }, async (storage) => {
    await storage.tasksStore.write(JSON.parse(tasks));
    await storage.stateStore.write(JSON.parse(syncState));
    await storage.commentsStore.write(JSON.parse(comments));
  });
}

function projectNamespace(commonDir: string, identity: string): string {
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
  return join(commonDir, "gh-gantt", "cache", "project-storage", "v1", key);
}

function processDependencies(
  pid: number,
  livePids: Set<number>,
): ReturnType<typeof createProjectStorageDependencies> {
  return createProjectStorageDependencies({
    processIdentity: { pid, hostname: "issue-299-test-host" },
    isProcessAlive: async (candidate) => livePids.has(candidate),
  });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 25));
}

async function waitForFile(
  path: string,
  child?: ChildProcess,
  childError: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      if (child?.exitCode !== null) {
        throw new Error(
          `子processがbarrier作成前に終了しました: exit=${child?.exitCode} ${childError()}`,
        );
      }
      await nextTurn();
    }
  }
  throw new Error(`barrier fileを待機できませんでした: ${path}`);
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("[NFR-STABILITY-015] [Issue #299] worktree 間共有 cache と workspace-local state の配置を保証する", () => {
  it("[FR-STORE-004-AC1] [NFR-STABILITY-015-AC4] real linked worktree はtasks・sync-state・commentsを共有し、設定・journal・Run Graphを共有しない", async () => {
    const { repository, linked, commonDir } = await makeRepositoryWithLinkedWorktree();
    await publishSharedCache(repository);
    await expect(
      access(join(commonDir, "gh-gantt", "cache", "project-storage", "v1")),
    ).resolves.toBe(undefined);
    await expect(readSlot(linked, "tasks")).resolves.toBe(TASKS_V1);
    await expect(readSlot(linked, "sync-state")).resolves.toBe(SYNC_STATE_V1);
    await expect(readSlot(linked, "comments")).resolves.toBe(COMMENTS_V1);
    await expect(access(join(repository, ".gantt-sync", "tasks.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(linked, ".gantt-sync", "tasks.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(join(repository, ".gantt-sync", "gantt.config.json")).not.toBe(
      join(linked, ".gantt-sync", "gantt.config.json"),
    );
    expect(join(repository, ".gantt-sync", "loop-state.json")).not.toBe(
      join(linked, ".gantt-sync", "loop-state.json"),
    );
    expect(join(repository, ".gantt-sync", "run-graph.jsonl")).not.toBe(
      join(linked, ".gantt-sync", "run-graph.jsonl"),
    );
  });

  it("[FR-STORE-004-AC4] non-git workspace はrepository scopeも従来の.gantt-sync配下へ縮退する", async () => {
    const root = await makeStandaloneRoot();
    await publishSharedCache(root);

    await expect(readFile(join(root, ".gantt-sync", "tasks.json"), "utf8")).resolves.toBe(TASKS_V1);
    await expect(readFile(join(root, ".gantt-sync", "sync-state.json"), "utf8")).resolves.toBe(
      SYNC_STATE_V1,
    );
    await expect(readFile(join(root, ".gantt-sync", "comments.json"), "utf8")).resolves.toBe(
      COMMENTS_V1,
    );
  });

  it("[FR-STORE-004-AC5] 別worktreeのlegacy cacheが共有世代と異なる場合は後勝ちで上書きしない", async () => {
    const { repository, linked } = await makeRepositoryWithLinkedWorktree();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE_V1 });
    await writeLegacy(linked, { "tasks.json": TASKS_V2, "sync-state.json": SYNC_STATE_V2 });

    await expect(readSlot(repository, "tasks")).rejects.toMatchObject({
      code: "LEGACY_CACHE_DIVERGED",
    });
    await expect(readSlot(linked, "tasks")).rejects.toMatchObject({
      code: "LEGACY_CACHE_DIVERGED",
    });
  });

  it("[NFR-STABILITY-015-AC1] generation公開前にcallbackが失敗した場合は旧CURRENT世代を維持する", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    await publishSharedCache(repository);

    await expect(
      withProjectStorage(repository, { mode: "write", scope: "shared-cache" }, async (storage) => {
        await storage.tasksStore.write(JSON.parse(TASKS_V2));
        await storage.stateStore.write(JSON.parse(SYNC_STATE_V2));
        throw new Error("CURRENT 交換前の模擬失敗");
      }),
    ).rejects.toThrow("CURRENT 交換前の模擬失敗");

    await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V1);
    await expect(readSlot(repository, "sync-state")).resolves.toBe(SYNC_STATE_V1);
  });

  it("[NFR-STABILITY-015-AC2] [NFR-STABILITY-015-AC5] 別process identityのwriter sessionは先行leaseが解放されるまでcallbackへ入らない", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    const livePids = new Set([101, 202]);
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      firstEntered = resolveEntered;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });

    const first = withProjectStorage(
      repository,
      {
        mode: "write",
        scope: "shared-cache",
        dependencies: processDependencies(101, livePids),
      },
      async (storage) => {
        await storage.ensureSharedCache();
        firstEntered();
        await release;
      },
    );
    await entered;

    let secondEntered = false;
    const second = withProjectStorage(
      repository,
      {
        mode: "write",
        scope: "shared-cache",
        waitTimeoutMs: 1_000,
        dependencies: processDependencies(202, livePids),
      },
      async (storage) => {
        await storage.ensureSharedCache();
        secondEntered = true;
      },
    );

    await nextTurn();
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it("[FR-STORE-004-AC3] 同一legacy pairは共有cacheへ一度だけcopyし、移行元fileを保持する", async () => {
    const { repository, linked } = await makeRepositoryWithLinkedWorktree();
    await Promise.all([
      writeLegacy(repository, {
        "tasks.json": TASKS_V1,
        "sync-state.json": SYNC_STATE_V1,
        "comments.json": COMMENTS_V1,
      }),
      writeLegacy(linked, {
        "tasks.json": TASKS_V1,
        "sync-state.json": SYNC_STATE_V1,
        "comments.json": COMMENTS_V1,
      }),
    ]);

    await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V1);
    await publishSharedCache(linked, TASKS_V2, SYNC_STATE_V2);
    await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V2);
    await expect(readFile(join(repository, ".gantt-sync", "tasks.json"), "utf8")).resolves.toBe(
      TASKS_V1,
    );
    await expect(readFile(join(linked, ".gantt-sync", "tasks.json"), "utf8")).resolves.toBe(
      TASKS_V1,
    );
  });

  it("[FR-STORE-004-AC3] legacy tasksとsync-stateの片側だけがある場合はfail-closedにする", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    await writeLegacy(repository, { "tasks.json": TASKS_V1 });

    await expect(readSlot(repository, "tasks")).rejects.toMatchObject({
      code: "LEGACY_CACHE_INCOMPLETE",
    });
  });

  it("[FR-STORE-004-AC3] 破損したlegacy JSONは空cacheへfallbackせずfail-closedにする", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    await writeLegacy(repository, {
      "tasks.json": "{ broken\n",
      "sync-state.json": SYNC_STATE_V1,
    });

    await expect(readSlot(repository, "tasks")).rejects.toMatchObject({
      code: "LEGACY_CACHE_INVALID",
    });
  });

  it("[FR-STORE-004-AC3] 破損したlegacy commentsは再構築可能な欠損としてpair migrationを継続する", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    await writeLegacy(repository, {
      "tasks.json": TASKS_V1,
      "sync-state.json": SYNC_STATE_V1,
      "comments.json": "{ broken\n",
    });

    await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V1);
    await expect(readSlot(repository, "comments")).resolves.toBe(
      `${JSON.stringify({ version: "1", fetched_at: {}, comments: {} }, null, 2)}\n`,
    );
  });

  it("[FR-STORE-004-AC3] migration後にlegacy fingerprintが変わった場合は共有cacheを上書きせず拒否する", async () => {
    const { repository, linked } = await makeRepositoryWithLinkedWorktree();
    await Promise.all([
      writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE_V1 }),
      writeLegacy(linked, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE_V1 }),
    ]);
    await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V1);
    await writeLegacy(linked, { "tasks.json": TASKS_V2, "sync-state.json": SYNC_STATE_V2 });

    await expect(readSlot(repository, "tasks")).rejects.toMatchObject({
      code: "LEGACY_CACHE_DIVERGED",
    });
  });

  it("[FR-STORE-004-AC3] 破損したmigration manifestは検証を迂回せずfail-closedにする", async () => {
    const { repository, commonDir } = await makeRepositoryWithLinkedWorktree();
    await publishSharedCache(repository);
    const namespaceRoot = projectNamespace(commonDir, "fixture/repository#1");
    await writeFile(join(namespaceRoot, "migration.json"), "{ broken\n");

    await expect(readSlot(repository, "tasks")).rejects.toMatchObject({
      code: "MIGRATION_MANIFEST_INVALID",
    });
  });

  it("[FR-STORE-004-AC5] storage migrate --fromで明示した分岐候補だけを共有generationへpublishする", async () => {
    const { repository, linked } = await makeRepositoryWithLinkedWorktree();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE_V1 });
    await writeLegacy(linked, { "tasks.json": TASKS_V2, "sync-state.json": SYNC_STATE_V2 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await createStorageCommand({ projectRoot: () => repository }).parseAsync(
        ["migrate", "--from", linked, "--json"],
        { from: "user" },
      );
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        ok: true,
        source: linked,
      });
      await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V2);
      await expect(readSlot(repository, "sync-state")).resolves.toBe(SYNC_STATE_V2);
    } finally {
      log.mockRestore();
    }
  });

  it("[FR-STORE-004-AC2] 同じgit-common-dirでもGitHub Project identityが異なるworktreeはnamespaceを分離する", async () => {
    const { repository, linked } = await makeRepositoryWithLinkedWorktree();
    await publishSharedCache(repository);
    await writeFile(join(linked, ".gantt-sync", "gantt.config.json"), CONFIG_OTHER_PROJECT);
    await publishSharedCache(linked, TASKS_V2, SYNC_STATE_V2);

    await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V1);
    await expect(readSlot(linked, "tasks")).resolves.toBe(TASKS_V2);
  });

  it("[FR-STORE-004-AC2] 別Projectの不完全なlegacy pairは現在Projectのmigrationを停止しない", async () => {
    const { repository, linked } = await makeRepositoryWithLinkedWorktree();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE_V1 });
    await writeFile(join(linked, ".gantt-sync", "gantt.config.json"), CONFIG_OTHER_PROJECT);
    await writeLegacy(linked, { "tasks.json": TASKS_V2 });

    await expect(readSlot(repository, "tasks")).resolves.toBe(TASKS_V1);
  });

  it("[NFR-STABILITY-015-AC5] read modeと異なるwrite scopeからの型付き書き込みを拒否する", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();

    await expect(
      withProjectStorage(repository, { mode: "read" }, (storage) =>
        storage.tasksStore.write(JSON.parse(TASKS_V1)),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_SCOPE_VIOLATION" });
    await expect(
      withProjectStorage(repository, { mode: "write", scope: "workspace" }, (storage) =>
        storage.tasksStore.write(JSON.parse(TASKS_V1)),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_SCOPE_VIOLATION" });
    await expect(
      withProjectStorage(repository, { mode: "write", scope: "shared-cache" }, (storage) =>
        storage.configStore.write(JSON.parse(CONFIG_V1)),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_SCOPE_VIOLATION" });
  });

  it("[NFR-STABILITY-015-AC3] live ownerのleaseはtimeout後も回収せずSTORAGE_BUSYを返す", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    const livePids = new Set([501, 502]);
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      firstEntered = resolveEntered;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });
    const first = withProjectStorage(
      repository,
      {
        mode: "write",
        scope: "shared-cache",
        dependencies: processDependencies(501, livePids),
      },
      async (storage) => {
        await storage.ensureSharedCache();
        firstEntered();
        await release;
      },
    );
    await entered;

    await expect(
      withProjectStorage(
        repository,
        {
          mode: "write",
          scope: "shared-cache",
          waitTimeoutMs: 20,
          dependencies: processDependencies(502, livePids),
        },
        async (storage) => storage.ensureSharedCache(),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_BUSY" });

    releaseFirst();
    await first;
  });

  it("[NFR-STABILITY-015-AC3] pull guardの失敗でもprocessを即時終了せずleaseを解放する", async () => {
    const { repository, commonDir } = await makeRepositoryWithLinkedWorktree();
    const tasksWithConflicts = `${JSON.stringify(
      { ...JSON.parse(TASKS_V1), has_conflicts: true },
      null,
      2,
    )}\n`;
    await writeLegacy(repository, {
      "tasks.json": tasksWithConflicts,
      "sync-state.json": SYNC_STATE_V1,
    });
    const previousExitCode = process.exitCode;
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(repository);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await pullCommand.parseAsync(["pull"], { from: "user" });
      expect(process.exitCode).toBe(1);
      await expect(
        access(join(commonDir, "gh-gantt", "locks", "work-graph-cache.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.exitCode = previousExitCode;
      cwd.mockRestore();
      error.mockRestore();
    }
  });

  it("[NFR-STABILITY-015-AC3] 同一hostで死亡を確認できるownerのleaseだけを回収する", async () => {
    const { repository, commonDir } = await makeRepositoryWithLinkedWorktree();
    const leaseDir = join(commonDir, "gh-gantt", "locks", "work-graph-cache.lock");
    await mkdir(leaseDir, { recursive: true });
    await writeFile(
      join(leaseDir, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        group: "work-graph-cache",
        pid: 601,
        hostname: "issue-299-test-host",
        startedAt: "2026-07-30T00:00:00.000Z",
        workspace: repository,
        access: "write",
        nonce: "dead-owner",
      })}\n`,
    );
    const livePids = new Set([602]);

    await expect(
      withProjectStorage(
        repository,
        {
          mode: "write",
          scope: "shared-cache",
          waitTimeoutMs: 100,
          dependencies: processDependencies(602, livePids),
        },
        async (storage) => storage.ensureSharedCache(),
      ),
    ).resolves.toBeUndefined();
    await expect(access(leaseDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("[FR-STORE-004-AC4] Git executableの起動失敗はnon-git扱いにせずGIT_DISCOVERY_FAILEDを返す", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    const emptyPath = await makeStandaloneRoot();
    const originalPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      await expect(
        withProjectStorage(repository, { mode: "read" }, (storage) => storage.ensureSharedCache()),
      ).rejects.toMatchObject({ code: "GIT_DISCOVERY_FAILED" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("[NFR-STABILITY-015-AC9] Git hookのrepository選択envをsubprocessへ継承しない", async () => {
    const { repository, linked, commonDir } = await makeRepositoryWithLinkedWorktree();
    const foreignGitDir = await makeStandaloneRoot();
    await execFileAsync("git", ["init", "--bare", foreignGitDir], {
      env: gitCommandEnvironment(),
    });
    const previousGitDir = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = foreignGitDir;
    process.env.GIT_WORK_TREE = repository;

    try {
      await publishSharedCache(repository);
      await expect(readSlot(linked, "tasks")).resolves.toBe(TASKS_V1);
      await expect(
        access(join(projectNamespace(commonDir, "fixture/repository#1"), "CURRENT")),
      ).resolves.toBeUndefined();
      await expect(access(join(foreignGitDir, "gh-gantt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
    }
  });

  it("[NFR-STABILITY-015-AC9] Git discovery範囲を制限するenvよりprojectRootを優先する", async () => {
    const { repository, linked } = await makeRepositoryWithLinkedWorktree();
    const nestedRepository = join(repository, "nested-project");
    const nestedLinked = join(linked, "nested-project");
    await Promise.all([
      mkdir(join(nestedRepository, ".gantt-sync"), { recursive: true }),
      mkdir(join(nestedLinked, ".gantt-sync"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(nestedRepository, ".gantt-sync", "gantt.config.json"), CONFIG_V1),
      writeFile(join(nestedLinked, ".gantt-sync", "gantt.config.json"), CONFIG_V1),
    ]);
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    const previousDiscovery = process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
    process.env.GIT_CEILING_DIRECTORIES = repository;
    process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";

    try {
      await publishSharedCache(nestedRepository);
      await expect(readSlot(nestedLinked, "tasks")).resolves.toBe(TASKS_V1);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      if (previousDiscovery === undefined) delete process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
      else process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = previousDiscovery;
    }
  });

  it("[NFR-STABILITY-015-AC7] 別hostで生死を判定できないownerのleaseは回収しない", async () => {
    const { repository, commonDir } = await makeRepositoryWithLinkedWorktree();
    const leaseDir = join(commonDir, "gh-gantt", "locks", "work-graph-cache.lock");
    await mkdir(leaseDir, { recursive: true });
    await writeFile(
      join(leaseDir, "owner.json"),
      `${JSON.stringify({
        schemaVersion: "1",
        group: "work-graph-cache",
        pid: 701,
        hostname: "remote-host",
        startedAt: "2026-07-30T00:00:00.000Z",
        workspace: repository,
        access: "write",
        nonce: "unknown-owner",
      })}\n`,
    );
    const liveness = vi.fn(async () => false);

    await expect(
      withProjectStorage(
        repository,
        {
          mode: "read",
          waitTimeoutMs: 20,
          dependencies: createProjectStorageDependencies({
            processIdentity: { pid: 702, hostname: "local-host" },
            isProcessAlive: liveness,
          }),
        },
        (storage) => storage.ensureSharedCache(),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_BUSY" });
    expect(liveness).not.toHaveBeenCalled();
  });

  it("[NFR-STABILITY-015-AC5] shared slotに触れないcallbackはGit discoveryもfilesystem初期化も行わない", async () => {
    const root = await makeStandaloneRoot();
    const runGitAdapter = vi.fn(async () => {
      throw new Error("呼び出されてはならない");
    });

    await expect(
      withProjectStorage(
        root,
        {
          mode: "read",
          dependencies: createProjectStorageDependencies({ runGit: runGitAdapter }),
        },
        async () => "untouched",
      ),
    ).resolves.toBe("untouched");
    expect(runGitAdapter).not.toHaveBeenCalled();
    await expect(access(join(root, ".gantt-sync"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("[NFR-STABILITY-015-AC2] 真の別OS processが保持するfile leaseの解放まで後続callbackを待機する", async () => {
    const { repository } = await makeRepositoryWithLinkedWorktree();
    const scratch = await makeStandaloneRoot();
    const childScript = join(scratch, "lease-holder.ts");
    const barrier = join(scratch, "lease-held");
    const release = join(scratch, "lease-release");
    const moduleUrl = new URL("../../store/project-storage.ts", import.meta.url).href;
    await writeFile(
      childScript,
      `
import { access, writeFile } from "node:fs/promises";

const [moduleUrl, root, barrier, release] = process.argv.slice(2);
async function main() {
  const { withProjectStorage } = await import(moduleUrl);
  await withProjectStorage(root, { mode: "write", scope: "shared-cache" }, async (storage) => {
    await storage.ensureSharedCache();
    await writeFile(barrier, "held\\n");
    while (true) {
      try {
        await access(release);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`,
    );

    const child = spawn(
      process.execPath,
      ["--import", "tsx", childScript, moduleUrl, repository, barrier, release],
      {
        cwd: process.cwd(),
        env: gitCommandEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let childStderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      childStderr += chunk;
    });
    await waitForFile(barrier, child, () => childStderr);

    let secondEntered = false;
    const second = withProjectStorage(
      repository,
      { mode: "write", scope: "shared-cache", waitTimeoutMs: 2_000 },
      async (storage) => {
        await storage.ensureSharedCache();
        secondEntered = true;
      },
    );
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
    expect(secondEntered).toBe(false);

    await writeFile(release, "release\n");
    const [exitCode] = (await once(child, "exit")) as [number | null];
    expect(exitCode, childStderr).toBe(0);
    await second;
    expect(secondEntered).toBe(true);
  });
});
