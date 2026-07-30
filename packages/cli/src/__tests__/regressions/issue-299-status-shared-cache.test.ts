import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../github/client.js", () => ({
  createGraphQLClient: vi.fn(() => vi.fn()),
}));

vi.mock("../../github/comments.js", () => ({
  fetchAllComments: vi.fn(),
}));

vi.mock("../../github/projects.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../github/projects.js")>();
  return {
    ...original,
    checkRemoteChanges: vi.fn().mockResolvedValue(false),
    fetchProject: vi.fn().mockResolvedValue({
      projectNodeId: "PVT_issue_299",
      projectTitle: "Issue 299 fixture",
      fields: [],
      items: [],
    }),
    fetchRepositoryMetadata: vi.fn().mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    }),
  };
});

import { statusCommand } from "../../commands/status.js";
import { pullCommand } from "../../commands/pull.js";
import { pushCommand } from "../../commands/push.js";
import { fetchAllComments } from "../../github/comments.js";
import { withProjectStorage } from "../../store/project-storage.js";

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];
let originalExitCode: typeof process.exitCode;

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

const CONFIG = `${JSON.stringify(
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

const TASKS = `${JSON.stringify({ tasks: [], cache: { comments: {}, reactions: {} } }, null, 2)}\n`;

const SYNC_STATE = `${JSON.stringify(
  {
    last_synced_at: "2026-07-30T00:00:00.000Z",
    project_node_id: "PVT_issue_299",
    id_map: {},
    field_ids: {},
    snapshots: {},
  },
  null,
  2,
)}\n`;

async function runGit(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], { env: gitCommandEnvironment() });
}

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("[NFR-STABILITY-015] [Issue #299] statusはlinked worktreeから共有cacheを読む", () => {
  it("[NFR-STABILITY-015-AC6] linked worktree固有のpullなしで共有tasks/sync-stateを使ってstatusを表示する", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gh-gantt-issue-299-status-"));
    createdRoots.push(parent);
    const repository = join(parent, "repository");
    const linked = join(parent, "linked");
    await mkdir(join(repository, ".gantt-sync"), { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", repository], {
      env: gitCommandEnvironment(),
    });
    await runGit(repository, "config", "user.email", "issue-299@example.invalid");
    await runGit(repository, "config", "user.name", "Issue 299 Test");
    await writeFile(join(repository, ".gantt-sync", "gantt.config.json"), CONFIG);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await runGit(repository, "add", "README.md", ".gantt-sync/gantt.config.json");
    await runGit(repository, "commit", "-m", "test: fixture");
    await runGit(repository, "worktree", "add", "-b", "fixture-linked", linked);

    await withProjectStorage(
      repository,
      { mode: "write", scope: "shared-cache" },
      async (storage) => {
        await storage.tasksStore.write(JSON.parse(TASKS));
        await storage.stateStore.write(JSON.parse(SYNC_STATE));
      },
    );

    await expect(access(join(linked, ".gantt-sync", "tasks.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(linked, ".gantt-sync", "sync-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    vi.spyOn(process, "cwd").mockReturnValue(linked);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await statusCommand.parseAsync(["status", "--json"], { from: "user" });

    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      last_synced_at: "2026-07-30T00:00:00.000Z",
      local_tasks: 0,
      remote_tasks: 0,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("[NFR-STABILITY-015-AC8] real linked worktreeでCLI pullとpush dry-runが共有cacheを継続利用する", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gh-gantt-issue-299-sync-"));
    createdRoots.push(parent);
    const repository = join(parent, "repository");
    const linked = join(parent, "linked");
    await mkdir(join(repository, ".gantt-sync"), { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", repository], {
      env: gitCommandEnvironment(),
    });
    await runGit(repository, "config", "user.email", "issue-299@example.invalid");
    await runGit(repository, "config", "user.name", "Issue 299 Test");
    await writeFile(join(repository, ".gantt-sync", "gantt.config.json"), CONFIG);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await runGit(repository, "add", "README.md", ".gantt-sync/gantt.config.json");
    await runGit(repository, "commit", "-m", "test: fixture");
    await runGit(repository, "worktree", "add", "-b", "fixture-linked", linked);
    await withProjectStorage(
      repository,
      { mode: "write", scope: "shared-cache" },
      async (storage) => {
        await storage.tasksStore.write(JSON.parse(TASKS));
        await storage.stateStore.write(JSON.parse(SYNC_STATE));
      },
    );

    vi.spyOn(process, "cwd").mockReturnValue(linked);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await pullCommand.parseAsync(["pull", "--json"], { from: "user" });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      summary: { added: 0, updated: 0, conflicts: 0, removed: 0 },
    });

    log.mockClear();
    await pushCommand.parseAsync(["push", "--dry-run", "--json"], { from: "user" });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      changes: [],
      dry_run: true,
      estimated_api_calls: 0,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("[NFR-STABILITY-015-AC8] quick-skipしたpull dry-runは--with-commentsでもcomment cacheを書き換えない", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gh-gantt-issue-299-dry-run-"));
    createdRoots.push(parent);
    const repository = join(parent, "repository");
    await mkdir(join(repository, ".gantt-sync"), { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", repository], {
      env: gitCommandEnvironment(),
    });
    await runGit(repository, "config", "user.email", "issue-299@example.invalid");
    await runGit(repository, "config", "user.name", "Issue 299 Test");
    await writeFile(join(repository, ".gantt-sync", "gantt.config.json"), CONFIG);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await runGit(repository, "add", "README.md", ".gantt-sync/gantt.config.json");
    await runGit(repository, "commit", "-m", "test: fixture");
    await withProjectStorage(
      repository,
      { mode: "write", scope: "shared-cache" },
      async (storage) => {
        await storage.tasksStore.write(JSON.parse(TASKS));
        await storage.stateStore.write(JSON.parse(SYNC_STATE));
      },
    );

    vi.spyOn(process, "cwd").mockReturnValue(repository);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await pullCommand.parseAsync(["pull", "--dry-run", "--with-comments", "--json"], {
      from: "user",
    });

    expect(fetchAllComments).not.toHaveBeenCalled();
    await expect(access(join(repository, ".gantt-sync", "comments.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
