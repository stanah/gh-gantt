import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { chmod, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const hookAbsPath = resolve(repoRoot, ".claude/hooks/pre-bash-guard.sh");

/** GIT_* を除去した環境で一時 git リポジトリと mock gh を用意する。 */
async function setupTempRepo(params: { branch: string; prListJson: string }) {
  const tempDir = await mkdtemp(join(tmpdir(), "gh-gantt-pre-guard-"));
  const mockGhPath = join(tempDir, "gh");
  // pr list は raw JSON を返す (owner での絞り込みは hook 側の python3 が行うため、
  // fork 除外ロジックそのものがテストで実行される)
  const mockGh = `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"repo view"*owner*) printf 'stanah\\n' ;;
  *"pr list"*) printf '%s\\n' '${params.prListJson}' ;;
  *) exit 1 ;;
esac
`;
  await writeFile(mockGhPath, mockGh);
  await chmod(mockGhPath, 0o755);
  const cleanEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tempDir}:${process.env.PATH ?? ""}`,
  };
  delete cleanEnv.GIT_DIR;
  delete cleanEnv.GIT_WORK_TREE;
  delete cleanEnv.GIT_INDEX_FILE;
  delete cleanEnv.GIT_COMMON_DIR;
  const repoDir = join(tempDir, "repo");
  await execFileAsync("git", ["init", "-b", params.branch, repoDir], { env: cleanEnv });
  return { tempDir, repoDir, cleanEnv };
}

function runHook(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  const payload = JSON.stringify({ tool_input: { command } });
  return execFileAsync("bash", ["-c", `printf '%s' '${payload}' | bash "${hookAbsPath}"`], opts);
}

describe("pre-bash-guard によるブランチ状態ゲート (ADR-010 L2 / #310)", () => {
  it("settings.json の PreToolUse が有効な matcher でスクリプトに配線されている", async () => {
    const raw = await readFile(resolve(repoRoot, ".claude/settings.json"), "utf-8");
    const settings = JSON.parse(raw) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>>;
    };
    const preEntries = settings.hooks.PreToolUse ?? [];
    const matchers = preEntries.map((e) => e.matcher ?? "");
    // matcher はツール名のみ有効。"Bash(git commit*)" 形式は一度も発火しない (#310)
    expect(matchers).toContain("Bash");
    expect(matchers.join("\n")).not.toContain("(");
    const commands = preEntries.flatMap((e) => e.hooks.map((h) => h.command ?? "")).join("\n");
    expect(commands).toContain(".claude/hooks/pre-bash-guard.sh");
  });

  it("main ブランチへの git commit をブロックする", async () => {
    const { tempDir, repoDir, cleanEnv } = await setupTempRepo({
      branch: "main",
      prListJson: "[]",
    });
    try {
      await expect(
        runHook("git commit -m test", { cwd: repoDir, env: cleanEnv }),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("マージ済み PR を持つブランチへの git commit / git push をブロックする", async () => {
    const { tempDir, repoDir, cleanEnv } = await setupTempRepo({
      branch: "feature-merged",
      prListJson: '[{"number":42,"headRepositoryOwner":{"login":"stanah"}}]',
    });
    try {
      await expect(
        runHook("git commit -m test", { cwd: repoDir, env: cleanEnv }),
      ).rejects.toMatchObject({ code: 2 });
      await expect(runHook("git push", { cwd: repoDir, env: cleanEnv })).rejects.toMatchObject({
        code: 2,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fork 由来の同名ブランチのマージ済み PR は誤検出しない", async () => {
    const { tempDir, repoDir, cleanEnv } = await setupTempRepo({
      branch: "feature-fork-name",
      prListJson: '[{"number":99,"headRepositoryOwner":{"login":"someone-else"}}]',
    });
    try {
      await runHook("git commit -m test", { cwd: repoDir, env: cleanEnv });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("マージ済み PR がない feature ブランチでは commit を許可する", async () => {
    const { tempDir, repoDir, cleanEnv } = await setupTempRepo({
      branch: "feature-clean",
      prListJson: "[]",
    });
    try {
      await runHook("git commit -m test", { cwd: repoDir, env: cleanEnv });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("git commit / push 以外のコマンドや引数内の言及・壊れた入力では何もしない", async () => {
    const { tempDir, repoDir, cleanEnv } = await setupTempRepo({
      branch: "main",
      prListJson: "[]",
    });
    try {
      // main ブランチ上でも、対象外コマンドなら exit 0
      await runHook("git status", { cwd: repoDir, env: cleanEnv });
      await runHook('echo "git commit の説明"', { cwd: repoDir, env: cleanEnv });
      await execFileAsync("bash", ["-c", `printf '%s' 'broken' | bash "${hookAbsPath}"`], {
        cwd: repoDir,
        env: cleanEnv,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
