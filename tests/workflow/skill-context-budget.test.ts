import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const helperPath = resolve(
  repoRoot,
  "skills/gh-gantt-workflow/scripts/project-task-list-evidence.mjs",
);

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf-8");
}

function makeTask(index: number) {
  return {
    id: `owner/repo#${index}`,
    github_issue: index,
    title: `タスク ${index}`,
    body: `本文 ${index} ${"x".repeat(4_096)}`,
    state: "open",
    custom_fields: {
      Status: index % 2 === 0 ? "進行中" : "未着手",
      Phase: `phase-${index}`,
    },
    labels: ["task"],
  };
}

async function runHelper(
  input: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [helperPath, ...args], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(Object.assign(new Error(stderr), { code, stdout, stderr }));
    });
    child.stdin.end(input);
  });
}

describe("[NFR-STABILITY-012-AC1] タスク一覧の bounded projection", () => {
  it("数百件の task を既定 50 件と 5 フィールドだけの構造化証跡へ射影する", async () => {
    const input = JSON.stringify({ tasks: Array.from({ length: 320 }, (_, i) => makeTask(i + 1)) });
    const { stdout } = await runHelper(input);
    const evidence = JSON.parse(stdout) as {
      total: number;
      limit: number;
      truncated: boolean;
      tasks: Array<Record<string, unknown>>;
    };

    expect(evidence).toMatchObject({ total: 320, limit: 50, truncated: true });
    expect(evidence.tasks).toHaveLength(50);
    expect(evidence.tasks[0]).toEqual({
      id: "owner/repo#1",
      github_issue: 1,
      title: "タスク 1",
      status: "未着手",
      state: "open",
    });
    for (const task of evidence.tasks) {
      expect(Object.keys(task)).toEqual(["id", "github_issue", "title", "status", "state"]);
      expect(task).not.toHaveProperty("body");
    }
    expect(stdout).not.toContain("本文");
  });

  it("--limit と --status-field を明示すると証跡 metadata と status 射影へ反映する", async () => {
    const input = JSON.stringify({ tasks: [makeTask(1), makeTask(2), makeTask(3)] });
    const { stdout } = await runHelper(input, ["--limit", "2", "--status-field", "Phase"]);

    expect(JSON.parse(stdout)).toEqual({
      total: 3,
      limit: 2,
      truncated: true,
      tasks: [
        {
          id: "owner/repo#1",
          github_issue: 1,
          title: "タスク 1",
          status: "phase-1",
          state: "open",
        },
        {
          id: "owner/repo#2",
          github_issue: 2,
          title: "タスク 2",
          status: "phase-2",
          state: "open",
        },
      ],
    });
  });

  it.each([
    ["不正 JSON", "{", [], "JSON"],
    ["想定外 envelope", JSON.stringify({ items: [] }), [], "tasks"],
    ["不正 task shape", JSON.stringify({ tasks: [null] }), [], "task"],
    ["0 件 limit", JSON.stringify({ tasks: [] }), ["--limit", "0"], "limit"],
    ["非整数 limit", JSON.stringify({ tasks: [] }), ["--limit", "1.5"], "limit"],
  ])("%s は non-zero と日本語エラーで失敗する", async (_name, input, args, keyword) => {
    await expect(runHelper(input, args as string[])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        new RegExp(`(?:不正|必要|形式|整数).+${keyword}|${keyword}.+(?:不正|必要|形式|整数)`, "i"),
      ),
    });
  });

  it("progress 配下の全 list command が同じ bounded pipeline を通る", async () => {
    const paths = [
      "skills/gh-gantt-progress/SKILL.md",
      "skills/gh-gantt-progress/references/next-task.md",
      "skills/gh-gantt-progress/references/task-state-update.md",
      "skills/gh-gantt-progress/references/task-hygiene.md",
    ];
    let commandCount = 0;

    for (const path of paths) {
      const content = await readRepoFile(path);
      const normalized = content.replace(/\\\r?\n\s*/g, " ");
      const commands = [...normalized.matchAll(/gh-gantt list[^`\n]*/g)].map((match) =>
        match[0].trim(),
      );
      commandCount += commands.length;

      for (const command of commands) {
        expect(command, `${path}: ${command}`).toContain("--json");
        expect(command, `${path}: ${command}`).toContain(
          "| node skills/gh-gantt-workflow/scripts/project-task-list-evidence.mjs",
        );
      }

      if (content.includes("フォールバック")) {
        expect(content).toContain("--limit <n>");
        expect(content).toContain("--status-field <name>");
        expect(content).toContain("project workflow の指定 > ユーザーの明示指定 > default 50");
      }
    }

    expect(commandCount).toBeGreaterThan(0);
  });
});

describe("[NFR-STABILITY-012-AC2] workflow skill の段階的 task detail 取得", () => {
  it("workflow と progress は共通 helper を使い、body を候補絞り込み後だけ取得する", async () => {
    const workflow = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");
    const progress = await readRepoFile("skills/gh-gantt-progress/SKILL.md");

    for (const skill of [workflow, progress]) {
      expect(skill).toContain("gh-gantt list --state open --json");
      expect(skill).toContain("project-task-list-evidence.mjs");
      expect(skill).toContain("total");
      expect(skill).toContain("truncated");
      expect(skill).toContain("候補を絞り込");
      expect(skill).toContain("gh-gantt show");
      expect(skill).toContain("明示");
      expect(skill).toContain("exhaustive");
    }

    expect(workflow).not.toContain("CLI の出力をそのまま表示すること");
    expect(progress).not.toContain("結果をそのまま表示する");
  });

  it("未対応 option の fallback でも JSON projection helper を維持する", async () => {
    const workflow = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");

    expect(workflow).toContain(
      "オプションを外した場合も `gh-gantt list --state open --json | node skills/gh-gantt-workflow/scripts/project-task-list-evidence.mjs`",
    );
    expect(workflow).not.toContain(
      "オプションを外した `gh-gantt list --state open` にフォールバック",
    );
  });

  it("workflow と progress は project-local limit の指定方法と優先順位を定義する", async () => {
    const workflow = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");
    const progress = await readRepoFile("skills/gh-gantt-progress/SKILL.md");

    for (const skill of [workflow, progress]) {
      expect(skill).toContain("--limit <n>");
      expect(skill).toContain("project workflow の指定 > ユーザーの明示指定 > default 50");
    }
  });

  it("task hygiene は truncated な一覧から無条件に body を取得しない", async () => {
    const hygiene = await readRepoFile("skills/gh-gantt-progress/references/task-hygiene.md");

    expect(hygiene).toContain("truncated: true");
    expect(hygiene).toContain("gh-gantt show");
    expect(hygiene).toContain("実行しない");
    expect(hygiene).toContain("filter / search");
    expect(hygiene).toContain("exhaustive audit");
    expect(hygiene).toContain("明示的に opt-in");
    expect(hygiene).toContain(
      "filter / search 後に bounded evidence を再取得し、`truncated: false` を確認できた場合に限って",
    );
    expect(hygiene).toContain(
      "それでも `truncated: true` の場合は、さらに絞り込むか、ユーザーの `exhaustive audit` opt-in を取得する",
    );
    expect(hygiene).not.toContain("`truncated: false`、または検査対象が十分に絞り込まれた後");
  });
});

describe("[NFR-STABILITY-012-AC3] 既知単一タスクの状態補正", () => {
  it("対象 Issue の受入基準と関連差分を検証し、repository-wide git log を必須にしない", async () => {
    const reference = await readRepoFile(
      "skills/gh-gantt-progress/references/task-state-update.md",
    );

    expect(reference).toContain("既知の単一タスク");
    expect(reference).toContain("受入基準");
    expect(reference).toContain("関連する commit / diff");
    expect(reference).toContain("リポジトリ全体の git log");
    expect(reference).toContain("必須ではない");
    expect(reference).toContain("横断監査");
  });
});
