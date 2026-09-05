import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPlan,
  chooseMode,
  DISPATCH_MAX_CHARS,
  renderPlan,
  temporaryBranchName,
  validateHtml,
} from "../../skills/gh-gantt-pr/scripts/pr-explainer-publish.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const publishScript = resolve(repoRoot, "skills/gh-gantt-pr/scripts/pr-explainer-publish.mjs");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf-8");
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runPublishScript(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [publishScript, ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function extractMarkdownSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextHeading = content.indexOf("\n## ", start + heading.length);
  return content.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

const SAMPLE_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>説明資料</title>' +
  "<style>body{font-family:sans-serif}</style></head>" +
  '<body><button id="b">切替</button><script>document.getElementById("b").onclick=()=>{}</script></body></html>';

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
    expect(extensions).toContain("HTML は添付できない");
    expect(extensions).toContain("scripts/pr-explainer-publish.mjs");
    expect(extensions).toContain("archive: false");
    expect(extensions).toContain("リンク 1 行");
    expect(extensions).toContain("HTML の本文を PR body やコメントに貼らない");
    expect(extensions).toContain("git 管理外");
    expect(extensions).toContain("commit しない");
    expect(extensions).toContain("Mermaid");
    expect(extensions).toContain("Part of #<issue-number>");
    expect(extensions).toContain("fallback");
    // PNG 化の経路は廃止済み
    expect(skill).not.toContain("PNG 化");
    expect(skill).not.toContain("render-pr-explainer");
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
    expect(reference).not.toContain("PNG 化");
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
    // layer 1 の base は SKILL.md の入力 <base> を使い、main を決め打ちしない
    expect(reference).toContain("layer 1 を `<base>`");
    expect(reference).toContain("pr-review-cycle-wait.sh --pr <number>");
    // merge 判断は本スキルの範囲外
    expect(reference).toContain("本スキルの範囲外");
  });

  it("説明資料 reference は形式の優先順位・git 管理外の出力先・artifact 公開の制約を定義する", async () => {
    const reference = await readRepoFile("skills/gh-gantt-pr/references/pr-explainer.md");
    const gitignore = await readRepoFile(".gitignore");

    expect(reference).toContain("## 形式の選び方");
    expect(reference).toContain("Mermaid");
    expect(reference).toContain("単一ファイル");
    expect(reference).toContain("外部 CDN");

    // git 管理外の出力先は gitignore で実際に除外されている
    expect(reference).toContain(".gantt-sync/pr-explainer/<issue-number>/");
    expect(reference).toContain("<scratchpadDir>/<issue-number>/pr-explainer/");
    expect(reference).toContain("HTML はコミットしない");
    expect(gitignore).toContain(".gantt-sync/*");
    expect(gitignore).toContain(".dev-flow/");

    // PR のテキストに HTML を置かない（エージェントのコンテキスト保護）
    expect(reference).toContain("### PR 本文とコメントに HTML を書かない");
    expect(reference).toContain("コンテキストウィンドウを圧迫する");
    expect(reference).toContain("リンク 1 行のコメント");

    // 公開の仕組みと輸送路
    expect(reference).toContain("archive: false");
    expect(reference).toContain("インライン JavaScript も実行される");
    expect(reference).toContain("templates/pr-explainer.yml");
    expect(reference).toContain(".github/workflows/pr-explainer.yml");
    expect(reference).toContain(
      "gh workflow run pr-explainer.yml -F pr=<n> -F title=<t> -F html=@<file>",
    );
    expect(reference).toContain("60,000 文字");
    expect(reference).toContain("pr-explainer/<n>-<時刻>");
    expect(reference).toContain("source_branch");
    expect(reference).toContain("pr-explainer-publish.mjs");
    expect(reference).toContain("--run");

    // 制約と fallback
    expect(reference).toContain("read 権限");
    expect(reference).toContain("90 日");
    expect(reference).toContain("Artifacts 欄に並ばない");
    expect(reference).toContain("既定 branch に存在して初めて起動できる");
    expect(reference).toContain("なければ HTML は作らず");
    // 却下済みの経路
    expect(reference).toContain("HTML を PNG に変換して添付する");
    expect(reference).not.toContain("render-pr-explainer");
  });

  it("ADR-027 は責務境界の維持と alternatives、フォローアップを記録する", async () => {
    const adr = await readRepoFile("docs/adr/ADR-027-pr-cognitive-load-reduction.md");

    expect(adr).toContain("id: ADR-027");
    expect(adr).toContain("status: accepted");
    expect(adr).toContain("フォローアップ");
    expect(adr).toContain("- NFR-STABILITY-008");
    expect(adr).toContain("ADR-013");
    expect(adr).toContain("ADR-019");
    expect(adr).toContain("コンテキストウィンドウを圧迫する");
    expect(adr).toContain("## Alternatives");
    expect(adr).toContain("gh-gantt CLI に `pr` サブコマンドを追加する");
    expect(adr).toContain("説明資料の HTML を `docs/` に commit する");
    expect(adr).toContain("説明資料の HTML を PNG に変換して `--attach` する");
    expect(adr).toContain("HTML の本文を PR コメントに埋め込み");
    expect(adr).toContain("隠し ref、Gist、外部ホスティング");
  });
});

describe("[NFR-STABILITY-008-AC6] 説明資料は検証済みの単一 HTML を workflow 経由で artifact として公開する", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "gh-gantt-pr-explainer-"));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("単一ファイル契約: HTML 文書でない、外部参照がある場合を検出する", () => {
    expect(validateHtml(SAMPLE_HTML)).toEqual([]);
    expect(validateHtml("hello")).toEqual([
      "HTML 文書ではありません（<!doctype html> または <html> が必要）",
    ]);
    expect(
      validateHtml(
        '<!doctype html><html><script src="https://cdn.example.com/x.js"></script></html>',
      ),
    ).toEqual([
      "外部リソースを参照しています: script / link / img / iframe / video / audio / source の外部 URL",
    ]);
    expect(
      validateHtml('<!doctype html><html><style>@import "https://a/b.css";</style></html>'),
    ).toEqual(["外部リソースを参照しています: CSS の @import"]);
    expect(
      validateHtml("<!doctype html><html><style>body{background:url(//a/b.png)}</style></html>"),
    ).toEqual(["外部リソースを参照しています: CSS の url(http...)"]);
    // 通常のリンクは許可する
    expect(
      validateHtml(
        '<!doctype html><html><a href="https://github.com/stanah/gh-gantt">repo</a></html>',
      ),
    ).toEqual([]);
  });

  it("輸送路の選択: 60,000 文字以内は dispatch、超えると branch、明示指定は尊重する", () => {
    expect(chooseMode(DISPATCH_MAX_CHARS, "auto")).toEqual({ mode: "dispatch" });
    expect(chooseMode(DISPATCH_MAX_CHARS + 1, "auto")).toEqual({ mode: "branch" });
    expect(chooseMode(10, "branch")).toEqual({ mode: "branch" });
    expect(chooseMode(DISPATCH_MAX_CHARS + 1, "dispatch")).toMatchObject({
      error: expect.stringContaining("--mode branch"),
    });
  });

  it("dispatch はファイル内容を html input として gh workflow run に渡す", () => {
    const plan = buildPlan({
      mode: "dispatch",
      pr: 345,
      title: "任意拡張の流れ",
      workflow: "pr-explainer.yml",
      input: "/tmp/x/overview.html",
    });
    expect(renderPlan(plan)).toEqual([
      "gh workflow run pr-explainer.yml -F pr=345 -F 'title=任意拡張の流れ' -F html=@/tmp/x/overview.html",
    ]);
  });

  it("branch は HTML だけの孤立コミットを pr-explainer/ 配下の branch に push し、source_branch で渡す", () => {
    const branch = temporaryBranchName(345, new Date("2026-09-05T12:34:56.789Z"));
    expect(branch).toBe("pr-explainer/345-20260905T123456Z");

    const plan = buildPlan({
      mode: "branch",
      pr: 345,
      title: "PR 説明資料",
      workflow: "pr-explainer.yml",
      input: "/tmp/x/overview.html",
      branch,
    });
    const rendered = renderPlan(plan);
    expect(rendered[0]).toBe("git hash-object -w /tmp/x/overview.html");
    expect(rendered[1]).toContain("git mktree");
    expect(rendered[2]).toContain("git commit-tree");
    expect(rendered[3]).toBe(`git push origin '{commit}:refs/heads/${branch}'`);
    expect(rendered[4]).toBe(
      `gh workflow run pr-explainer.yml -F pr=345 -F 'title=PR 説明資料' -F source_branch=${branch}`,
    );
    // 孤立コミットには HTML 1 ファイルだけを含める
    expect(plan[1].stdin).toBe("100644 blob {blob}\texplainer.html\n");
    // 隠し ref ではなく refs/heads/ を使う（環境によって branch 以外の ref への push は拒否される）
    for (const line of rendered) expect(line).not.toMatch(/refs\/(?!heads\/)/);
  });

  it("CLI は既定で dry-run とし、JSON で輸送路とコマンドを返す", async () => {
    const input = join(workDir, "overview.html");
    await writeFile(input, SAMPLE_HTML, "utf-8");

    const result = await runPublishScript([input, "--pr", "345", "--title", "任意拡張の流れ"]);
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(summary).toMatchObject({
      input,
      pr: 345,
      title: "任意拡張の流れ",
      mode: "dispatch",
      branch: null,
      executed: false,
    });
    expect(summary.commands).toEqual([
      `gh workflow run pr-explainer.yml -F pr=345 -F 'title=任意拡張の流れ' -F html=@${input}`,
    ]);
  });

  it.each([
    ["入力なし", ["--pr", "1"], "入力 HTML を 1 つ"],
    ["HTML 以外の入力", ["input.txt", "--pr", "1"], ".html"],
    ["--pr なし", ["input.html"], "--pr"],
    ["整数でない --pr", ["input.html", "--pr", "abc"], "整数"],
    ["不正な --mode", ["input.html", "--pr", "1", "--mode", "zip"], "--mode"],
    ["不明なオプション", ["input.html", "--pr", "1", "--png"], "不明なオプション"],
  ])("%s は non-zero と日本語エラーで失敗する", async (_name, args, keyword) => {
    const result = await runPublishScript(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(keyword);
    expect(result.stderr).toContain("使い方");
  });

  it("外部参照を含む HTML は公開せずに失敗する", async () => {
    const input = join(workDir, "external.html");
    await writeFile(
      input,
      '<!doctype html><html><script src="https://cdn.example.com/x.js"></script></html>',
      "utf-8",
    );
    const result = await runPublishScript([input, "--pr", "1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("説明資料の契約に違反しています");
    expect(result.stderr).toContain("外部リソース");
  });

  it("workflow テンプレートと .github/workflows/pr-explainer.yml は一致し、公開手順の契約を満たす", async () => {
    const template = await readRepoFile("skills/gh-gantt-pr/templates/pr-explainer.yml");
    const installed = await readRepoFile(".github/workflows/pr-explainer.yml");

    expect(installed).toBe(template);

    // 起動と輸送路
    expect(template).toContain("workflow_dispatch:");
    expect(template).toContain("html:");
    expect(template).toContain("source_branch:");
    expect(template).toContain("^pr-explainer/");
    expect(template).not.toContain("issue_comment");
    expect(template).not.toContain("pull_request:");

    // zip なし artifact と保持期間
    expect(template).toContain("archive: false");
    expect(template).toContain("retention-days: 90");
    expect(template).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v7/);
    expect(template).toMatch(/actions\/checkout@[0-9a-f]{40} # v6/);

    // PR にはリンク 1 行の sticky comment だけを書き、HTML 本文は書かない
    expect(template).toContain("<!-- pr-explainer -->");
    expect(template).toContain("--paginate");
    expect(template).not.toContain("cat explainer.html");
    expect(template).not.toContain("<details>");

    // 権限: 既定は read、一時 branch の削除だけ contents: write を別 job に隔離する
    const publishJob = template.slice(
      template.indexOf("  publish:"),
      template.indexOf("  cleanup:"),
    );
    const cleanupJob = template.slice(template.indexOf("  cleanup:"));
    expect(publishJob).toContain("contents: read");
    expect(publishJob).toContain("pull-requests: write");
    expect(publishJob).not.toContain("contents: write");
    expect(cleanupJob).toContain("contents: write");
    expect(cleanupJob).toContain("if: inputs.source_branch != ''");
    expect(cleanupJob).toContain("git/refs/heads/${SOURCE_BRANCH}");
  });
});
