import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checkExplainer } from "../../skills/gh-gantt-pr/scripts/check-explainer.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(repoRoot, "skills/gh-gantt-pr/scripts/check-explainer.mjs");
const execFileAsync = promisify(execFile);

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf-8");
}

async function runChecker(args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync(process.execPath, [checker, ...args], { encoding: "utf8" });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
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

describe("[NFR-STABILITY-008-AC5] gh-gantt-pr skill は PR body の型と任意拡張（添付、スタック PR）を定義する", () => {
  it("SKILL.md は読みやすさの型と、任意拡張への判断表を持つ", async () => {
    const skill = await readRepoFile("skills/gh-gantt-pr/SKILL.md");

    expect(skill).toContain("前提なしで読める 1 文");
    expect(skill).toContain("Summary は 5 行以内");
    expect(skill).toContain("太字を使わず");
    expect(skill).toContain("HTML の本文を PR に貼らない");
    expect(skill).toContain("ADR-027");
    expect(skill).toContain("references/attachments.md");
    expect(skill).toContain("references/stacked-pr.md");
  });

  it("添付 reference は gh 2.99.0 の --attach を画像と動画に限り、上限と fallback を定める", async () => {
    const reference = await readRepoFile("skills/gh-gantt-pr/references/attachments.md");

    expect(reference).toContain("gh 2.99.0 以上");
    expect(reference).toContain("HTML や PDF は添付できない");
    expect(reference).toContain("3 枚まで");
    expect(reference).toContain("betterleaks");
    expect(reference).toContain("gh pr edit <number> --attach <file>");
    expect(reference).toContain("図解を静止画にしない");
    expect(reference).not.toContain("--body <body>");
  });

  it("スタック PR reference は分ける基準、層ごとの branch 名、Issue link の配置、手動の fallback を定める", async () => {
    const reference = await readRepoFile("skills/gh-gantt-pr/references/stacked-pr.md");

    expect(reference).toContain("各層が単独で CI を通せる");
    expect(reference).toContain("<prefix>/issue-<number>-<slug>/<k>-<layer>");
    expect(reference).toContain("最上層だけ `Closes #<issue-number>`");
    expect(reference).toContain("Part of #<issue-number>");
    expect(reference).toContain("ADR-019");
    expect(reference).toContain("gh extension install github/gh-stack");
    expect(reference).toContain(
      "gh pr create --base <lower-branch> --head <upper-branch> --title <title> --body-file <body-file>",
    );
    expect(reference).toContain("pr-review-cycle-wait.sh --pr <number>");
  });

  it("ADR-027 は決定と却下した案を記録する", async () => {
    const adr = await readRepoFile("docs/adr/ADR-027-pr-cognitive-load-reduction.md");

    expect(adr).toContain("status: accepted");
    expect(adr).toContain("- NFR-STABILITY-008");
    expect(adr).toContain("## Alternatives");
    expect(adr).toContain("HTML を PNG に変換して `--attach` する");
    expect(adr).toContain("HTML を PR コメントに埋め込み");
    expect(adr).toContain("GitHub Pages に PR ごとの path で配置する");
  });
});

describe("[NFR-STABILITY-008-AC6] 説明資料は単一 HTML を一時 branch の workflow で artifact として公開する", () => {
  const html = (body: string) => `<!doctype html><html>${body}</html>`;

  it("契約検証: HTML 文書でない場合と、data: URI 以外の別ファイル参照を検出する", () => {
    expect(checkExplainer(html("<script>1</script><style>body{}</style>"))).toEqual([]);
    expect(checkExplainer("hello")).toEqual(["HTML 文書ではない"]);
    for (const bad of [
      '<script src="https://cdn.example.com/x.js"></script>',
      '<img src="./x.png">',
      '<link rel="stylesheet" href="/a.css">',
      '<video poster="p.jpg"></video>',
      '<object data="d.pdf"></object>',
    ]) {
      expect(checkExplainer(html(bad)), bad).toEqual([
        "src、href、poster、data に data: URI 以外の参照がある",
      ]);
    }
    // srcset は先頭だけでなく全候補を見る。data: URI 内のカンマで誤って区切らない
    for (const bad of [
      '<img srcset="a.png 1x, b.png 2x">',
      '<img srcset="data:image/png;base64,AA 1x, ./x.png 2x">',
      "<source srcset='data:image/png;base64,AA 640w, x.png 1280w'>",
    ]) {
      expect(checkExplainer(html(bad)), bad).toEqual(["srcset に data: URI 以外の候補がある"]);
    }
    expect(
      checkExplainer(
        html('<img srcset="data:image/png;base64,AA 1x, data:image/png;base64,BB 2x">'),
      ),
    ).toEqual([]);
    expect(checkExplainer(html('<style>@import "./x.css";</style>'))).toEqual([
      "@import は別ファイルの読み込み",
    ]);
    expect(checkExplainer(html("<style>body{background:url(./x.png)}</style>"))).toEqual([
      "url() に data: URI と #fragment 以外の参照がある",
    ]);
    // 許可: data: URI、#fragment、通常のリンク
    expect(
      checkExplainer(
        html(
          '<img src="data:image/png;base64,AA"><style>.a{fill:url(#g)}.b{background:url(data:image/svg+xml,x)}</style><a href="https://github.com/">x</a>',
        ),
      ),
    ).toEqual([]);
  });

  it("契約検証の CLI は違反で 1、引数なしで 2 を返す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-gantt-explainer-"));
    try {
      const ok = join(dir, "ok.html");
      const bad = join(dir, "bad.html");
      await writeFile(ok, html("<p>ok</p>"), "utf-8");
      await writeFile(bad, html('<img src="./x.png">'), "utf-8");
      expect(await runChecker([ok])).toMatchObject({ code: 0 });
      expect(await runChecker([bad])).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("違反"),
      });
      expect(await runChecker([])).toMatchObject({
        code: 2,
        stderr: expect.stringContaining("使い方"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("workflow テンプレートは配置済みの workflow と一致し、push 起動、契約検証、zip なし artifact、sticky comment、branch 削除を持つ", async () => {
    const template = await readRepoFile("skills/gh-gantt-pr/templates/pr-explainer.yml");
    const installed = await readRepoFile(".github/workflows/pr-explainer.yml");

    expect(installed).toBe(template);
    expect(template).toContain('branches: ["pr-explainer/**"]');
    expect(template).not.toContain("workflow_dispatch");
    expect(template).toContain(
      "node skills/gh-gantt-pr/scripts/check-explainer.mjs explainer.html",
    );
    expect(template).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v7/);
    expect(template).toContain("archive: false");
    expect(template).toContain("retention-days: 90");
    expect(template).toContain("<!-- pr-explainer -->");
    expect(template).toContain("--paginate");
    expect(template).toContain("git/refs/heads/$GITHUB_REF_NAME");
  });

  it("説明資料 reference は git 管理外の出力、PR に HTML を書かない規則、一時 branch の手順、制約を定める", async () => {
    const reference = await readRepoFile("skills/gh-gantt-pr/references/pr-explainer.md");
    const skill = await readRepoFile("skills/gh-gantt-pr/SKILL.md");

    expect(skill).toContain("references/pr-explainer.md");
    expect(reference).toContain("git 管理外に置く");
    expect(reference).toContain(".gantt-sync/pr-explainer/<issue-number>/");
    expect(reference).toContain("HTML の本文を PR body やコメントに貼らない");
    expect(reference).toContain("check-explainer.mjs");
    expect(reference).toContain('-b "pr-explainer/<number>-');
    expect(reference).toContain("--no-verify");
    expect(reference).toContain("read 権限と GitHub へのログイン");
    expect(reference).toContain("90 日で失効");
    expect(reference).toContain("Mermaid とテキストに留める");
  });
});
