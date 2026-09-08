import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { CONFIG_FILE, ConfigSchema, GANTT_DIR } from "@gh-gantt/shared";
import type { Config } from "@gh-gantt/shared";
import { detectWorkspaceStorageLocation } from "./storage-location.js";
import { gitCommandEnvironment, isNotGitRepositoryError } from "../util/git-errors.js";
import {
  hasGitMarkerInAncestors,
  notGitRepositoryError,
  resolveGitExecutable,
} from "../util/git-executable.js";

const execFileAsync = promisify(execFile);

export interface RepositoryCoordinationLayout {
  projectRoot: string;
  commonDir: string;
  projectIdentity: string;
  projectKey: string;
  claimRoot: string;
  mutationProposalRoot: string;
  canonicalWorkspaceId: string;
  linkedWorktrees: string[];
  linkedProjectRoots: string[];
  config: Config;
}

export interface RepositoryCoordinationLayoutDependencies {
  runGit?: (projectRoot: string, args: string[]) => Promise<string>;
}

function fingerprint(value: string): string {
  // #329の既存identity keyは正準JSON文字列（文字列なら引用符込み）をhashする。
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  // Git 管理外の root は git を起動せずに判定する (#353)
  if (!hasGitMarkerInAncestors(projectRoot)) throw notGitRepositoryError(projectRoot);
  const result = await execFileAsync(resolveGitExecutable(), ["-C", projectRoot, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    env: gitCommandEnvironment(),
  });
  return result.stdout.trim();
}

type GitRunner = (projectRoot: string, args: string[]) => Promise<string>;

/**
 * root ごとに不変な rev-parse の結果を runner 単位で cache する (#353)。
 *
 * toplevel と common-dir は process の生存中に変わらないため一度だけ git を起動する。
 * worktree 一覧は変化し得るので別途 `worktrees` の署名で cache する。失敗した呼び出しは
 * cache に残さず、次回の呼び出しで再度 git に問い合わせる。
 */
const revParseCache = new WeakMap<GitRunner, Map<string, Promise<string>>>();

export function cachedRevParse(
  executeGit: GitRunner,
  absoluteRoot: string,
  option: string,
): Promise<string> {
  let perRunner = revParseCache.get(executeGit);
  if (!perRunner) {
    perRunner = new Map();
    revParseCache.set(executeGit, perRunner);
  }
  const key = `${absoluteRoot}\0${option}`;
  const cached = perRunner.get(key);
  if (cached) return cached;
  const pending = executeGit(absoluteRoot, ["rev-parse", option]);
  perRunner.set(key, pending);
  pending.catch(() => perRunner.delete(key));
  return pending;
}

/**
 * worktree 一覧を common-dir 配下の `worktrees` の状態を署名にして cache する (#355)。
 *
 * `git worktree add` / `remove` / `prune` は `worktrees` ディレクトリの更新時刻を、
 * `git worktree move` は該当エントリの `gitdir` の更新時刻を変えるため、両方を署名に含める。
 * 署名が一致する間は git を起動せず前回の出力を返す。失敗した取得は cache に残さない。
 * 署名の計算は best effort で、`worktrees` を列挙できない場合は毎回 git を起動する。
 */
const worktreeListCache = new WeakMap<
  GitRunner,
  Map<string, { signature: string; output: Promise<string> }>
>();

function worktreeSignature(commonDir: string): string {
  const worktreesDir = join(commonDir, "worktrees");
  let signature: string;
  // 読めない (権限や一時的な I/O エラー) ときは一致しない署名を返し、cache を使わない
  const unreadable = () => `unreadable:${process.hrtime.bigint()}`;
  try {
    signature = `dir:${statSync(worktreesDir).mtimeMs}`;
  } catch (error) {
    // linked worktree が無い repository では worktrees 自体が存在しない
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return unreadable();
  }
  let entries: string[];
  try {
    entries = readdirSync(worktreesDir).sort();
  } catch {
    return unreadable();
  }
  for (const entry of entries) {
    let gitdirMtime = "missing";
    try {
      gitdirMtime = String(statSync(join(worktreesDir, entry, "gitdir")).mtimeMs);
    } catch {
      // gitdir の無いエントリ (作成途中や破損) は "missing" として署名に含める
    }
    signature += `;${entry}:${gitdirMtime}`;
  }
  return signature;
}

export function cachedWorktreeList(
  executeGit: GitRunner,
  absoluteRoot: string,
  commonDir: string,
): Promise<string> {
  let perRunner = worktreeListCache.get(executeGit);
  if (!perRunner) {
    perRunner = new Map();
    worktreeListCache.set(executeGit, perRunner);
  }
  const signature = worktreeSignature(commonDir);
  const cached = perRunner.get(absoluteRoot);
  if (cached && cached.signature === signature) return cached.output;
  const output = executeGit(absoluteRoot, ["worktree", "list", "--porcelain", "-z"]);
  perRunner.set(absoluteRoot, { signature, output });
  output.catch(() => {
    if (perRunner.get(absoluteRoot)?.output === output) perRunner.delete(absoluteRoot);
  });
  return output;
}

function parseWorktrees(output: string): string[] {
  return output
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
}

/** claim/proposalが共有するrepository identity resolver。ドメイン別root/lockは共有しない。 */
export async function resolveRepositoryCoordinationLayout(
  projectRoot: string,
  dependencies: RepositoryCoordinationLayoutDependencies = {},
): Promise<RepositoryCoordinationLayout> {
  const absoluteRoot = resolve(projectRoot);
  const executeGit = dependencies.runGit ?? runGit;
  const canonicalRoot = await realpath(absoluteRoot);
  let rawCommonDir = canonicalRoot;
  let worktreeOutput = `worktree ${canonicalRoot}\0`;
  let topLevel = canonicalRoot;
  let nonGitError: unknown = null;
  try {
    // repository境界を先に確定し、後続probeの異常をnon-Git fallbackで隠さない。
    topLevel = await cachedRevParse(executeGit, absoluteRoot, "--show-toplevel");
  } catch (error) {
    if (!isNotGitRepositoryError(error)) throw error;
    nonGitError = error;
    // Git管理外ではcaller指定rootを単一workspaceとして扱い、従来のstandalone動作を保つ。
  }
  if (!nonGitError) {
    rawCommonDir = await cachedRevParse(executeGit, absoluteRoot, "--git-common-dir");
    worktreeOutput = await cachedWorktreeList(
      executeGit,
      absoluteRoot,
      isAbsolute(rawCommonDir) ? rawCommonDir : resolve(absoluteRoot, rawCommonDir),
    );
  }
  const commonDir = await realpath(
    isAbsolute(rawCommonDir) ? rawCommonDir : resolve(absoluteRoot, rawCommonDir),
  );
  const canonicalTopLevelForLocation = await realpath(topLevel);
  // config の配置は Project Storage の配置モード (repository / git) に従う (#379)。
  const configPath = nonGitError
    ? join(absoluteRoot, GANTT_DIR, CONFIG_FILE)
    : join(
        (
          await detectWorkspaceStorageLocation({
            projectRoot: canonicalRoot,
            git: {
              commonDir,
              relativeProjectRoot: relative(canonicalTopLevelForLocation, canonicalRoot),
            },
          })
        ).configDir,
        CONFIG_FILE,
      );
  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    // configのないstandalone Run Graph callerへ従来のnon-Git signalを返す。
    if (nonGitError && (error as NodeJS.ErrnoException).code === "ENOENT") throw nonGitError;
    throw error;
  }
  const config = ConfigSchema.parse(JSON.parse(rawConfig));
  const github = config.project.github;
  const projectIdentity = `${github.owner.trim().toLowerCase()}/${github.repo.trim().toLowerCase()}#${github.project_number}`;
  const projectKey = fingerprint(projectIdentity).slice(0, 32);
  const coordinationRoot = join(commonDir, "gh-gantt", "coordination");
  const canonicalTopLevel = await realpath(topLevel);
  const relativeProjectRoot = relative(canonicalTopLevel, canonicalRoot);
  const linkedWorktrees = await Promise.all(
    parseWorktrees(worktreeOutput).map((path) => realpath(path)),
  );
  const linkedProjectRoots = await Promise.all(
    linkedWorktrees.map((path) => realpath(join(path, relativeProjectRoot))),
  );
  return {
    projectRoot: canonicalRoot,
    commonDir,
    projectIdentity,
    projectKey,
    // #329の既存pathは後方互換性のため変更しない。
    claimRoot: join(coordinationRoot, "v1", projectKey),
    mutationProposalRoot: join(coordinationRoot, "mutation-proposals", "v1", projectKey),
    canonicalWorkspaceId: `workspace:${fingerprint(canonicalRoot)}`,
    linkedWorktrees: [...new Set(linkedWorktrees)].sort(),
    linkedProjectRoots: [...new Set(linkedProjectRoots)].sort(),
    config,
  };
}
