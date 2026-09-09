import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_FILE,
  GANTT_DIR,
  GRAPH_CONTRACTS_DIR,
  LOOP_STATE_FILE,
  RUN_GRAPH_DIR,
  RUN_GRAPH_RUNS_DIR,
} from "@gh-gantt/shared";

/**
 * config / workflow / workspace journal の配置モード (#379)。
 *
 * - `repository`: `<worktree>/.gantt-sync/` に置き、config と workflow は commit 対象
 * - `git`: git-common-dir 配下の gh-gantt 名前空間に置き、リポジトリには何も追加しない
 */
export type StorageMode = "repository" | "git";
export const STORAGE_MODES: readonly StorageMode[] = ["repository", "git"];
export const WORKFLOW_FILE = "workflow.md";
const LOCATION_LAYOUT_VERSION = "v1";

export class ProjectStorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectStorageError";
    this.code = code;
  }
}

export function isStorageMode(value: unknown): value is StorageMode {
  return typeof value === "string" && (STORAGE_MODES as readonly string[]).includes(value);
}

/** repository 単位で安定した short key。identity を path へ直接露出しない (ADR-023)。 */
export function shortFingerprint(value: string): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** Git repository の中で workspace の配置を決める入力。non-git では `git` が null。 */
export interface WorkspaceLocationInput {
  /** 正準化した project root (git では realpath 済み)。 */
  projectRoot: string;
  git: {
    commonDir: string;
    /** toplevel から見た project root の相対 path。root なら ""。 */
    relativeProjectRoot: string;
  } | null;
}

/** 解決済みの workspace slot 配置。caller はこの path を直接組み立てない。 */
export interface WorkspaceStorageLocation {
  mode: StorageMode;
  projectRoot: string;
  /** `.gantt-sync` (repository モードの正本、git モードでは legacy / 曖昧判定の対象)。 */
  repositoryDir: string;
  /** git モードの config 配置。non-git では null。 */
  gitConfigDir: string | null;
  /** git モードの journal 配置 (worktree 識別子で分離)。non-git では null。 */
  gitJournalDir: string | null;
  /** 現在モードの config / workflow directory。 */
  configDir: string;
  /** 現在モードの loop-state / Run Graph directory。 */
  journalDir: string;
}

export interface DetectStorageModeOptions {
  /** `init --storage` 等で caller が明示したモード。既存 config と矛盾すれば fail-closed。 */
  explicit?: StorageMode;
}

export function gitModeConfigDir(commonDir: string, relativeProjectRoot: string): string {
  return join(
    commonDir,
    "gh-gantt",
    "config",
    LOCATION_LAYOUT_VERSION,
    shortFingerprint(relativeProjectRoot),
  );
}

export function gitModeJournalDir(commonDir: string, canonicalProjectRoot: string): string {
  return join(
    commonDir,
    "gh-gantt",
    "workspaces",
    LOCATION_LAYOUT_VERSION,
    shortFingerprint(canonicalProjectRoot),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    // 途中の path 要素が file の場合 (ENOTDIR) も「無い」とみなす
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function buildLocation(
  input: WorkspaceLocationInput,
  mode: StorageMode,
  repositoryDir: string,
  gitConfigDir: string | null,
  gitJournalDir: string | null,
): WorkspaceStorageLocation {
  return {
    mode,
    projectRoot: input.projectRoot,
    repositoryDir,
    gitConfigDir,
    gitJournalDir,
    configDir: mode === "git" ? gitConfigDir! : repositoryDir,
    journalDir: mode === "git" ? gitJournalDir! : repositoryDir,
  };
}

/**
 * 配置モードを解決する。解決順序:
 *
 * 1. non-git directory は常に `repository`。
 * 2. `<worktree>/.gantt-sync/gantt.config.json` と git モードの config の存在を調べ、
 *    片方だけがあればそのモード、両方あれば `STORAGE_MODE_AMBIGUOUS` で停止する。
 * 3. どちらも無ければ明示指定 (`explicit`) に従い、無指定なら後方互換の `repository`。
 *
 * 明示指定が既存 config のモードと食い違う場合は `STORAGE_MODE_MISMATCH` で停止し、
 * `storage migrate --to` への誘導を返す。
 */
export async function detectWorkspaceStorageLocation(
  input: WorkspaceLocationInput,
  options: DetectStorageModeOptions = {},
): Promise<WorkspaceStorageLocation> {
  const repositoryDir = join(input.projectRoot, GANTT_DIR);
  if (input.git === null) {
    if (options.explicit === "git") {
      throw new ProjectStorageError(
        "STORAGE_MODE_UNSUPPORTED",
        "git モードは Git repository でのみ使えます。non-git directory では repository モードだけが選べます",
      );
    }
    return buildLocation(input, "repository", repositoryDir, null, null);
  }

  const gitConfigDir = gitModeConfigDir(input.git.commonDir, input.git.relativeProjectRoot);
  const gitJournalDir = gitModeJournalDir(input.git.commonDir, input.projectRoot);
  const repositoryConfig = join(repositoryDir, CONFIG_FILE);
  const gitConfig = join(gitConfigDir, CONFIG_FILE);
  const [hasRepositoryConfig, hasGitConfig] = await Promise.all([
    exists(repositoryConfig),
    exists(gitConfig),
  ]);

  if (hasRepositoryConfig && hasGitConfig) {
    throw new ProjectStorageError(
      "STORAGE_MODE_AMBIGUOUS",
      "repository モードと git モードの両方に gantt.config.json が存在するため、どちらを使うか決められません。\n" +
        `  repository: ${repositoryConfig}\n` +
        `  git:        ${gitConfig}\n` +
        "  正本でない方を削除してから再実行してください",
    );
  }

  let detected: StorageMode | null = null;
  if (hasRepositoryConfig) detected = "repository";
  if (hasGitConfig) detected = "git";

  if (options.explicit && detected && options.explicit !== detected) {
    throw new ProjectStorageError(
      "STORAGE_MODE_MISMATCH",
      `既存の gantt.config.json は ${detected} モードに置かれています (${detected === "git" ? gitConfig : repositoryConfig})。` +
        `${options.explicit} モードへ切り替えるには gh-gantt storage migrate --to ${options.explicit} を実行してください`,
    );
  }

  const mode = detected ?? options.explicit ?? "repository";
  return buildLocation(input, mode, repositoryDir, gitConfigDir, gitJournalDir);
}

export type WorkspaceSlot = "config" | "workflow" | "loop-state" | "graph-contracts" | "run-graph";

/** workspace slot の物理 path。shared slot (tasks 等) は non-git の縮退時だけ repositoryDir を使う。 */
export function workspaceSlotPath(
  location: WorkspaceStorageLocation,
  slot: WorkspaceSlot | "tasks" | "sync-state" | "comments",
): string {
  switch (slot) {
    case "config":
      return join(location.configDir, CONFIG_FILE);
    case "workflow":
      return join(location.configDir, WORKFLOW_FILE);
    case "loop-state":
      return join(location.journalDir, LOOP_STATE_FILE);
    case "graph-contracts":
      return join(location.journalDir, RUN_GRAPH_DIR, GRAPH_CONTRACTS_DIR);
    case "run-graph":
      return join(location.journalDir, RUN_GRAPH_DIR, RUN_GRAPH_RUNS_DIR);
    case "tasks":
      return join(location.repositoryDir, "tasks.json");
    case "sync-state":
      return join(location.repositoryDir, "sync-state.json");
    case "comments":
      return join(location.repositoryDir, "comments.json");
  }
}
