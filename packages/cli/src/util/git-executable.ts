import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

let cache: { path: string; executable: string } | null = null;

/**
 * PATH から git の絶対パスを解決する。
 *
 * 名前で spawn すると libuv が PATH エントリごとに posix_spawn を試すため、
 * macOS では PATH の長さに比例して 1 回あたり数十 ms かかる (#353)。
 * 解決結果は PATH の値ごとに cache し、見つからなければ "git" を返す。
 */
export function resolveGitExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.PATH ?? "";
  if (cache && cache.path === path) return cache.executable;
  let executable = "git";
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "git");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      executable = candidate;
      break;
    } catch {
      continue;
    }
  }
  cache = { path, executable };
  return executable;
}

/**
 * git を起動せずに「Git 管理外」と判定できるか。
 *
 * repository 選択の環境変数を除いた git は祖先の `.git` (directory または worktree の file) だけで
 * repository を探索するため、祖先のどこにも無ければ必ず "not a git repository" になる (#353)。
 * directory 自体が存在しない場合は git の診断に任せるため true を返し、git を起動させる。
 */
export function hasGitMarkerInAncestors(directory: string): boolean {
  let current = resolve(directory);
  if (!existsSync(current)) return true;
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** git と同じ診断文を持ち、isNotGitRepositoryError が真になるエラー。 */
export function notGitRepositoryError(directory: string): Error & { stderr: string } {
  const stderr = `fatal: not a git repository (or any of the parent directories): ${directory}`;
  return Object.assign(new Error(stderr), { stderr });
}

/** 解決済みの git を PATH 先頭に置き、名前で spawn する subprocess も PATH 探索を省けるようにする。 */
export function withResolvedGitPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const executable = resolveGitExecutable(env);
  if (!isAbsolute(executable)) return env;
  const directory = dirname(executable);
  const path = env.PATH ?? "";
  if (path.split(delimiter)[0] === directory) return env;
  return { ...env, PATH: path ? `${directory}${delimiter}${path}` : directory };
}
