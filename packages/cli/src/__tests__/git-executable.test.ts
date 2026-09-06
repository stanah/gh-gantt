/**
 * [Issue #353] git の spawn を PATH から一度解決した絶対パスで行う。
 */
import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  hasGitMarkerInAncestors,
  notGitRepositoryError,
  resolveGitExecutable,
  withResolvedGitPath,
} from "../util/git-executable.js";
import { isNotGitRepositoryError } from "../util/git-errors.js";

async function fixtureDirectories(): Promise<{ binDir: string; decoyDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "gh-gantt-git-executable-"));
  const decoyDir = join(root, "decoy");
  const binDir = join(root, "bin");
  // 先頭エントリには git という名前のディレクトリだけを置き、実行ファイルではないことを確かめる
  await mkdir(join(decoyDir, "git"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "git"), "#!/bin/sh\nexit 0\n");
  await chmod(join(binDir, "git"), 0o755);
  return { binDir, decoyDir };
}

describe("[NFR-STABILITY-015-AC10] git 実行パスの解決 [Issue #353]", () => {
  it("PATH 上で最初に見つかった実行ファイルの絶対パスを返し、同名ディレクトリは読み飛ばす", async () => {
    const { binDir, decoyDir } = await fixtureDirectories();
    const env = { PATH: [decoyDir, binDir].join(delimiter) };

    expect(resolveGitExecutable(env)).toBe(join(binDir, "git"));
  });

  it("PATH 上に git が無ければ名前のまま返す", async () => {
    const { decoyDir } = await fixtureDirectories();

    expect(resolveGitExecutable({ PATH: decoyDir })).toBe("git");
    expect(resolveGitExecutable({})).toBe("git");
  });

  it("withResolvedGitPath は解決した git のディレクトリを PATH 先頭に置き、既に先頭なら変更しない", async () => {
    const { binDir, decoyDir } = await fixtureDirectories();
    const env = { PATH: [decoyDir, binDir].join(delimiter), LC_ALL: "C" };

    const prepended = withResolvedGitPath(env);
    expect(prepended.PATH).toBe([binDir, decoyDir, binDir].join(delimiter));
    expect(prepended.LC_ALL).toBe("C");
    expect(withResolvedGitPath(prepended)).toBe(prepended);
  });

  it("[NFR-STABILITY-015-AC12] 祖先に .git が無い root は git を起動せず Git 管理外と判定できる", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-git-marker-"));
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });

    expect(hasGitMarkerInAncestors(nested)).toBe(false);
    // worktree の .git は file なので file も marker として扱う
    await writeFile(join(root, ".git"), "gitdir: /somewhere\n");
    expect(hasGitMarkerInAncestors(nested)).toBe(true);
    // 存在しない directory は git の診断に任せる
    expect(hasGitMarkerInAncestors(join(root, "missing"))).toBe(true);

    expect(isNotGitRepositoryError(notGitRepositoryError(nested))).toBe(true);
  });

  it("git が見つからなければ PATH を変更しない", async () => {
    const { decoyDir } = await fixtureDirectories();
    const env = { PATH: decoyDir };

    expect(withResolvedGitPath(env)).toBe(env);
  });
});
