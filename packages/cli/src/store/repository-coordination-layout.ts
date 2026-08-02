import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigSchema, GANTT_DIR } from "@gh-gantt/shared";
import type { Config } from "@gh-gantt/shared";
import { gitCommandEnvironment } from "../util/git-errors.js";

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

function fingerprint(value: string): string {
  // #329の既存identity keyは正準JSON文字列（文字列なら引用符込み）をhashする。
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    env: gitCommandEnvironment(),
  });
  return result.stdout.trim();
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
): Promise<RepositoryCoordinationLayout> {
  const absoluteRoot = resolve(projectRoot);
  // Git管理外かの判定をconfig読込より先に確定し、従来のstandalone fallbackを壊さない。
  const [rawCommonDir, worktreeOutput, topLevel] = await Promise.all([
    runGit(absoluteRoot, ["rev-parse", "--git-common-dir"]),
    runGit(absoluteRoot, ["worktree", "list", "--porcelain", "-z"]),
    runGit(absoluteRoot, ["rev-parse", "--show-toplevel"]),
  ]);
  const [canonicalRoot, rawConfig] = await Promise.all([
    realpath(absoluteRoot),
    readFile(join(absoluteRoot, GANTT_DIR, "gantt.config.json"), "utf8"),
  ]);
  const commonDir = await realpath(
    isAbsolute(rawCommonDir) ? rawCommonDir : resolve(absoluteRoot, rawCommonDir),
  );
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
