/**
 * [Issue #353] repository の toplevel / common-dir 解決を root ごとに cache し、
 * git の spawn 回数を減らす。
 */
import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
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

function countingRunner(root: string, options: { failCommonDirOnce?: boolean } = {}) {
  let failures = options.failCommonDirOnce ? 1 : 0;
  const runner = vi.fn(async (_projectRoot: string, args: string[]) => {
    if (args.includes("--show-toplevel")) return root;
    if (args.includes("--git-common-dir")) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient failure");
      }
      return join(root, ".git");
    }
    return `worktree ${root}\0`;
  });
  const calls = (needle: string) =>
    runner.mock.calls.filter(([, args]) => args.includes(needle)).length;
  return { runner, calls };
}

describe("[NFR-STABILITY-015-AC11] repository probe の cache [Issue #353]", () => {
  it("同じ root の 2 回目以降は rev-parse を起動せず worktree 一覧だけ取り直す", async () => {
    const root = await projectRoot();
    await mkdir(join(root, ".git"));
    const { runner, calls } = countingRunner(root);

    const first = await resolveRepositoryCoordinationLayout(root, { runGit: runner });
    const second = await resolveRepositoryCoordinationLayout(root, { runGit: runner });

    expect(second.commonDir).toBe(first.commonDir);
    expect(calls("--show-toplevel")).toBe(1);
    expect(calls("--git-common-dir")).toBe(1);
    expect(calls("list")).toBe(2);
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
