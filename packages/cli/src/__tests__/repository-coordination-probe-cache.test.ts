/**
 * [Issue #353] repository の toplevel / common-dir 解決を root ごとに cache し、
 * git の spawn 回数を減らす。
 */
import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepositoryCoordinationLayout } from "../store/repository-coordination-layout.js";

async function projectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-probe-cache-")));
  await mkdir(join(root, ".gantt-sync"), { recursive: true });
  await writeFile(
    join(root, ".gantt-sync", "gantt.config.json"),
    JSON.stringify({
      version: "1",
      project: { name: "fixture", github: { owner: "example", repo: "public", project_number: 1 } },
      sync: { auto_create_issues: false, field_mapping: { start_date: "Start", end_date: "End" } },
      task_types: { task: { label: "Task", display: "bar", color: "#000", github_label: "task" } },
      type_hierarchy: { task: [] },
      statuses: { field_name: "Status", values: {} },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" },
      },
    }),
  );
  return root;
}

function countingRunner(
  root: string,
  options: { failCommonDirOnce?: boolean; failWorktreeListOnce?: boolean } = {},
) {
  let failures = options.failCommonDirOnce ? 1 : 0;
  let worktreeFailures = options.failWorktreeListOnce ? 1 : 0;
  const runner = vi.fn(async (_projectRoot: string, args: string[]) => {
    if (args.includes("--show-toplevel")) return root;
    if (args.includes("--git-common-dir")) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient failure");
      }
      return join(root, ".git");
    }
    if (worktreeFailures > 0) {
      worktreeFailures -= 1;
      throw new Error("worktree list failure");
    }
    return `worktree ${root}\0`;
  });
  const calls = (needle: string) =>
    runner.mock.calls.filter(([, args]) => args.includes(needle)).length;
  return { runner, calls };
}

describe("[NFR-STABILITY-015-AC11] repository probe の cache [Issue #353]", () => {
  it("同じ root の 2 回目以降は rev-parse を起動しない", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".git"));
    const { runner, calls } = countingRunner(root);

    const first = await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    const second = await resolveRepositoryCoordinationLayout(root, { runGit: runner });

    expect(second.commonDir).toBe(first.commonDir);
    expect(calls("--show-toplevel")).toBe(1);
    expect(calls("--git-common-dir")).toBe(1);
  });

  it("失敗した解決は cache に残さず次回に再度 git へ問い合わせる", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".git"));
    const { runner, calls } = countingRunner(root, { failCommonDirOnce: true });

    await expect(resolveRepositoryCoordinationLayout(root, { runGit: runner })).rejects.toThrow(
      "transient failure",
    );
    await expect(
      resolveRepositoryCoordinationLayout(root, { runGit: runner }),
    ).resolves.toMatchObject({ commonDir: join(root, ".git") });
    expect(calls("--git-common-dir")).toBe(2);
  });
});

describe("[NFR-STABILITY-015-AC13] worktree 一覧の cache [Issue #355]", () => {
  it("worktrees の署名が変わらない間は worktree list を起動しない", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".git"));
    const { runner, calls } = countingRunner(root);

    await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    await resolveRepositoryCoordinationLayout(root, { runGit: runner });

    expect(calls("list")).toBe(1);
  });

  it("worktree の追加と移動で署名が変わり再取得する", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".git"));
    const { runner, calls } = countingRunner(root);
    await resolveRepositoryCoordinationLayout(root, { runGit: runner });

    // git worktree add 相当: worktrees/<id>/gitdir が増える
    const entry = join(root, ".git", "worktrees", "linked");
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "gitdir"), "/tmp/linked/.git\n");
    await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    expect(calls("list")).toBe(2);

    // 署名が同じなら再取得しない
    await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    expect(calls("list")).toBe(2);

    // git worktree move 相当: gitdir だけ書き換わる (ディレクトリの更新時刻は変わらない)
    const moved = new Date(Date.now() + 5_000);
    await utimes(join(entry, "gitdir"), moved, moved);
    await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    expect(calls("list")).toBe(3);

    // git worktree remove 相当
    await rm(entry, { recursive: true });
    await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    expect(calls("list")).toBe(4);
  });

  it("worktrees を列挙できない場合は cache を使わず毎回取得する", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".git"));
    // worktrees をディレクトリではなくファイルにして readdir を失敗させる
    await writeFile(join(root, ".git", "worktrees"), "");
    const { runner, calls } = countingRunner(root);

    await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    await resolveRepositoryCoordinationLayout(root, { runGit: runner });

    expect(calls("list")).toBe(2);
  });

  it("失敗した worktree list は cache に残さない", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".git"));
    const { runner, calls } = countingRunner(root, { failWorktreeListOnce: true });

    await expect(resolveRepositoryCoordinationLayout(root, { runGit: runner })).rejects.toThrow(
      "worktree list failure",
    );
    await expect(
      resolveRepositoryCoordinationLayout(root, { runGit: runner }),
    ).resolves.toMatchObject({ projectRoot: root });
    expect(calls("list")).toBe(2);
  });
});
