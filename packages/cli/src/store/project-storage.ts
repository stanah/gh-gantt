import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CommentsFileSchema,
  ConfigSchema,
  GANTT_DIR,
  RUN_GRAPH_DIR,
  SyncStateSchema,
  TasksFileWithConflictsSchema,
} from "@gh-gantt/shared";
import { z } from "zod";
import { CommentsStore } from "./comments.js";
import { ConfigStore } from "./config.js";
import { LoopStateStore } from "./loop-state.js";
import { SyncStateStore } from "./state.js";
import { TasksStore } from "./tasks.js";
import { cachedRevParse, cachedWorktreeList } from "./repository-coordination-layout.js";
import {
  detectWorkspaceStorageLocation,
  ProjectStorageError,
  workspaceSlotPath,
  type StorageMode,
  type WorkspaceStorageLocation,
} from "./storage-location.js";
import { gitCommandEnvironment, isNotGitRepositoryError } from "../util/git-errors.js";
import {
  hasGitMarkerInAncestors,
  notGitRepositoryError,
  resolveGitExecutable,
} from "../util/git-executable.js";

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
  /**
   * config / workflow / journal の配置モードを明示する (#379)。
   * 既存 config と矛盾する指定は fail-closed になる。省略時は既存 config から検出する。
   */
  storageMode?: StorageMode;
}

/** `storage status` 等が表示する、解決済みの配置。physical path は表示専用で caller は組み立てない。 */
export interface ProjectStorageDescription {
  mode: StorageMode;
  projectRoot: string;
  gitCommonDir: string | null;
  paths: {
    config: string;
    workflow: string;
    loopState: string;
    runGraph: string;
    /** repository モードの `.gantt-sync`。git モードでは legacy 確認用。 */
    repositoryDir: string;
    gitConfigDir: string | null;
    gitJournalDir: string | null;
  };
  /** Work Graph Cache の配置。config が無く identity を解決できない場合は null。 */
  sharedCacheRoot: string | null;
  /** 各 worktree に残る legacy cache の状態 (#378)。non-git、または identity 未解決なら null。 */
  legacy: LegacyCacheInspection | null;
}

export type LegacyCacheState =
  | "recorded"
  | "diverged"
  | "unrecorded"
  | "incomplete"
  | "invalid"
  | "other-project";

/** `<worktree>/.gantt-sync/` に残る移行前の Work Graph Cache 一組の状態。 */
export interface LegacyCacheEntry {
  /** legacy cache を持つ project root。 */
  workspace: string;
  /** 実在する legacy file の絶対 path (tasks.json / sync-state.json / comments.json)。 */
  files: string[];
  fingerprint: string | null;
  recordedFingerprint: string | null;
  state: LegacyCacheState;
  /** 表示用の理由。削除できない entry の根拠を示す。 */
  reason: string;
}

export interface LegacyCacheInspection {
  /** migration manifest が存在するか (共有 cache が一度も publish されていなければ false)。 */
  manifest: boolean;
  entries: LegacyCacheEntry[];
}

export interface LegacyCleanupOptions {
  dryRun: boolean;
}

export interface LegacyCleanupReport {
  dryRun: boolean;
  entries: Array<LegacyCacheEntry & { action: "deleted" | "planned" | "skipped" }>;
}

export interface StorageRelocationReport {
  changed: boolean;
  from: StorageMode;
  to: StorageMode;
  moved: Array<{ slot: string; from: string; to: string }>;
}

export interface ProjectStorageSession {
  readonly configStore: ConfigStore;
  readonly tasksStore: TasksStore;
  readonly stateStore: SyncStateStore;
  readonly commentsStore: CommentsStore;
  readonly loopStore: LoopStateStore;
  /** legacy cache migrationを含む共有cacheの初期化を明示的に開始する。 */
  ensureSharedCache(): Promise<void>;
  /** 配置モードと解決済み path を返す。lease は取得しない。 */
  describeStorage(): Promise<ProjectStorageDescription>;
  /**
   * config / workflow / journal を別モードへ移す (#379)。repository lease 内で実行し、
   * 移行元と移行先を migration manifest に記録する。
   */
  relocateStorage(target: StorageMode): Promise<StorageRelocationReport>;
  /**
   * 移行済みの legacy cache を削除する (#378)。migration manifest の fingerprint と一致する
   * pair だけを対象にし、一致しない pair は理由付きで残す。`dryRun` は削除せず計画だけ返す。
   */
  cleanupLegacyCache(options: LegacyCleanupOptions): Promise<LegacyCleanupReport>;
  /** 長いremote操作の途中で、整合したsnapshot-setを明示的にpublishする。 */
  flush(): Promise<void>;
}

export { ProjectStorageError } from "./storage-location.js";
export type { StorageMode, WorkspaceStorageLocation } from "./storage-location.js";

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

interface GitDiscovery {
  topLevel: string;
  commonDir: string;
  relativeProjectRoot: string;
  worktrees: string[];
}

/** Git discovery と配置モードまで解決した workspace。identity と lease はまだ持たない。 */
interface WorkspaceLayout {
  projectRoot: string;
  git: GitDiscovery | null;
  location: WorkspaceStorageLocation;
}

interface GitLayout {
  kind: "git";
  projectRoot: string;
  topLevel: string;
  commonDir: string;
  relativeProjectRoot: string;
  worktrees: string[];
  location: WorkspaceStorageLocation;
  projectIdentity: string;
  namespaceRoot: string;
  lockDir: string;
}

/** workspace slot、または non-git 縮退時の全 slot を location の path で読み書きする。 */
interface WorkspaceBoundLayout {
  kind: "workspace";
  projectRoot: string;
  location: WorkspaceStorageLocation;
}

type StorageLayout = GitLayout | WorkspaceBoundLayout;

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

const RecoveryClaimSchema = z.object({
  schemaVersion: z.literal("1"),
  expectedOwnerNonce: z.string().min(1),
  claimant: z.object({
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    nonce: z.string().min(1),
    claimedAt: z.string().datetime(),
  }),
});

type RecoveryClaim = z.infer<typeof RecoveryClaimSchema>;

interface LegacyCandidate {
  workspace: string;
  tasks: string;
  syncState: string;
  comments: string | null;
  fingerprint: string;
}

const StorageRelocationRecordSchema = z.object({
  workspace: z.string().min(1),
  from: z.enum(["repository", "git"]),
  to: z.enum(["repository", "git"]),
  relocatedAt: z.string().datetime(),
  moved: z.array(
    z.object({ slot: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }),
  ),
});

const MigrationManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  projectIdentity: z.string().min(1),
  selectedSource: z.string().min(1).nullable(),
  legacyFingerprints: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  /** 配置モードの移行履歴 (#379)。旧 manifest には無い。 */
  storageRelocations: z.array(StorageRelocationRecordSchema).optional(),
  /** legacy cache の削除履歴 (#378)。旧 manifest には無い。 */
  legacyCleanups: z
    .array(
      z.object({
        workspace: z.string().min(1),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        deletedAt: z.string().datetime(),
        files: z.array(z.string().min(1)),
      }),
    )
    .optional(),
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

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  try {
    // Git 管理外の root は git を起動せずに判定する (#353)
    if (!hasGitMarkerInAncestors(projectRoot)) throw notGitRepositoryError(projectRoot);
    const result = await execFileAsync(resolveGitExecutable(), ["-C", projectRoot, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: gitCommandEnvironment(),
    });
    return result.stdout.trim();
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
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

async function readProjectIdentity(configPath: string): Promise<string> {
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

async function discoverGit(
  projectRoot: string,
  dependencies: ProjectStorageDependencies,
): Promise<{ projectRoot: string; git: GitDiscovery | null }> {
  // non-git は従来の caller 指定 path を維持する。Git 管理下では
  // rev-parse / common-dir の結果だけを realpath して repository identity を揃える。
  // toplevel / common-dir / worktree 一覧は root ごとに cache し git の起動を減らす (#353, #355)。
  const absoluteRoot = resolve(projectRoot);
  let topLevel: string;
  try {
    topLevel = await cachedRevParse(dependencies.runGit, absoluteRoot, "--show-toplevel");
  } catch (error) {
    if (error instanceof ProjectStorageError && error.code === "NOT_A_GIT_REPOSITORY") {
      return { projectRoot: absoluteRoot, git: null };
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
    rawCommonDir = await cachedRevParse(dependencies.runGit, absoluteRoot, "--git-common-dir");
    worktreeOutput = await cachedWorktreeList(
      dependencies.runGit,
      absoluteRoot,
      isAbsolute(rawCommonDir) ? rawCommonDir : resolve(absoluteRoot, rawCommonDir),
    );
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
  return {
    projectRoot: gitProjectRoot,
    git: {
      topLevel: canonicalTopLevel,
      commonDir,
      relativeProjectRoot: relative(canonicalTopLevel, gitProjectRoot),
      worktrees: parseWorktreeList(worktreeOutput),
    },
  };
}

async function resolveWorkspaceLayout(
  projectRoot: string,
  dependencies: ProjectStorageDependencies,
  explicitMode?: StorageMode,
): Promise<WorkspaceLayout> {
  const discovered = await discoverGit(projectRoot, dependencies);
  const location = await detectWorkspaceStorageLocation(
    {
      projectRoot: discovered.projectRoot,
      git: discovered.git
        ? {
            commonDir: discovered.git.commonDir,
            relativeProjectRoot: discovered.git.relativeProjectRoot,
          }
        : null,
    },
    { explicit: explicitMode },
  );
  return { projectRoot: discovered.projectRoot, git: discovered.git, location };
}

/**
 * project の workspace 配置 (モード、config / journal directory) を解決する。
 *
 * `withProjectStorage` を通らない Run Graph store 等が、journal の物理 path を
 * caller ごとに組み立てずに同じ解決順序へ従うための入口。lease は取得しない。
 */
export async function resolveWorkspaceStorageLocation(
  projectRoot: string,
  dependencies: ProjectStorageDependencies = createProjectStorageDependencies(),
): Promise<WorkspaceStorageLocation> {
  return (await resolveWorkspaceLayout(projectRoot, dependencies)).location;
}

function sharedNamespace(git: GitDiscovery, projectIdentity: string) {
  const projectKey = fingerprint(projectIdentity).slice(0, 32);
  const storageRoot = join(git.commonDir, "gh-gantt");
  return {
    namespaceRoot: join(storageRoot, "cache", "project-storage", LAYOUT_VERSION, projectKey),
    lockDir: join(storageRoot, "locks", "work-graph-cache.lock"),
  };
}

async function resolveSharedLayout(workspace: WorkspaceLayout): Promise<StorageLayout> {
  if (workspace.git === null) {
    return { kind: "workspace", projectRoot: workspace.projectRoot, location: workspace.location };
  }
  const projectIdentity = await readProjectIdentity(
    workspaceSlotPath(workspace.location, "config"),
  );
  return {
    kind: "git",
    projectRoot: workspace.projectRoot,
    topLevel: workspace.git.topLevel,
    commonDir: workspace.git.commonDir,
    relativeProjectRoot: workspace.git.relativeProjectRoot,
    worktrees: workspace.git.worktrees,
    location: workspace.location,
    projectIdentity,
    ...sharedNamespace(workspace.git, projectIdentity),
  };
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

      let recoveryClaim: RecoveryClaim | null = null;
      try {
        const rawClaim = await readOptional(join(layout.lockDir, "recovery-claim.json"));
        if (rawClaim !== null) {
          recoveryClaim = RecoveryClaimSchema.parse(JSON.parse(rawClaim));
        }
      } catch (claimError) {
        throw new ProjectStorageError("CACHE_LOCK_INVALID", "lock recovery claim が不正です", {
          cause: claimError,
        });
      }

      if (
        existing &&
        recoveryClaim === null &&
        existing.hostname === dependencies.processIdentity.hostname
      ) {
        const alive = await dependencies.isProcessAlive(existing.pid);
        if (!alive) {
          const claim: RecoveryClaim = {
            schemaVersion: "1",
            expectedOwnerNonce: existing.nonce,
            claimant: {
              pid: owner.pid,
              hostname: owner.hostname,
              nonce: owner.nonce,
              claimedAt: new Date().toISOString(),
            },
          };
          try {
            await writeFile(
              join(layout.lockDir, "recovery-claim.json"),
              `${JSON.stringify(claim, null, 2)}\n`,
              { flag: "wx" },
            );
            const confirmed = LockOwnerSchema.parse(
              JSON.parse(await readFile(join(layout.lockDir, "owner.json"), "utf8")),
            );
            if (confirmed.nonce === claim.expectedOwnerNonce) {
              const recovered = `${layout.lockDir}.recovered-${existing.nonce}-${randomUUID()}`;
              await rename(layout.lockDir, recovered);
              await rm(recovered, { recursive: true, force: true });
              continue;
            }
          } catch (recoveryError) {
            const recoveryCode = (recoveryError as NodeJS.ErrnoException).code;
            if (
              recoveryCode !== "ENOENT" &&
              recoveryCode !== "EEXIST" &&
              recoveryCode !== "ENOTEMPTY"
            ) {
              throw recoveryError;
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
    candidateIdentity = await readProjectIdentity(join(directory, "gantt.config.json"));
  } catch (error) {
    // git モードでは config が worktree に無いのが正常なので、共有 config の identity を使う。
    // repository モードでは従来どおり config の無い legacy pair を fail-closed にする。
    if (
      layout.location.mode === "git" &&
      error instanceof ProjectStorageError &&
      error.code === "PROJECT_CONFIG_MISSING"
    ) {
      candidateIdentity = layout.projectIdentity;
    } else {
      throw new ProjectStorageError(
        "LEGACY_CACHE_INVALID",
        `legacy cache の project identity を検証できません: ${root}`,
        { cause: error },
      );
    }
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

const LEGACY_FILES = ["tasks.json", "sync-state.json", "comments.json"] as const;

/**
 * 全 worktree の legacy cache を migration manifest と照合し、削除可否を判定する (#378)。
 * fail-closed にはせず、各 worktree の状態と理由を返す。
 */
async function inspectLegacy(layout: GitLayout): Promise<LegacyCacheInspection> {
  const manifest = await readMigrationManifest(layout);
  const entries: LegacyCacheEntry[] = [];
  for (const worktree of [...layout.worktrees].sort()) {
    const root = join(worktree, layout.relativeProjectRoot);
    const directory = join(root, GANTT_DIR);
    const files: string[] = [];
    for (const name of LEGACY_FILES) {
      if ((await readOptional(join(directory, name))) !== null) files.push(join(directory, name));
    }
    if (files.length === 0) continue;
    let candidate: LegacyCandidate | null;
    try {
      candidate = await readCandidate(layout, worktree);
    } catch (error) {
      const code = error instanceof ProjectStorageError ? error.code : "LEGACY_CACHE_INVALID";
      entries.push({
        workspace: root,
        files,
        fingerprint: null,
        recordedFingerprint: null,
        state: code === "LEGACY_CACHE_INCOMPLETE" ? "incomplete" : "invalid",
        reason:
          code === "LEGACY_CACHE_INCOMPLETE"
            ? "tasks.json と sync-state.json の片方だけが存在するため fingerprint を計算できません"
            : `legacy cache を検証できません: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (candidate === null) {
      entries.push({
        workspace: root,
        files,
        fingerprint: null,
        recordedFingerprint: null,
        state: "other-project",
        reason: "別の GitHub Project の cache のため、この namespace からは削除しません",
      });
      continue;
    }
    const recorded = manifest?.legacyFingerprints[candidate.workspace] ?? null;
    if (recorded === null) {
      entries.push({
        workspace: candidate.workspace,
        files,
        fingerprint: candidate.fingerprint,
        recordedFingerprint: null,
        state: "unrecorded",
        reason: manifest
          ? "migration manifest に記録がありません。gh-gantt storage migrate --from <worktree> で正本を明示してください"
          : "共有 cache がまだ publish されていません。先に gh-gantt pull を実行してください",
      });
      continue;
    }
    if (recorded !== candidate.fingerprint) {
      entries.push({
        workspace: candidate.workspace,
        files,
        fingerprint: candidate.fingerprint,
        recordedFingerprint: recorded,
        state: "diverged",
        reason:
          "migration 後に legacy cache が変更されています。gh-gantt storage migrate --from <worktree> で正本を明示してください",
      });
      continue;
    }
    entries.push({
      workspace: candidate.workspace,
      files,
      fingerprint: candidate.fingerprint,
      recordedFingerprint: recorded,
      state: "recorded",
      reason: "migration manifest の fingerprint と一致しており、共有 cache へ移行済みです",
    });
  }
  return { manifest: manifest !== null, entries };
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

async function readMigrationManifest(layout: GitLayout): Promise<MigrationManifest | null> {
  const manifestRaw = await readOptional(migrationPath(layout));
  if (manifestRaw === null) return null;
  try {
    return MigrationManifestSchema.parse(JSON.parse(manifestRaw));
  } catch (error) {
    throw new ProjectStorageError("MIGRATION_MANIFEST_INVALID", "migration manifest が不正です", {
      cause: error,
    });
  }
}

async function saveMigrationManifest(layout: GitLayout, manifest: MigrationManifest) {
  await writeAtomic(migrationPath(layout), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeMigrationManifest(
  layout: GitLayout,
  candidates: LegacyCandidate[],
  selectedSource: string | null,
): Promise<void> {
  const previous = await readMigrationManifest(layout);
  const migration: MigrationManifest = {
    schemaVersion: "1",
    projectIdentity: layout.projectIdentity,
    selectedSource,
    legacyFingerprints: Object.fromEntries(
      candidates.map((candidate) => [candidate.workspace, candidate.fingerprint]),
    ),
    ...(previous?.storageRelocations ? { storageRelocations: previous.storageRelocations } : {}),
    ...(previous?.legacyCleanups ? { legacyCleanups: previous.legacyCleanups } : {}),
  };
  await saveMigrationManifest(layout, migration);
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
  const manifest = await readMigrationManifest(layout);

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
    return workspaceSlotPath(this.layout.location, slot);
  }

  async readText(slot: ProjectStorageSlot): Promise<string | null> {
    if (this.staged.has(slot)) return this.staged.get(slot) ?? null;
    if (this.layout.kind === "git" && (slot === "tasks" || slot === "sync-state")) {
      const generation = await readCurrentGeneration(this.layout);
      if (generation === null) return null;
      const content = await readOptional(generationPath(this.layout, generation, slot));
      if (content === null) {
        throw new ProjectStorageError(
          "CACHE_SNAPSHOT_INCOMPLETE",
          `CURRENT generation ${generation} に ${slot}.json がありません`,
        );
      }
      return content;
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
    if (this.layout.kind === "workspace") {
      const location = this.layout.location;
      await Promise.all(
        [...this.staged].map(([slot, content]) =>
          writeAtomic(workspaceSlotPath(location, slot), content),
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
    if ((await readMigrationManifest(this.layout)) === null) {
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
  layout: StorageLayout;
  release: () => Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 同一 filesystem では rename、跨ぐ場合は copy してから削除する。 */
async function movePath(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

async function removeIfEmpty(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

class LazyProjectStorageSession implements ProjectStorageSession {
  readonly configStore: ConfigStore;
  readonly tasksStore: TasksStore;
  readonly stateStore: SyncStateStore;
  readonly commentsStore: CommentsStore;
  readonly loopStore: LoopStateStore;
  private workspaceLayout: Promise<WorkspaceLayout> | null = null;
  private workspaceBound: Promise<BoundStorageSession> | null = null;
  private initialized: Promise<InitializedStorage> | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly options: ProjectStorageOptions,
    private readonly dependencies: ProjectStorageDependencies,
  ) {
    const binding = {
      readText: (slot: ProjectStorageSlot) => this.readText(slot),
      writeText: (slot: ProjectStorageSlot, content: string) => this.writeText(slot, content),
    };
    this.configStore = new ConfigStore(binding);
    this.tasksStore = new TasksStore(binding);
    this.stateStore = new SyncStateStore(binding);
    this.commentsStore = new CommentsStore(binding);
    this.loopStore = new LoopStateStore(binding);
  }

  /** Git discovery と配置モードの解決。lease は取らず、shared slot に触れない caller でも使える。 */
  private resolveWorkspace(): Promise<WorkspaceLayout> {
    if (!this.workspaceLayout) {
      this.workspaceLayout = resolveWorkspaceLayout(
        this.projectRoot,
        this.dependencies,
        this.options.storageMode,
      );
    }
    return this.workspaceLayout;
  }

  private workspace(): Promise<BoundStorageSession> {
    if (!this.workspaceBound) {
      this.workspaceBound = this.resolveWorkspace().then(
        (workspace) =>
          new BoundStorageSession(
            { kind: "workspace", projectRoot: workspace.projectRoot, location: workspace.location },
            this.options,
          ),
      );
    }
    return this.workspaceBound;
  }

  private async initialize(
    options: { skipLegacyMigration?: boolean } = {},
  ): Promise<InitializedStorage> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const layout = await resolveSharedLayout(await this.resolveWorkspace());
      if (layout.kind === "workspace") {
        // non-git は shared slot も同じ workspace session で `.gantt-sync/` へ縮退する。
        return { bound: await this.workspace(), layout, release: async () => undefined };
      }
      const release = await acquireLease(layout, this.options, this.dependencies);
      try {
        // cleanup は分岐した legacy を fail-closed にせず個別に判定するため migration を飛ばす
        if (!options.skipLegacyMigration) await migrateLegacy(layout, this.options.legacySource);
        return { bound: new BoundStorageSession(layout, this.options), layout, release };
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

  async describeStorage(): Promise<ProjectStorageDescription> {
    const workspace = await this.resolveWorkspace();
    const location = workspace.location;
    let sharedCacheRoot: string | null = location.repositoryDir;
    let legacy: LegacyCacheInspection | null = null;
    if (workspace.git !== null) {
      try {
        const layout = await resolveSharedLayout(workspace);
        if (layout.kind === "git") {
          sharedCacheRoot = layout.namespaceRoot;
          legacy = await inspectLegacy(layout);
        }
      } catch (error) {
        if (!(error instanceof ProjectStorageError && error.code === "PROJECT_CONFIG_MISSING")) {
          throw error;
        }
        sharedCacheRoot = null;
      }
    }
    return {
      mode: location.mode,
      projectRoot: workspace.projectRoot,
      gitCommonDir: workspace.git?.commonDir ?? null,
      paths: {
        config: workspaceSlotPath(location, "config"),
        workflow: workspaceSlotPath(location, "workflow"),
        loopState: workspaceSlotPath(location, "loop-state"),
        runGraph: join(location.journalDir, RUN_GRAPH_DIR),
        repositoryDir: location.repositoryDir,
        gitConfigDir: location.gitConfigDir,
        gitJournalDir: location.gitJournalDir,
      },
      sharedCacheRoot,
      legacy,
    };
  }

  async cleanupLegacyCache(options: LegacyCleanupOptions): Promise<LegacyCleanupReport> {
    if (!options.dryRun && this.options.mode !== "write") {
      throw new ProjectStorageError(
        "STORAGE_SCOPE_VIOLATION",
        "read scopeでは legacy cache を削除できません",
      );
    }
    const { layout } = await this.initialize({ skipLegacyMigration: true });
    if (layout.kind !== "git") {
      throw new ProjectStorageError(
        "STORAGE_MODE_UNSUPPORTED",
        "non-git directory には移行済み legacy cache がありません",
      );
    }
    const inspection = await inspectLegacy(layout);
    const generation = await readCurrentGeneration(layout);
    const entries: LegacyCleanupReport["entries"] = [];
    const deleted: NonNullable<MigrationManifest["legacyCleanups"]> = [];
    for (const entry of inspection.entries) {
      if (entry.state !== "recorded") {
        entries.push({ ...entry, action: "skipped" });
        continue;
      }
      if (generation === null) {
        entries.push({
          ...entry,
          action: "skipped",
          reason: "共有 cache の CURRENT generation が無いため削除しません",
        });
        continue;
      }
      if (options.dryRun) {
        entries.push({ ...entry, action: "planned" });
        continue;
      }
      for (const file of entry.files) await rm(file, { force: true });
      await removeIfEmpty(join(entry.workspace, GANTT_DIR));
      deleted.push({
        workspace: entry.workspace,
        fingerprint: entry.fingerprint!,
        deletedAt: new Date().toISOString(),
        files: entry.files,
      });
      entries.push({ ...entry, action: "deleted" });
    }
    if (deleted.length > 0) {
      const manifest = await readMigrationManifest(layout);
      if (manifest) {
        manifest.legacyCleanups = [...(manifest.legacyCleanups ?? []), ...deleted];
        await saveMigrationManifest(layout, manifest);
      }
    }
    return { dryRun: options.dryRun, entries };
  }

  async relocateStorage(target: StorageMode): Promise<StorageRelocationReport> {
    if (this.options.mode !== "write") {
      throw new ProjectStorageError(
        "STORAGE_SCOPE_VIOLATION",
        "read scopeでは配置を変更できません",
      );
    }
    const workspace = await this.resolveWorkspace();
    const location = workspace.location;
    if (workspace.git === null) {
      throw new ProjectStorageError(
        "STORAGE_MODE_UNSUPPORTED",
        "non-git directory では repository モードだけが使えます",
      );
    }
    if (location.mode === target) {
      return { changed: false, from: location.mode, to: target, moved: [] };
    }
    // 移行元の config で identity を解決し、repository lease と legacy 検証を先に通す。
    const { layout } = await this.initialize();
    if (layout.kind !== "git") {
      throw new ProjectStorageError("STORAGE_MODE_UNSUPPORTED", "Git layout を解決できません");
    }

    const targetConfigDir = target === "git" ? location.gitConfigDir! : location.repositoryDir;
    const targetJournalDir = target === "git" ? location.gitJournalDir! : location.repositoryDir;
    const plan = [
      {
        slot: "config",
        from: join(location.configDir, "gantt.config.json"),
        to: join(targetConfigDir, "gantt.config.json"),
      },
      {
        slot: "workflow",
        from: join(location.configDir, "workflow.md"),
        to: join(targetConfigDir, "workflow.md"),
      },
      {
        slot: "loop-state",
        from: join(location.journalDir, "loop-state.json"),
        to: join(targetJournalDir, "loop-state.json"),
      },
      {
        slot: "run-graph",
        from: join(location.journalDir, RUN_GRAPH_DIR),
        to: join(targetJournalDir, RUN_GRAPH_DIR),
      },
    ];
    const moves: Array<{ slot: string; from: string; to: string }> = [];
    for (const item of plan) {
      if (!(await exists(item.from))) continue;
      if (await exists(item.to)) {
        throw new ProjectStorageError(
          "STORAGE_RELOCATION_CONFLICT",
          `移行先に既に ${item.slot} が存在します: ${item.to}。移行先を確認して削除するか退避してから再実行してください`,
        );
      }
      moves.push(item);
    }
    if (!moves.some((item) => item.slot === "config")) {
      throw new ProjectStorageError(
        "PROJECT_CONFIG_MISSING",
        `移行元に gantt.config.json がありません: ${plan[0].from}`,
      );
    }
    for (const item of moves) await movePath(item.from, item.to);
    await removeIfEmpty(location.configDir);
    if (location.journalDir !== location.configDir) await removeIfEmpty(location.journalDir);

    const previous = await readMigrationManifest(layout);
    const manifest: MigrationManifest = previous ?? {
      schemaVersion: "1",
      projectIdentity: layout.projectIdentity,
      selectedSource: null,
      legacyFingerprints: {},
    };
    manifest.storageRelocations = [
      ...(manifest.storageRelocations ?? []),
      {
        workspace: workspace.projectRoot,
        from: location.mode,
        to: target,
        relocatedAt: new Date().toISOString(),
        moved: moves,
      },
    ];
    await saveMigrationManifest(layout, manifest);
    // 以後この session で workspace slot に触れた場合は移行後の配置を解決し直す。
    this.workspaceLayout = null;
    this.workspaceBound = null;
    return { changed: true, from: location.mode, to: target, moved: moves };
  }

  private async readText(slot: ProjectStorageSlot): Promise<string | null> {
    if (!isSharedSlot(slot)) return (await this.workspace()).readText(slot);
    return (await this.initialize()).bound.readText(slot);
  }

  private async writeText(slot: ProjectStorageSlot, content: string): Promise<void> {
    if (!isSharedSlot(slot)) return (await this.workspace()).writeText(slot, content);
    return (await this.initialize()).bound.writeText(slot, content);
  }

  async flush(): Promise<void> {
    if (this.workspaceBound) await (await this.workspaceBound).flush();
    if (this.initialized) await (await this.initialized).bound.flush();
  }

  async finish(): Promise<void> {
    await this.flush();
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
