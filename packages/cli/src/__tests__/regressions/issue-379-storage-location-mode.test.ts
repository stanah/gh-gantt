/**
 * Issue #379: config / workflow / journal の配置モード (`repository` / `git`) の regression。
 *
 * `git` モードは git-common-dir 配下の gh-gantt 名前空間に config を置き、全 linked worktree が
 * 同じ config を参照する。journal (loop-state / Run Graph) は worktree 識別子で分離する。
 * 両モードに config がある曖昧な状態は fail-closed で停止する。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyLoopState, FIXED_DEV_ROLE_GRAPH_CONTRACT } from "@gh-gantt/shared";
import { createStorageCommand } from "../../commands/storage.js";
import { GraphContractStore } from "../../store/graph-contract.js";
import { withProjectStorage } from "../../store/project-storage.js";
import { RunGraphEventStore } from "../../store/run-graph.js";

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

const CONFIG = {
  version: "1",
  project: {
    name: "Issue 379 fixture",
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
};

const TASKS = { tasks: [], cache: { comments: {}, reactions: {} } };
const SYNC_STATE = {
  last_synced_at: "2026-09-09T00:00:00.000Z",
  project_node_id: "PVT_test",
  id_map: {},
  field_ids: {},
  snapshots: {},
};

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) {
    delete environment[name];
  }
  return environment;
}

async function runGit(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { env: gitEnvironment() });
  return result.stdout.trim();
}

/** config を commit せず、linked worktree を 1 つ持つ実 Git repository。 */
async function makeRepository(): Promise<{
  repository: string;
  linked: string;
  commonDir: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "gh-gantt-issue-379-"));
  createdRoots.push(parent);
  const repository = join(parent, "repository");
  const linked = join(parent, "linked");
  await mkdir(repository);
  await execFileAsync("git", ["init", "--initial-branch=main", repository], {
    env: gitEnvironment(),
  });
  await runGit(repository, "config", "user.email", "issue-379@example.invalid");
  await runGit(repository, "config", "user.name", "Issue 379 Test");
  await writeFile(join(repository, "README.md"), "fixture\n");
  await runGit(repository, "add", "README.md");
  await runGit(repository, "commit", "-m", "test: fixture");
  await runGit(repository, "worktree", "add", "-b", "fixture-linked", linked);
  const rawCommonDir = await runGit(linked, "rev-parse", "--git-common-dir");
  const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(linked, rawCommonDir);
  return { repository, linked, commonDir };
}

async function makeStandaloneRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gh-gantt-issue-379-standalone-"));
  createdRoots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeRepositoryConfig(root: string, name = CONFIG.project.name): Promise<void> {
  await mkdir(join(root, ".gantt-sync"), { recursive: true });
  await writeFile(
    join(root, ".gantt-sync", "gantt.config.json"),
    `${JSON.stringify({ ...CONFIG, project: { ...CONFIG.project, name } }, null, 2)}\n`,
  );
}

async function initGitMode(root: string): Promise<void> {
  await withProjectStorage(
    root,
    { mode: "write", scope: "all", storageMode: "git" },
    async (storage) => {
      await storage.configStore.write(CONFIG as never);
      await storage.flush();
      await storage.tasksStore.write(TASKS);
      await storage.stateStore.write(SYNC_STATE);
    },
  );
}

async function describe379(root: string) {
  return withProjectStorage(root, { mode: "read", scope: "workspace" }, (storage) =>
    storage.describeStorage(),
  );
}

async function runStorage(root: string, ...args: string[]): Promise<Record<string, unknown>> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const exitCode = process.exitCode;
  try {
    await createStorageCommand({ projectRoot: () => root }).parseAsync([...args, "--json"], {
      from: "user",
    });
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  } finally {
    process.exitCode = exitCode;
    log.mockRestore();
    error.mockRestore();
  }
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("[FR-STORE-005] [Issue #379] config / workflow / journal の配置モードを repository と git から選べる", () => {
  it("[FR-STORE-005-AC1] git モードは .gantt-sync/ を作らず、全 linked worktree が git-common-dir 配下の同じ config を参照する", async () => {
    const { repository, linked, commonDir } = await makeRepository();
    await initGitMode(repository);

    expect(await exists(join(repository, ".gantt-sync"))).toBe(false);
    expect(await exists(join(linked, ".gantt-sync"))).toBe(false);
    const description = await describe379(repository);
    expect(description.mode).toBe("git");
    expect(description.paths.config.startsWith(join(commonDir, "gh-gantt", "config"))).toBe(true);
    expect(await exists(description.paths.config)).toBe(true);

    // linked worktree からも同じ config と共有 cache を読める
    const fromLinked = await describe379(linked);
    expect(fromLinked.mode).toBe("git");
    expect(fromLinked.paths.config).toBe(description.paths.config);
    await withProjectStorage(linked, { mode: "read", scope: "shared-cache" }, async (storage) => {
      await expect(storage.configStore.read()).resolves.toMatchObject({
        project: { name: CONFIG.project.name },
      });
      await expect(storage.tasksStore.read()).resolves.toEqual(TASKS);
    });

    // git 管理下に未追跡 file が増えていない
    expect(await runGit(repository, "status", "--porcelain")).toBe("");
  });

  it("[FR-STORE-005-AC2] git モードでも loop-state と Run Graph は worktree ごとに分離され、.gantt-sync/ に書かれない", async () => {
    const { repository, linked, commonDir } = await makeRepository();
    await initGitMode(repository);

    const repositoryLoop = createEmptyLoopState();
    repositoryLoop.iterations.push({
      id: 1,
      startedAt: "2026-09-09T00:00:00.000Z",
      selectedTask: null,
      decision: "repository",
    });
    const linkedLoop = createEmptyLoopState();
    linkedLoop.iterations.push({
      id: 1,
      startedAt: "2026-09-09T00:01:00.000Z",
      selectedTask: null,
      decision: "linked",
    });
    await withProjectStorage(repository, { mode: "write", scope: "workspace" }, (storage) =>
      storage.loopStore.write(repositoryLoop),
    );
    await withProjectStorage(linked, { mode: "write", scope: "workspace" }, (storage) =>
      storage.loopStore.write(linkedLoop),
    );
    await withProjectStorage(repository, { mode: "read", scope: "workspace" }, async (storage) => {
      await expect(storage.loopStore.readOrNull()).resolves.toEqual(repositoryLoop);
    });
    await withProjectStorage(linked, { mode: "read", scope: "workspace" }, async (storage) => {
      await expect(storage.loopStore.readOrNull()).resolves.toEqual(linkedLoop);
    });

    const repositoryContract = { ...FIXED_DEV_ROLE_GRAPH_CONTRACT, planId: "repository-379" };
    const linkedContract = { ...FIXED_DEV_ROLE_GRAPH_CONTRACT, planId: "linked-379" };
    await new GraphContractStore(repository).install(repositoryContract);
    await new GraphContractStore(linked).install(linkedContract);
    await expect(
      new GraphContractStore(linked).read({
        planId: "repository-379",
        planVersion: "1",
        schemaVersion: "1",
      }),
    ).rejects.toThrow();
    await new RunGraphEventStore(repository).appendAccepted({
      recordType: "accepted",
      eventId: "repository-run-start",
      sequence: 1,
      runId: "repository-run",
      acceptedAt: "2026-09-09T00:00:00.000Z",
      actor: { id: "orchestrator-1", role: "orchestrator" },
      command: {
        type: "run_started",
        task: { owner: "fixture", repo: "repository", issueNumber: 379 },
        contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
        firstNodeId: "node-planner-1",
      },
      artifactIds: [],
      evidenceIds: [],
    });
    await expect(new RunGraphEventStore(repository).listRunIds()).resolves.toEqual([
      "repository-run",
    ]);
    await expect(new RunGraphEventStore(linked).listRunIds()).resolves.toEqual([]);

    expect(await exists(join(repository, ".gantt-sync"))).toBe(false);
    expect(await exists(join(linked, ".gantt-sync"))).toBe(false);
    const repositoryPaths = (await describe379(repository)).paths;
    const linkedPaths = (await describe379(linked)).paths;
    expect(repositoryPaths.loopState).not.toBe(linkedPaths.loopState);
    expect(repositoryPaths.loopState.startsWith(join(commonDir, "gh-gantt", "workspaces"))).toBe(
      true,
    );
    expect(await exists(join(repositoryPaths.runGraph, "runs"))).toBe(true);
  });

  it("[FR-STORE-005-AC3] repository と git の両方に config がある場合は fail-closed で停止し、両 path を示す", async () => {
    const { repository } = await makeRepository();
    await initGitMode(repository);
    await writeRepositoryConfig(repository, "stale repository config");

    const failure = await describe379(repository).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "STORAGE_MODE_AMBIGUOUS" });
    expect(String((failure as Error).message)).toContain(
      join(repository, ".gantt-sync", "gantt.config.json"),
    );
    expect(String((failure as Error).message)).toContain(join("gh-gantt", "config"));
    await expect(
      withProjectStorage(repository, { mode: "read", scope: "shared-cache" }, (storage) =>
        storage.tasksStore.read(),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_MODE_AMBIGUOUS" });

    const status = await runStorage(repository, "status");
    expect(status).toMatchObject({ ok: false, code: "STORAGE_MODE_AMBIGUOUS" });
  });

  it("[FR-STORE-005-AC4] 既存の .gantt-sync/ 配置は無指定で repository モードのまま動き、non-git は repository のみ、矛盾する明示指定は停止する", async () => {
    const { repository, linked } = await makeRepository();
    await writeRepositoryConfig(repository);

    const description = await describe379(repository);
    const canonical = await realpath(repository);
    expect(description.mode).toBe("repository");
    expect(description.paths.config).toBe(join(canonical, ".gantt-sync", "gantt.config.json"));
    expect(description.paths.loopState).toBe(join(canonical, ".gantt-sync", "loop-state.json"));
    // config を commit していない linked worktree には config が無いので、既定の repository モードで解決する
    expect((await describe379(linked)).mode).toBe("repository");

    await expect(
      withProjectStorage(
        repository,
        { mode: "read", scope: "workspace", storageMode: "git" },
        (storage) => storage.configStore.read(),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_MODE_MISMATCH" });

    const standalone = await makeStandaloneRoot();
    await writeRepositoryConfig(standalone);
    const standaloneDescription = await describe379(standalone);
    expect(standaloneDescription.mode).toBe("repository");
    expect(standaloneDescription.gitCommonDir).toBeNull();
    await expect(
      withProjectStorage(
        standalone,
        { mode: "read", scope: "workspace", storageMode: "git" },
        (storage) => storage.configStore.read(),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_MODE_UNSUPPORTED" });
  });

  it("[FR-STORE-005-AC5] storage migrate --to で config / workflow / journal を移動し、manifest に記録した後も共有 cache と legacy 検証が通る", async () => {
    const { repository, linked, commonDir } = await makeRepository();
    await writeRepositoryConfig(repository);
    await writeFile(join(repository, ".gantt-sync", "workflow.md"), "# workflow\n");
    await writeFile(
      join(repository, ".gantt-sync", "loop-state.json"),
      `${JSON.stringify(createEmptyLoopState(), null, 2)}\n`,
    );
    // 移行前の legacy cache は fingerprint 付きで migration manifest に記録される
    await writeFile(
      join(repository, ".gantt-sync", "tasks.json"),
      `${JSON.stringify(TASKS, null, 2)}\n`,
    );
    await writeFile(
      join(repository, ".gantt-sync", "sync-state.json"),
      `${JSON.stringify(SYNC_STATE, null, 2)}\n`,
    );

    const report = await runStorage(repository, "migrate", "--to", "git");
    expect(report).toMatchObject({ ok: true, changed: true, from: "repository", to: "git" });
    expect((report.moved as Array<{ slot: string }>).map((item) => item.slot)).toEqual([
      "config",
      "workflow",
      "loop-state",
    ]);

    const description = await describe379(repository);
    expect(description.mode).toBe("git");
    expect(await exists(join(repository, ".gantt-sync", "gantt.config.json"))).toBe(false);
    expect(await exists(join(repository, ".gantt-sync", "workflow.md"))).toBe(false);
    expect(await exists(join(repository, ".gantt-sync", "loop-state.json"))).toBe(false);
    await expect(readFile(description.paths.workflow, "utf8")).resolves.toBe("# workflow\n");
    expect(await exists(description.paths.loopState)).toBe(true);
    // legacy tasks / sync-state は削除されず、config の無い worktree でも共有 identity で検証される
    expect(await exists(join(repository, ".gantt-sync", "tasks.json"))).toBe(true);
    await withProjectStorage(linked, { mode: "read", scope: "shared-cache" }, async (storage) => {
      await expect(storage.tasksStore.read()).resolves.toEqual(TASKS);
      await expect(storage.configStore.read()).resolves.toMatchObject({
        project: { name: CONFIG.project.name },
      });
    });

    const manifestDir = join(commonDir, "gh-gantt", "cache", "project-storage", "v1");
    const manifests = await execFileAsync("find", [manifestDir, "-name", "migration.json"]);
    const manifestPath = manifests.stdout.trim();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.storageRelocations).toHaveLength(1);
    expect(manifest.storageRelocations[0]).toMatchObject({ from: "repository", to: "git" });
    expect(Object.keys(manifest.legacyFingerprints)).toHaveLength(1);

    // 同じモードへの再実行は no-op
    await expect(runStorage(repository, "migrate", "--to", "git")).resolves.toMatchObject({
      ok: true,
      changed: false,
    });

    // 逆方向へ戻すと .gantt-sync/ の配置に戻り、履歴が 2 件になる
    const back = await runStorage(repository, "migrate", "--to", "repository");
    expect(back).toMatchObject({ ok: true, changed: true, from: "git", to: "repository" });
    expect((await describe379(repository)).mode).toBe("repository");
    await expect(readFile(join(repository, ".gantt-sync", "workflow.md"), "utf8")).resolves.toBe(
      "# workflow\n",
    );
    expect(JSON.parse(await readFile(manifestPath, "utf8")).storageRelocations).toHaveLength(2);
  });

  it("[FR-STORE-005-AC5] --from と --to の同時指定、未知のモードは移行を開始しない", async () => {
    const { repository } = await makeRepository();
    await writeRepositoryConfig(repository);
    await expect(
      runStorage(repository, "migrate", "--to", "git", "--from", repository),
    ).resolves.toMatchObject({ ok: false, code: "STORAGE_MIGRATION_INVALID" });
    await expect(runStorage(repository, "migrate", "--to", "cloud")).resolves.toMatchObject({
      ok: false,
    });
    expect((await describe379(repository)).mode).toBe("repository");
  });
});
