import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CommentsFileSchema,
  ConfigSchema,
  GANTT_DIR,
  SyncStateSchema,
  TasksFileWithConflictsSchema,
} from "@gh-gantt/shared";
import { z } from "zod";
import { CommentsStore } from "./comments.js";
import { ConfigStore } from "./config.js";
import { LoopStateStore } from "./loop-state.js";
import { SyncStateStore } from "./state.js";
import { TasksStore } from "./tasks.js";

const execFileAsync = promisify(execFile);
const LAYOUT_VERSION = "v1";
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 20;

type ProjectStorageSlot =
  | "config"
  | "workflow"
  | "tasks"
  | "sync-state"
  | "comments"
  | "loop-state"
  | "graph-contracts"
  | "run-graph";

type SharedSlot = "tasks" | "sync-state" | "comments";
type StorageScope = "shared-cache" | "workspace" | "all";

export interface ProjectStorageDependencies {
  processIdentity: { pid: number; hostname: string };
  isProcessAlive: (pid: number) => Promise<boolean>;
  runGit: (projectRoot: string, args: string[]) => Promise<string>;
}

export interface ProjectStorageOptions {
  mode: "read" | "write";
  scope?: StorageScope;
  waitTimeoutMs?: number;
  dependencies?: ProjectStorageDependencies;
  /** 分岐したlegacy cacheからoperatorが明示的に選ぶworktree root。 */
  legacySource?: string;
}

export interface ProjectStorageSession {
  readonly configStore: ConfigStore;
  readonly tasksStore: TasksStore;
  readonly stateStore: SyncStateStore;
  readonly commentsStore: CommentsStore;
  readonly loopStore: LoopStateStore;
  /** legacy cache migrationを含む共有cacheの初期化を明示的に開始する。 */
  ensureSharedCache(): Promise<void>;
  /** 長いremote操作の途中で、整合したsnapshot-setを明示的にpublishする。 */
  flush(): Promise<void>;
}

export class ProjectStorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectStorageError";
    this.code = code;
  }
}

export function createProjectStorageDependencies(
  overrides: Partial<ProjectStorageDependencies> = {},
): ProjectStorageDependencies {
  return {
    processIdentity: overrides.processIdentity ?? { pid: process.pid, hostname: hostname() },
    isProcessAlive:
      overrides.isProcessAlive ??
      (async (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }),
    runGit: overrides.runGit ?? runGit,
  };
}

interface GitLayout {
  kind: "git";
  projectRoot: string;
  topLevel: string;
  commonDir: string;
  relativeProjectRoot: string;
  worktrees: string[];
  projectIdentity: string;
  namespaceRoot: string;
  lockDir: string;
}

interface StandaloneLayout {
  kind: "standalone";
  projectRoot: string;
}

type StorageLayout = GitLayout | StandaloneLayout;

const LockOwnerSchema = z.object({
  schemaVersion: z.literal("1"),
  group: z.literal("work-graph-cache"),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  startedAt: z.string().datetime(),
  workspace: z.string().min(1),
  access: z.enum(["read", "write"]),
  nonce: z.string().min(1),
});

type LockOwner = z.infer<typeof LockOwnerSchema>;

interface LegacyCandidate {
  workspace: string;
  tasks: string;
  syncState: string;
  comments: string | null;
  fingerprint: string;
}

const MigrationManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  projectIdentity: z.string().min(1),
  selectedSource: z.string().min(1).nullable(),
  legacyFingerprints: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});

type MigrationManifest = z.infer<typeof MigrationManifestSchema>;

const CurrentGenerationSchema = z.string().regex(/^[0-9a-f-]{36}$/);

function isSharedSlot(slot: ProjectStorageSlot): slot is SharedSlot {
  return slot === "tasks" || slot === "sync-state" || slot === "comments";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseWorktreeList(output: string): string[] {
  return output
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
}

function isNotGitRepository(error: unknown): boolean {
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  return stderr.includes("not a git repository") || stderr.includes("not a git work tree");
}

function gitCommandEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // pre-push等のGit hookはrepository選択用envをexportすることがある。
  // projectRootを正本とするsubprocessへ継承すると、-Cよりenvが優先され別repositoryを操作し得る。
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

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: gitCommandEnvironment(),
    });
    return result.stdout.trim();
  } catch (error) {
    if (isNotGitRepository(error)) {
      throw new ProjectStorageError("NOT_A_GIT_REPOSITORY", "Git repository ではありません", {
        cause: error,
      });
    }
    throw new ProjectStorageError(
      "GIT_DISCOVERY_FAILED",
      `Git workspace の解決に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readProjectIdentity(projectRoot: string): Promise<string> {
  const configPath = join(projectRoot, GANTT_DIR, "gantt.config.json");
  try {
    const parsed = ConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    const github = parsed.project.github;
    return `${github.owner.trim().toLowerCase()}/${github.repo.trim().toLowerCase()}#${github.project_number}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectStorageError(
        "PROJECT_CONFIG_MISSING",
        `共有cacheのidentity解決に必要な設定がありません: ${configPath}`,
        { cause: error },
      );
    }
    throw new ProjectStorageError(
      "PROJECT_CONFIG_INVALID",
      `共有cacheのidentity解決に必要な設定が不正です: ${configPath}`,
      { cause: error },
    );
  }
}

async function resolveLayout(
  projectRoot: string,
  dependencies: ProjectStorageDependencies,
): Promise<StorageLayout> {
  // standalone fallback は従来の caller 指定 path を維持する。Git 管理下では
  // rev-parse / common-dir の結果だけを realpath して repository identity を揃える。
  const absoluteRoot = resolve(projectRoot);
  let topLevel: string;
  try {
    topLevel = await dependencies.runGit(absoluteRoot, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (error instanceof ProjectStorageError && error.code === "NOT_A_GIT_REPOSITORY") {
      return { kind: "standalone", projectRoot: absoluteRoot };
    }
    if (error instanceof ProjectStorageError) throw error;
    throw new ProjectStorageError(
      "GIT_DISCOVERY_FAILED",
      `Git workspace の解決に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let rawCommonDir: string;
  let worktreeOutput: string;
  try {
    rawCommonDir = await dependencies.runGit(absoluteRoot, ["rev-parse", "--git-common-dir"]);
    worktreeOutput = await dependencies.runGit(absoluteRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
  } catch (error) {
    if (error instanceof ProjectStorageError) throw error;
    throw new ProjectStorageError(
      "GIT_DISCOVERY_FAILED",
      `Git workspace の解決に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const gitProjectRoot = await realpath(absoluteRoot);
  const canonicalTopLevel = await realpath(topLevel);
  const commonDir = await realpath(
    isAbsolute(rawCommonDir) ? rawCommonDir : resolve(absoluteRoot, rawCommonDir),
  );
  const projectIdentity = await readProjectIdentity(gitProjectRoot);
  const projectKey = fingerprint(projectIdentity).slice(0, 32);
  const storageRoot = join(commonDir, "gh-gantt");
  return {
    kind: "git",
    projectRoot: gitProjectRoot,
    topLevel: canonicalTopLevel,
    commonDir,
    relativeProjectRoot: relative(canonicalTopLevel, gitProjectRoot),
    worktrees: parseWorktreeList(worktreeOutput),
    projectIdentity,
    namespaceRoot: join(storageRoot, "cache", "project-storage", LAYOUT_VERSION, projectKey),
    lockDir: join(storageRoot, "locks", "work-graph-cache.lock"),
  };
}

function workspacePath(projectRoot: string, slot: ProjectStorageSlot): string {
  const directory = join(projectRoot, GANTT_DIR);
  switch (slot) {
    case "config":
      return join(directory, "gantt.config.json");
    case "workflow":
      return join(directory, "workflow.md");
    case "tasks":
      return join(directory, "tasks.json");
    case "sync-state":
      return join(directory, "sync-state.json");
    case "comments":
      return join(directory, "comments.json");
    case "loop-state":
      return join(directory, "loop-state.json");
    case "graph-contracts":
      return join(directory, "run-graph", "contracts");
    case "run-graph":
      return join(directory, "run-graph", "runs");
  }
}

function sharedLocation(layout: GitLayout, slot: SharedSlot): string {
  if (slot === "comments") return join(layout.namespaceRoot, "comments.json");
  return join(layout.namespaceRoot, "current", `${slot}.json`);
}

function migrationPath(layout: GitLayout): string {
  return join(layout.namespaceRoot, "migration.json");
}

function currentPath(layout: GitLayout): string {
  return join(layout.namespaceRoot, "CURRENT");
}

async function readCurrentGeneration(layout: GitLayout): Promise<string | null> {
  const raw = await readOptional(currentPath(layout));
  if (raw === null) return null;
  const parsed = CurrentGenerationSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new ProjectStorageError("CACHE_CURRENT_INVALID", "CURRENT generation が不正です");
  }
  return parsed.data;
}

function generationPath(layout: GitLayout, generation: string, slot: "tasks" | "sync-state") {
  return join(layout.namespaceRoot, "snapshots", generation, `${slot}.json`);
}

async function acquireLease(
  layout: GitLayout,
  options: ProjectStorageOptions,
  dependencies: ProjectStorageDependencies,
): Promise<() => Promise<void>> {
  await mkdir(dirname(layout.lockDir), { recursive: true });
  const owner: LockOwner = {
    schemaVersion: "1",
    group: "work-graph-cache",
    pid: dependencies.processIdentity.pid,
    hostname: dependencies.processIdentity.hostname,
    startedAt: new Date().toISOString(),
    workspace: layout.projectRoot,
    access: options.mode,
    nonce: randomUUID(),
  };
  const deadline = Date.now() + (options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);

  while (true) {
    const candidate = `${layout.lockDir}.candidate-${owner.nonce}`;
    try {
      await mkdir(candidate);
      await writeFile(join(candidate, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
        flag: "wx",
      });
      await rename(candidate, layout.lockDir);
      break;
    } catch (error) {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      let existing: LockOwner | null = null;
      try {
        existing = LockOwnerSchema.parse(
          JSON.parse(await readFile(join(layout.lockDir, "owner.json"), "utf8")),
        );
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ProjectStorageError("CACHE_LOCK_INVALID", "lock owner record が不正です", {
            cause: ownerError,
          });
        }
      }

      if (existing && existing.hostname === dependencies.processIdentity.hostname) {
        const alive = await dependencies.isProcessAlive(existing.pid);
        if (!alive) {
          const confirmed = LockOwnerSchema.parse(
            JSON.parse(await readFile(join(layout.lockDir, "owner.json"), "utf8")),
          );
          if (confirmed.nonce === existing.nonce) {
            const recovered = `${layout.lockDir}.recovered-${existing.nonce}-${randomUUID()}`;
            try {
              await rename(layout.lockDir, recovered);
              await rm(recovered, { recursive: true, force: true });
              continue;
            } catch (recoveryError) {
              if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
            }
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new ProjectStorageError(
          "STORAGE_BUSY",
          `Work Graph Cache は別processが使用中です${existing ? ` (pid=${existing.pid}, host=${existing.hostname})` : ""}`,
        );
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }

  return async () => {
    let current: LockOwner;
    try {
      current = LockOwnerSchema.parse(
        JSON.parse(await readFile(join(layout.lockDir, "owner.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectStorageError("CACHE_LOCK_LOST", "解放対象のlockが見つかりません", {
          cause: error,
        });
      }
      throw error;
    }
    if (current.nonce !== owner.nonce) {
      throw new ProjectStorageError("CACHE_LOCK_LOST", "解放対象のlock nonceが一致しません");
    }

    // active path を直接再帰削除すると、空directoryになった瞬間に別processが
    // 新しいlockへ置換し、そのlockまで削除し得る。nonce固有pathへatomicに退避してから掃除する。
    const retired = `${layout.lockDir}.retired-${owner.nonce}-${randomUUID()}`;
    try {
      await rename(layout.lockDir, retired);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectStorageError("CACHE_LOCK_LOST", "解放中にlockを失いました", {
          cause: error,
        });
      }
      throw error;
    }
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
  };
}

async function readCandidate(
  layout: GitLayout,
  workspace: string,
): Promise<LegacyCandidate | null> {
  const root = join(workspace, layout.relativeProjectRoot);
  const directory = join(root, GANTT_DIR);
  const [tasks, syncState] = await Promise.all([
    readOptional(join(directory, "tasks.json")),
    readOptional(join(directory, "sync-state.json")),
  ]);
  if (tasks === null && syncState === null) return null;

  let candidateIdentity: string;
  try {
    candidateIdentity = await readProjectIdentity(root);
  } catch (error) {
    throw new ProjectStorageError(
      "LEGACY_CACHE_INVALID",
      `legacy cache の project identity を検証できません: ${root}`,
      { cause: error },
    );
  }
  if (candidateIdentity !== layout.projectIdentity) return null;
  if (tasks === null || syncState === null) {
    throw new ProjectStorageError(
      "LEGACY_CACHE_INCOMPLETE",
      `legacy tasks/sync-state の片方だけが存在します: ${root}`,
    );
  }

  try {
    const parsedTasks = TasksFileWithConflictsSchema.parse(JSON.parse(tasks));
    const parsedState = SyncStateSchema.parse(JSON.parse(syncState));
    const legacyComments = await readOptional(join(directory, "comments.json"));
    let comments: string | null = null;
    if (legacyComments !== null) {
      // comments はmerge baseではなく再構築可能なcacheなので、legacy破損時は
      // tasks/sync-state migrationを止めず欠損として扱う。
      const parsedComments = CommentsFileSchema.safeParse(
        (() => {
          try {
            return JSON.parse(legacyComments);
          } catch {
            return undefined;
          }
        })(),
      );
      if (parsedComments.success) comments = legacyComments;
    }
    return {
      workspace: root,
      tasks,
      syncState,
      comments,
      fingerprint: fingerprint({ tasks: parsedTasks, syncState: parsedState }),
    };
  } catch (error) {
    throw new ProjectStorageError("LEGACY_CACHE_INVALID", `legacy cache が不正です: ${root}`, {
      cause: error,
    });
  }
}

async function collectLegacyCandidates(layout: GitLayout): Promise<LegacyCandidate[]> {
  const candidates = await Promise.all(
    [...layout.worktrees].sort().map((worktree) => readCandidate(layout, worktree)),
  );
  return candidates.filter((candidate): candidate is LegacyCandidate => candidate !== null);
}

async function publishSnapshot(layout: GitLayout, tasks: string, syncState: string): Promise<void> {
  try {
    TasksFileWithConflictsSchema.parse(JSON.parse(tasks));
    SyncStateSchema.parse(JSON.parse(syncState));
  } catch (error) {
    throw new ProjectStorageError("CACHE_SNAPSHOT_INVALID", "snapshot-set が不正です", {
      cause: error,
    });
  }
  const generation = randomUUID();
  const directory = join(layout.namespaceRoot, "snapshots", generation);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "tasks.json"), tasks, { flag: "wx" }),
    writeFile(join(directory, "sync-state.json"), syncState, { flag: "wx" }),
  ]);
  await writeAtomic(currentPath(layout), `${generation}\n`);
}

async function selectLegacyCandidate(
  layout: GitLayout,
  candidates: LegacyCandidate[],
  source: string,
): Promise<LegacyCandidate> {
  const canonicalSource = await realpath(resolve(source));
  const acceptedSources = new Set([canonicalSource]);
  if (layout.relativeProjectRoot !== "") {
    try {
      acceptedSources.add(await realpath(join(canonicalSource, layout.relativeProjectRoot)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const candidate of candidates) {
    if (acceptedSources.has(await realpath(candidate.workspace))) return candidate;
  }
  throw new ProjectStorageError(
    "LEGACY_SOURCE_NOT_FOUND",
    `指定したworktreeにlegacy cacheがありません: ${source}`,
  );
}

async function writeMigrationManifest(
  layout: GitLayout,
  candidates: LegacyCandidate[],
  selectedSource: string | null,
): Promise<void> {
  const migration: MigrationManifest = {
    schemaVersion: "1",
    projectIdentity: layout.projectIdentity,
    selectedSource,
    legacyFingerprints: Object.fromEntries(
      candidates.map((candidate) => [candidate.workspace, candidate.fingerprint]),
    ),
  };
  await writeAtomic(migrationPath(layout), `${JSON.stringify(migration, null, 2)}\n`);
}

async function publishLegacyCandidate(
  layout: GitLayout,
  candidate: LegacyCandidate,
  candidates: LegacyCandidate[],
): Promise<void> {
  await publishSnapshot(layout, candidate.tasks, candidate.syncState);
  if (candidate.comments !== null) {
    await writeAtomic(join(layout.namespaceRoot, "comments.json"), candidate.comments);
  }
  await writeMigrationManifest(layout, candidates, candidate.workspace);
}

async function migrateLegacy(layout: GitLayout, legacySource?: string): Promise<void> {
  const generation = await readCurrentGeneration(layout);
  const candidates = await collectLegacyCandidates(layout);
  const manifestRaw = await readOptional(migrationPath(layout));
  let manifest: MigrationManifest | null = null;
  if (manifestRaw !== null) {
    try {
      manifest = MigrationManifestSchema.parse(JSON.parse(manifestRaw));
    } catch (error) {
      throw new ProjectStorageError("MIGRATION_MANIFEST_INVALID", "migration manifest が不正です", {
        cause: error,
      });
    }
  }

  if (generation !== null) {
    if (candidates.length === 0) {
      if (legacySource) {
        throw new ProjectStorageError(
          "LEGACY_SOURCE_NOT_FOUND",
          `指定したworktreeにlegacy cacheがありません: ${legacySource}`,
        );
      }
      return;
    }
    if (legacySource) {
      await publishLegacyCandidate(
        layout,
        await selectLegacyCandidate(layout, candidates, legacySource),
        candidates,
      );
      return;
    }
    if (!manifest) {
      throw new ProjectStorageError(
        "LEGACY_CACHE_DIVERGED",
        "共有cache作成後に記録のないlegacy cacheが見つかりました",
      );
    }
    for (const candidate of candidates) {
      if (manifest.legacyFingerprints[candidate.workspace] !== candidate.fingerprint) {
        throw new ProjectStorageError(
          "LEGACY_CACHE_DIVERGED",
          `migration後にlegacy cacheが変更されました: ${candidate.workspace}。` +
            "gh-gantt storage migrate --from <worktree> で正本を明示してください",
        );
      }
    }
    return;
  }

  if (candidates.length === 0) {
    if (legacySource) {
      throw new ProjectStorageError(
        "LEGACY_SOURCE_NOT_FOUND",
        `指定したworktreeにlegacy cacheがありません: ${legacySource}`,
      );
    }
    return;
  }
  const expected = candidates[0].fingerprint;
  if (candidates.some((candidate) => candidate.fingerprint !== expected)) {
    if (legacySource) {
      await publishLegacyCandidate(
        layout,
        await selectLegacyCandidate(layout, candidates, legacySource),
        candidates,
      );
      return;
    }
    throw new ProjectStorageError(
      "LEGACY_CACHE_DIVERGED",
      `worktree間でlegacy cacheが分岐しています: ${candidates.map((item) => item.workspace).join(", ")}。` +
        "gh-gantt storage migrate --from <worktree> で正本を明示してください",
    );
  }

  await publishLegacyCandidate(layout, candidates[0], candidates);
}

class BoundStorageSession {
  private readonly staged = new Map<ProjectStorageSlot, string>();

  constructor(
    private readonly layout: StorageLayout,
    private readonly options: ProjectStorageOptions,
  ) {}

  async location(slot: ProjectStorageSlot): Promise<string> {
    if (this.layout.kind === "git" && isSharedSlot(slot)) {
      return sharedLocation(this.layout, slot);
    }
    return workspacePath(this.layout.projectRoot, slot);
  }

  async readText(slot: ProjectStorageSlot): Promise<string | null> {
    if (this.staged.has(slot)) return this.staged.get(slot) ?? null;
    if (this.layout.kind === "git" && (slot === "tasks" || slot === "sync-state")) {
      const generation = await readCurrentGeneration(this.layout);
      if (generation === null) return null;
      return readOptional(generationPath(this.layout, generation, slot));
    }
    return readOptional(await this.location(slot));
  }

  async writeText(slot: ProjectStorageSlot, content: string): Promise<void> {
    if (this.options.mode !== "write") {
      throw new ProjectStorageError("STORAGE_SCOPE_VIOLATION", "read scopeでは書き込めません");
    }
    const scope = this.options.scope ?? "workspace";
    const allowed =
      scope === "all" || (isSharedSlot(slot) ? scope === "shared-cache" : scope === "workspace");
    if (!allowed) {
      throw new ProjectStorageError(
        "STORAGE_SCOPE_VIOLATION",
        `${scope} scopeから${slot}へは書き込めません`,
      );
    }
    this.staged.set(slot, content);
  }

  async commit(): Promise<void> {
    if (this.options.mode !== "write" || this.staged.size === 0) return;
    if (this.layout.kind === "standalone") {
      await Promise.all(
        [...this.staged].map(([slot, content]) =>
          writeAtomic(workspacePath(this.layout.projectRoot, slot), content),
        ),
      );
      this.staged.clear();
      return;
    }

    const sharedDirty = this.staged.has("tasks") || this.staged.has("sync-state");
    if (sharedDirty) {
      const [tasks, syncState] = await Promise.all([
        this.readText("tasks"),
        this.readText("sync-state"),
      ]);
      if (tasks === null || syncState === null) {
        throw new ProjectStorageError(
          "CACHE_SNAPSHOT_INCOMPLETE",
          "tasksとsync-stateは同じsnapshot-setとして必要です",
        );
      }
      await publishSnapshot(this.layout, tasks, syncState);
    }
    if (this.staged.has("comments")) {
      const comments = this.staged.get("comments")!;
      try {
        CommentsFileSchema.parse(JSON.parse(comments));
      } catch (error) {
        throw new ProjectStorageError("CACHE_COMMENTS_INVALID", "comments cacheが不正です", {
          cause: error,
        });
      }
      await writeAtomic(sharedLocation(this.layout, "comments"), comments);
    }
    if ((await readOptional(migrationPath(this.layout))) === null) {
      const manifest: MigrationManifest = {
        schemaVersion: "1",
        projectIdentity: this.layout.projectIdentity,
        selectedSource: null,
        legacyFingerprints: {},
      };
      await writeAtomic(migrationPath(this.layout), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    this.staged.clear();
  }

  async flush(): Promise<void> {
    await this.commit();
  }
}

interface InitializedStorage {
  bound: BoundStorageSession;
  release: () => Promise<void>;
}

class LazyProjectStorageSession implements ProjectStorageSession {
  readonly configStore: ConfigStore;
  readonly tasksStore: TasksStore;
  readonly stateStore: SyncStateStore;
  readonly commentsStore: CommentsStore;
  readonly loopStore: LoopStateStore;
  private initialized: Promise<InitializedStorage> | null = null;
  private readonly workspace: BoundStorageSession;

  constructor(
    private readonly projectRoot: string,
    private readonly options: ProjectStorageOptions,
    private readonly dependencies: ProjectStorageDependencies,
  ) {
    const binding = {
      readText: (slot: ProjectStorageSlot) => this.readText(slot),
      writeText: (slot: ProjectStorageSlot, content: string) => this.writeText(slot, content),
    };
    this.workspace = new BoundStorageSession(
      { kind: "standalone", projectRoot: resolve(projectRoot) },
      options,
    );
    this.configStore = new ConfigStore(binding);
    this.tasksStore = new TasksStore(binding);
    this.stateStore = new SyncStateStore(binding);
    this.commentsStore = new CommentsStore(binding);
    this.loopStore = new LoopStateStore(binding);
  }

  private async initialize(): Promise<InitializedStorage> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const layout = await resolveLayout(this.projectRoot, this.dependencies);
      const release =
        layout.kind === "git"
          ? await acquireLease(layout, this.options, this.dependencies)
          : async () => undefined;
      try {
        if (layout.kind === "git") await migrateLegacy(layout, this.options.legacySource);
        return { bound: new BoundStorageSession(layout, this.options), release };
      } catch (error) {
        await release();
        throw error;
      }
    })();
    return this.initialized;
  }

  async ensureSharedCache(): Promise<void> {
    await this.initialize();
  }

  private async readText(slot: ProjectStorageSlot): Promise<string | null> {
    if (!isSharedSlot(slot)) return this.workspace.readText(slot);
    return (await this.initialize()).bound.readText(slot);
  }

  private async writeText(slot: ProjectStorageSlot, content: string): Promise<void> {
    if (!isSharedSlot(slot)) return this.workspace.writeText(slot, content);
    return (await this.initialize()).bound.writeText(slot, content);
  }

  async flush(): Promise<void> {
    await this.workspace.flush();
    if (this.initialized) await (await this.initialized).bound.flush();
  }

  async finish(): Promise<void> {
    await this.workspace.flush();
    if (this.initialized) await (await this.initialized).bound.flush();
  }

  async close(): Promise<void> {
    if (this.initialized) await (await this.initialized).release();
  }
}

export async function withProjectStorage<T>(
  projectRoot: string,
  options: ProjectStorageOptions,
  callback: (storage: ProjectStorageSession) => Promise<T>,
): Promise<T> {
  const dependencies = options.dependencies ?? createProjectStorageDependencies();
  const session = new LazyProjectStorageSession(projectRoot, options, dependencies);
  try {
    const result = await callback(session);
    await session.finish();
    return result;
  } finally {
    await session.close();
  }
}
