import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../program.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf-8");
}

describe("[NFR-STABILITY-005-AC1] PR 後レビューサイクル検出 workflow", () => {
  it("Claude hooks が gh ベースの review-cycle check を PR 作成後・push 後・次セッションで起動する", async () => {
    const raw = await readRepoFile(".claude/settings.json");
    const settings = JSON.parse(raw) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>>;
    };

    const postToolUseCommands = settings.hooks.PostToolUse.flatMap((entry) =>
      entry.hooks.map((hook) => `${entry.matcher ?? ""} ${hook.command ?? ""}`),
    );
    const promptCommands = settings.hooks.UserPromptSubmit.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command ?? ""),
    );

    expect(postToolUseCommands).toContain(
      "Bash(gh pr create*) bash .claude/hooks/pr-review-cycle-check.sh --current-branch",
    );
    expect(postToolUseCommands).toContain(
      "Bash(git push*) bash .claude/hooks/pr-review-cycle-check.sh --current-branch",
    );
    expect(promptCommands).toContain("bash .claude/hooks/pr-review-cycle-check.sh --all-open");
  });

  it("hook script が gh pr / gh api graphql で check・reviewDecision・未解決 thread を検出する", async () => {
    const script = await readRepoFile(".claude/hooks/pr-review-cycle-check.sh");

    expect(script).toContain("gh pr checks");
    expect(script).toContain("gh pr view");
    expect(script).toContain("reviewDecision");
    expect(script).toContain("gh api graphql");
    expect(script).toContain("reviewThreads(first: 100)");
    expect(script).toContain("isResolved == false");
  });
});

describe("[NFR-STABILITY-005-AC2] PR レビュー対応投稿 workflow", () => {
  it("workflow reference が pending review submit と GraphQL alias resolve を gh で標準化する", async () => {
    const reference = await readRepoFile("skills/gh-gantt-workflow/references/pr-review-cycle.md");

    expect(reference).toContain("gh api graphql");
    expect(reference).toContain("addPullRequestReview");
    expect(reference).toContain("addPullRequestReviewThreadReply");
    expect(reference).toContain("submitPullRequestReview");
    expect(reference).toContain("resolve0: resolveReviewThread");
    expect(reference).toContain("resolve1: resolveReviewThread");
  });

  it("PR review automation を gh-gantt 製品 CLI として登録しない", async () => {
    const packageJsonRaw = await readRepoFile("package.json");
    const packageJson = JSON.parse(packageJsonRaw) as { scripts: Record<string, string> };
    const commandNames = buildProgram().commands.map((command) => command.name());

    expect(packageJson.scripts["review:check"]).toBeUndefined();
    expect(packageJson.scripts["review:submit"]).toBeUndefined();
    expect(commandNames).not.toContain("review-cycle");
  });
});
