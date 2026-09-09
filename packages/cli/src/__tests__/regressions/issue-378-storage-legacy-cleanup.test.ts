/**
 * Issue #378: 共有 cache へ移行済みの legacy `.gantt-sync/` file を安全に掃除する。
 *
 * 削除対象は migration manifest に記録された fingerprint と一致する pair に限り、
 * 一致しない pair は理由付きで残す。`--dry-run` は削除せず計画だけを返す。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageCommand } from "../../commands/storage.js";
import { withProjectStorage } from "../../store/project-storage.js";

const execFileAsync = promisify(execFile);
const createdRoots: string[] = [];

const CONFIG = `${JSON.stringify(
  {
    version: "1",
    project: {
      name: "Issue 378 fixture",
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

const TASKS_V1 = `${JSON.stringify({ tasks: [], cache: { comments: {}, reactions: {} } }, null, 2)}\n`;
const TASKS_V2 = `${JSON.stringify(
  {
    tasks: [],
    cache: {
      comments: { marker: [{ author: "tester", body: "v2", created_at: "2026-01-01" }] },
      reactions: {},
    },
  },
  null,
  2,
)}\n`;
const SYNC_STATE = `${JSON.stringify(
  {
    last_synced_at: "2026-09-09T00:00:00.000Z",
    project_node_id: "PVT_test",
    id_map: {},
    field_ids: {},
    snapshots: {},
  },
  null,
  2,
)}\n`;
const COMMENTS = `${JSON.stringify({ version: "1", fetched_at: {}, comments: {} }, null, 2)}\n`;

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

async function makeRepository(): Promise<{
  repository: string;
  linked: string;
  commonDir: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "gh-gantt-issue-378-"));
  createdRoots.push(parent);
  const repository = join(parent, "repository");
  const linked = join(parent, "linked");
  await mkdir(repository);
  await execFileAsync("git", ["init", "--initial-branch=main", repository], {
    env: gitEnvironment(),
  });
  await runGit(repository, "config", "user.email", "issue-378@example.invalid");
  await runGit(repository, "config", "user.name", "Issue 378 Test");
  await mkdir(join(repository, ".gantt-sync"), { recursive: true });
  await writeFile(join(repository, ".gantt-sync", "gantt.config.json"), CONFIG);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await runGit(repository, "add", "README.md", ".gantt-sync/gantt.config.json");
  await runGit(repository, "commit", "-m", "test: fixture");
  await runGit(repository, "worktree", "add", "-b", "fixture-linked", linked);
  const rawCommonDir = await runGit(linked, "rev-parse", "--git-common-dir");
  const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(linked, rawCommonDir);
  return { repository, linked, commonDir };
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTasks(root: string): Promise<string> {
  return withProjectStorage(
    root,
    { mode: "read", scope: "shared-cache" },
    async (storage) => `${JSON.stringify(await storage.tasksStore.read(), null, 2)}\n`,
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

type Entry = { workspace: string; state: string; action?: string; files: string[] };

function entriesOf(report: Record<string, unknown>): Entry[] {
  const legacy = report.legacy as { entries: Entry[] } | undefined;
  return (legacy?.entries ?? (report.entries as Entry[])).map((entry) => entry);
}

async function manifestOf(commonDir: string): Promise<Record<string, unknown>> {
  const found = await execFileAsync("find", [
    join(commonDir, "gh-gantt", "cache", "project-storage", "v1"),
    "-name",
    "migration.json",
  ]);
  return JSON.parse(await readFile(found.stdout.trim(), "utf8"));
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("[FR-STORE-006] [Issue #378] 移行済みの legacy cache を fingerprint 一致の範囲で安全に掃除する", () => {
  it("[FR-STORE-006-AC1] [FR-STORE-006-AC4] storage status は移行済み legacy file が残っていることを worktree ごとに示す", async () => {
    const { repository, linked } = await makeRepository();
    await writeLegacy(repository, {
      "tasks.json": TASKS_V1,
      "sync-state.json": SYNC_STATE,
      "comments.json": COMMENTS,
    });
    await writeLegacy(linked, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    // 最初の shared access で legacy pair が共有 cache へ移行され、manifest に記録される
    await expect(readTasks(repository)).resolves.toBe(TASKS_V1);

    const status = await runStorage(repository, "status");
    expect(status.ok).toBe(true);
    const entries = entriesOf(status);
    expect(entries.map((entry) => entry.state)).toEqual(["recorded", "recorded"]);
    expect(entries.map((entry) => entry.files.length)).toEqual([2, 3]);
  });

  it("[FR-STORE-006-AC2] --dry-run は削除予定を列挙するだけで file を残す", async () => {
    const { repository, linked } = await makeRepository();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await writeLegacy(linked, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V1);

    const plan = await runStorage(repository, "cleanup", "--dry-run");
    expect(plan).toMatchObject({ ok: true, dryRun: true });
    expect(entriesOf(plan).map((entry) => entry.action)).toEqual(["planned", "planned"]);
    expect(await exists(join(repository, ".gantt-sync", "tasks.json"))).toBe(true);
    expect(await exists(join(linked, ".gantt-sync", "tasks.json"))).toBe(true);
  });

  it("[FR-STORE-006-AC1] [FR-STORE-006-AC3] fingerprint が一致する worktree だけを削除し、分岐した worktree は理由付きで残す", async () => {
    const { repository, linked, commonDir } = await makeRepository();
    await writeLegacy(repository, {
      "tasks.json": TASKS_V1,
      "sync-state.json": SYNC_STATE,
      "comments.json": COMMENTS,
    });
    await writeLegacy(linked, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V1);
    // 旧 CLI による再書き込みを模擬して linked を分岐させる
    await writeLegacy(linked, { "tasks.json": TASKS_V2 });
    await expect(readTasks(repository)).rejects.toMatchObject({ code: "LEGACY_CACHE_DIVERGED" });

    const result = await runStorage(repository, "cleanup");
    expect(result).toMatchObject({ ok: true, dryRun: false });
    const entries = entriesOf(result);
    expect(entries.map((entry) => [entry.state, entry.action])).toEqual([
      ["diverged", "skipped"],
      ["recorded", "deleted"],
    ]);
    expect(await exists(join(repository, ".gantt-sync", "tasks.json"))).toBe(false);
    expect(await exists(join(repository, ".gantt-sync", "sync-state.json"))).toBe(false);
    expect(await exists(join(repository, ".gantt-sync", "comments.json"))).toBe(false);
    // config は削除されず、分岐した linked の legacy は残る
    expect(await exists(join(repository, ".gantt-sync", "gantt.config.json"))).toBe(true);
    await expect(readFile(join(linked, ".gantt-sync", "tasks.json"), "utf8")).resolves.toBe(
      TASKS_V2,
    );
    const manifest = await manifestOf(commonDir);
    expect(manifest.legacyCleanups).toHaveLength(1);
    // 分岐は operator が正本を明示するまで通常 access を止め続ける
    await expect(readTasks(repository)).rejects.toMatchObject({ code: "LEGACY_CACHE_DIVERGED" });
    await expect(runStorage(repository, "migrate", "--from", linked)).resolves.toMatchObject({
      ok: true,
    });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V2);
    // 正本にした後は linked も削除できる
    const second = await runStorage(repository, "cleanup");
    expect(entriesOf(second).map((entry) => [entry.state, entry.action])).toEqual([
      ["recorded", "deleted"],
    ]);
    // commit 済みの config は残り、legacy cache だけが消える
    expect(await exists(join(linked, ".gantt-sync", "tasks.json"))).toBe(false);
    expect(await exists(join(linked, ".gantt-sync", "gantt.config.json"))).toBe(true);
    expect((await manifestOf(commonDir)).legacyCleanups).toHaveLength(2);
  });

  it("[FR-STORE-006-AC3] 未記録・片側欠損・別 Project の legacy file は削除しない", async () => {
    const { repository, linked } = await makeRepository();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V1);
    // 移行後に現れた片側だけの legacy
    await writeLegacy(linked, { "tasks.json": TASKS_V1 });

    const result = await runStorage(repository, "cleanup");
    const entries = entriesOf(result);
    expect(entries.map((entry) => [entry.state, entry.action])).toEqual([
      ["incomplete", "skipped"],
      ["recorded", "deleted"],
    ]);
    expect(await exists(join(linked, ".gantt-sync", "tasks.json"))).toBe(true);
  });

  it("[FR-STORE-006-AC3] comments.json だけが残る worktree は別 Project ではなく comments-only として報告し削除しない", async () => {
    const { repository, linked } = await makeRepository();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V1);
    await writeLegacy(linked, { "comments.json": COMMENTS });

    const status = await runStorage(repository, "status");
    const statusEntries = entriesOf(status);
    expect(statusEntries.map((entry) => entry.state)).toEqual(["comments-only", "recorded"]);

    const result = await runStorage(repository, "cleanup");
    expect(entriesOf(result).map((entry) => [entry.state, entry.action])).toEqual([
      ["comments-only", "skipped"],
      ["recorded", "deleted"],
    ]);
    expect(await exists(join(linked, ".gantt-sync", "comments.json"))).toBe(true);
  });

  it("[FR-STORE-006-AC4] migration manifest が壊れていても storage status は解決済み path を返し legacy 検査だけを省く", async () => {
    const { repository, commonDir } = await makeRepository();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V1);
    const found = await execFileAsync("find", [
      join(commonDir, "gh-gantt", "cache", "project-storage", "v1"),
      "-name",
      "migration.json",
    ]);
    await writeFile(found.stdout.trim(), "{ not json");

    const status = await runStorage(repository, "status");
    expect(status.ok).toBe(true);
    expect(status.legacy).toBeNull();
    expect(typeof (status.paths as Record<string, string>).config).toBe("string");
  });

  it("[FR-STORE-006-AC3] 共有 cache がまだ無い repository では未記録として何も削除しない", async () => {
    const { repository } = await makeRepository();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    const untouched = await runStorage(repository, "cleanup");
    expect(entriesOf(untouched).map((entry) => [entry.state, entry.action])).toEqual([
      ["unrecorded", "skipped"],
    ]);
    expect(await exists(join(repository, ".gantt-sync", "tasks.json"))).toBe(true);
  });

  it("[FR-STORE-006-AC4] 削除後も共有 cache の読み書きと manifest 照合が通る", async () => {
    const { repository, linked } = await makeRepository();
    await writeLegacy(repository, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await writeLegacy(linked, { "tasks.json": TASKS_V1, "sync-state.json": SYNC_STATE });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V1);
    await runStorage(repository, "cleanup");

    await expect(readTasks(linked)).resolves.toBe(TASKS_V1);
    await withProjectStorage(linked, { mode: "write", scope: "shared-cache" }, async (storage) => {
      await storage.tasksStore.write(JSON.parse(TASKS_V2));
      await storage.stateStore.write(JSON.parse(SYNC_STATE));
    });
    await expect(readTasks(repository)).resolves.toBe(TASKS_V2);
    const status = await runStorage(repository, "status");
    expect(entriesOf(status)).toEqual([]);
    // 旧 CLI が legacy を再び書けば、記録済み fingerprint と異なるため fail-closed に戻る
    await writeLegacy(repository, { "tasks.json": TASKS_V2, "sync-state.json": SYNC_STATE });
    await expect(readTasks(repository)).rejects.toMatchObject({ code: "LEGACY_CACHE_DIVERGED" });
  });
});
