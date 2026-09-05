import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const renderScript = resolve(repoRoot, "skills/gh-gantt-pr/scripts/render-pr-explainer.mjs");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf-8");
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runRenderScript(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [renderScript, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** テスト環境で利用できる Chromium 実行ファイルを探す（なければ undefined） */
function resolveChromiumExecutable(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const require = createRequire(resolve(repoRoot, "package.json"));
    const { chromium } = require("@playwright/test") as { chromium: { executablePath(): string } };
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // @playwright/test が解決できない環境ではレンダリングテストをスキップする
  }
  return undefined;
}

function extractMarkdownSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextHeading = content.indexOf("\n## ", start + heading.length);
  return content.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

describe("[NFR-STABILITY-008-AC1] gh-gantt-pr skill は Issue から branch 名を標準化する", () => {
  it("Issue タイプから branch prefix と slug 形式を決める", async () => {
    const skill = await readRepoFile("skills/gh-gantt-pr/SKILL.md");

    expect(skill).toContain("name: gh-gantt-pr");
    expect(skill).toContain("<prefix>/issue-<number>-<slug>");
    expect(skill).toContain("| `task`");
    expect(skill).toContain("| `feature`");
    expect(skill).toContain("| `bug`");
    expect(skill).toContain("| `epic`");
    expect(skill).toContain("| `milestone`");
    expect(skill).toContain("`chore`");
    expect(skill).toContain("fix/issue-52-undo-drag-bug");
    expect(skill).toContain("feat/issue-44-label-filter");
    expect(skill).toContain("milestone/issue-60-phase-1-release");
  });
});

describe("[NFR-STABILITY-008-AC2] gh-gantt-pr skill は PR body と gh pr create を標準化する", () => {
  it("Summary、Issue link、Test Plan、gh pr create を定義する", async () => {
    const skill = await readRepoFile("skills/gh-gantt-pr/SKILL.md");

    expect(skill).toContain("## Summary");
    expect(skill).toContain("Closes #<issue-number>");
    expect(skill).toContain("Fixes #<issue-number>");
    expect(skill).toContain("## Test Plan");
    expect(skill).toContain(
      "gh pr create --base <base> --head <branch> --title <title> --body-file <body-file>",
    );
    expect(skill).not.toContain("--body <body>");
  });
});

describe("[NFR-STABILITY-008-AC3] gh-gantt-pr skill は品質ゲートとレビューを扱わない", () => {
  it("プロジェクト固有の検証や review cycle を責務外として明記する", async () => {
    const skill = await readRepoFile("skills/gh-gantt-pr/SKILL.md");
    const nonGoals = extractMarkdownSection(skill, "## 扱わないこと");

    expect(nonGoals).toContain("ビルド・テスト・lint・typecheck");
    expect(nonGoals).toContain("pre-commit / pre-push");
    expect(nonGoals).toContain("レビュー監視");
    expect(nonGoals).toContain("言語、パッケージマネージャ");
    expect(skill).not.toContain("pnpm test");
    expect(skill).not.toContain("pnpm lint");
    expect(skill).not.toContain("pnpm build");
    expect(skill).not.toContain("npm test");
  });
});

describe("[NFR-STABILITY-008-AC4] gh-gantt-workflow と AGENTS は gh-gantt-pr を参照する", () => {
  it("既存 workflow と agent guidance から PR 作成スキルへ誘導する", async () => {
    const workflow = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");
    const agents = await readRepoFile("AGENTS.md");

    expect(workflow).toContain("PR 作成のみは gh-gantt-pr");
    expect(workflow).toContain("`gh-gantt-pr` の命名規則");
    expect(workflow).toContain("PR 作成のみを標準化する場合は `gh-gantt-pr`");
    expect(agents).toContain("`gh-gantt-pr`");
    expect(agents).toContain("PR description");
    expect(agents).toContain("`gh pr create`");
  });
});

describe("[NFR-STABILITY-008-AC5] gh-gantt-pr skill は認知負荷軽減の任意拡張を reference と fallback 付きで定義する", () => {
  it("SKILL.md は最小フローを維持したまま 3 拡張への判断表と共通ルールを持つ", async () => {
    const skill = await readRepoFile("skills/gh-gantt-pr/SKILL.md");
    const extensions = extractMarkdownSection(skill, "## 任意の拡張（認知負荷軽減）");

    // 最小フローと責務境界は変えない
    expect(skill).toContain("既定の最小フローは変えない");
    expect(extensions).toContain("常時適用を要求しない");
    expect(extensions).toContain("ADR-027");

    // 3 拡張への導線
    expect(extensions).toContain("references/attachments.md");
    expect(extensions).toContain("references/stacked-pr.md");
    expect(extensions).toContain("references/pr-explainer.md");

    // 共通ルール
    expect(extensions).toContain("画像・動画のみ");
    expect(extensions).toContain("gh 2.99.0 以上");
    expect(extensions).toContain("scripts/render-pr-explainer.mjs");
    expect(extensions).toContain("git 管理外");
    expect(extensions).toContain("commit しない");
    expect(extensions).toContain("Mermaid");
    expect(extensions).toContain("Part of #<issue-number>");
    expect(extensions).toContain("fallback");
  });

  it("添付 reference は gh 2.99.0 の --attach の前提・制約・fallback を定義する", async () => {
    const reference = await readRepoFile("skills/gh-gantt-pr/references/attachments.md");

    expect(reference).toContain("2.99.0");
    expect(reference).toContain("--attach");
    expect(reference).toContain("画像・動画のみ");
    expect(reference).toContain("HTML・PDF・ログは添付不可");
    expect(reference).toContain("GHES では利用できない");
    expect(reference).toContain("3 枚");
    expect(reference).toContain("秘密情報");
    expect(reference).toContain("gh pr edit <number> --attach <file>");
    expect(reference).toContain("## gh が古い場合の fallback");
    expect(reference).not.toContain("--body <body>");
  });

  it("スタック PR reference は分割基準・層ごとの branch 名・Issue link の配置・fallback を定義する", async () => {
    const reference = await readRepoFile("skills/gh-gantt-pr/references/stacked-pr.md");

    expect(reference).toContain("gh extension install github/gh-stack");
    expect(reference).toContain("1 PR = 1 レビュー観点");
    expect(reference).toContain("単独で CI green");
    expect(reference).toContain("<prefix>/issue-<number>-<slug>/<k>-<layer-slug>");
    expect(reference).toContain("Closes #<issue-number>");
    expect(reference).toContain("Part of #<issue-number>");
    expect(reference).toContain("ADR-019");
    expect(reference).toContain("## 手順（`gh stack` なしの fallback）");
    expect(reference).toContain(
      "gh pr create --base <lower-branch> --head <upper-branch> --title <title> --body-file <body-file>",
    );
    expect(reference).toContain("pr-review-cycle-wait.sh --pr <number>");
    // merge 判断は本スキルの範囲外
    expect(reference).toContain("本スキルの範囲外");
  });

  it("説明資料 reference は形式の優先順位・git 管理外の出力先・CI artifact の制約を定義する", async () => {
    const reference = await readRepoFile("skills/gh-gantt-pr/references/pr-explainer.md");
    const gitignore = await readRepoFile(".gitignore");

    expect(reference).toContain("## 形式の選び方");
    expect(reference).toContain("Mermaid で表せないときだけ");
    expect(reference).toContain("単一ファイル");
    expect(reference).toContain("外部 CDN");
    expect(reference).toContain("render-pr-explainer.mjs");
    expect(reference).toContain("PLAYWRIGHT_CHROMIUM_EXECUTABLE");

    // git 管理外の出力先は gitignore で実際に除外されている
    expect(reference).toContain(".gantt-sync/pr-explainer/<issue-number>/");
    expect(reference).toContain("<scratchpadDir>/<issue-number>/pr-explainer/");
    expect(reference).toContain("コミットしない");
    expect(gitignore).toContain(".gantt-sync/*");
    expect(gitignore).toContain(".dev-flow/");

    // CI artifact（経路 B）の制約と opt-in
    expect(reference).toContain("archive: false");
    expect(reference).toContain("ログイン必須");
    expect(reference).toContain("90 日");
    expect(reference).toContain("run 単位");
    expect(reference).toContain("決定論的に生成できる資料");
    expect(reference).toContain("opt-in");
    expect(reference).toContain("本スキルはこの workflow を配布しない");
  });

  it("ADR-027 は責務境界の維持と alternatives、フォローアップを記録する", async () => {
    const adr = await readRepoFile("docs/adr/ADR-027-pr-cognitive-load-reduction.md");

    expect(adr).toContain("id: ADR-027");
    expect(adr).toContain("status: accepted");
    expect(adr).toContain("フォローアップ");
    expect(adr).toContain("- NFR-STABILITY-008");
    expect(adr).toContain("ADR-013");
    expect(adr).toContain("ADR-019");
    expect(adr).toContain("## Alternatives");
    expect(adr).toContain("gh-gantt CLI に `pr` サブコマンドを追加する");
    expect(adr).toContain("説明資料の HTML を `docs/` に commit する");
  });
});

describe("[NFR-STABILITY-008-AC6] render-pr-explainer.mjs は単一 HTML を PNG にレンダリングする", () => {
  let workDir: string;
  const chromiumExecutable = resolveChromiumExecutable();

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "gh-gantt-pr-explainer-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it.each([
    ["引数不足", ["only.html"], "2 引数"],
    ["HTML 以外の入力", ["input.txt", "out.png"], ".html"],
    ["PNG 以外の出力", ["input.html", "out.svg"], ".png"],
    ["不正な --width", ["input.html", "out.png", "--width", "abc"], "正の整数"],
    ["不明なオプション", ["input.html", "out.png", "--zoom", "2"], "不明なオプション"],
  ])("%s は non-zero と日本語エラーで失敗する", async (_name, args, keyword) => {
    const result = await runRenderScript(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(keyword);
    expect(result.stderr).toContain("使い方");
  });

  it("入力 HTML が存在しない場合は non-zero と日本語エラーで失敗する", async () => {
    const result = await runRenderScript([join(workDir, "missing.html"), join(workDir, "out.png")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("入力 HTML が存在しません");
  });

  it.skipIf(!chromiumExecutable)(
    "Chromium が利用できる環境では単一 HTML を PNG に出力し、JSON で結果を返す",
    async () => {
      const input = join(workDir, "overview.html");
      const output = join(workDir, "nested", "overview.png");
      await writeFile(
        input,
        [
          '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>説明資料</title>',
          "<style>body{font-family:sans-serif;margin:24px}</style></head>",
          "<body><h1>PR 説明資料</h1><p>before → after</p></body></html>",
        ].join(""),
        "utf-8",
      );

      const result = await runRenderScript([input, output, "--width", "800", "--scale", "1"], {
        PLAYWRIGHT_CHROMIUM_EXECUTABLE: chromiumExecutable,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ input, output, width: 800, scale: 1 });
      const png = await stat(output);
      expect(png.size).toBeGreaterThan(0);
      const header = (await readFile(output)).subarray(0, 8);
      expect(header).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    },
    30_000,
  );
});
