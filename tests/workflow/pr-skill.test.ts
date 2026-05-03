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
    expect(skill).toContain("`chore`");
    expect(skill).toContain("fix/issue-52-undo-drag-bug");
    expect(skill).toContain("feat/issue-44-label-filter");
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
      "gh pr create --base <base> --head <branch> --title <title> --body <body>",
    );
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
