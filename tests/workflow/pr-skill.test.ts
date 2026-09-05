import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf-8");
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
