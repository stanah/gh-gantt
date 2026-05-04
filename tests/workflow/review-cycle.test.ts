import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildProgram } from "../../packages/cli/src/program.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

const ReleasePleaseExtraFileSchema = z.object({
  type: z.literal("json"),
  path: z.string(),
  jsonpath: z.string(),
});
const ReleasePleasePackageConfigSchema = z
  .object({
    component: z.string().optional(),
    "extra-files": z.array(ReleasePleaseExtraFileSchema).optional(),
  })
  .passthrough();
const ReleasePleaseConfigSchema = z
  .object({
    packages: z.record(ReleasePleasePackageConfigSchema),
  })
  .passthrough();
const ReleasePleaseManifestSchema = z.record(z.string());

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf-8");
}

function extractCaseBlock(script: string, label: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${label})`);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line.trim() === ";;");
  expect(end).toBeGreaterThan(start);

  return lines.slice(start, end + 1).join("\n");
}

function extractBetween(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = content.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end);
}

function extractMarkdownSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextHeading = content.indexOf("\n## ", start + heading.length);
  return content.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

async function runReviewCycleWithMockGh(
  coderabbitPass: boolean,
): Promise<{ stdout: string; stderr: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "gh-gantt-review-cycle-"));
  const mockGhPath = join(tempDir, "gh");
  const mockGh = `#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi

if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf 'stanah/gh-gantt\\n'
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '222\\thttps://github.com/stanah/gh-gantt/pull/222\\tOPEN\\tfalse\\thead-sha\\tNONE\\t2026-05-03T22:00:00Z\\n'
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  if [ "\${MOCK_CODERABBIT_PASS:-0}" = "1" ]; then
    printf '4\\t0\\t0\\t1\\n'
  else
    printf '4\\t0\\t0\\t0\\n'
  fi
  exit 0
fi

if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  args="$*"
  if [[ "$args" == *"reviewThreads(first: 100"* ]]; then
    printf '0\\tfalse\\t\\n'
    exit 0
  fi
  if [[ "$args" == *"comments(last: 20)"* ]]; then
    printf '2026-05-03T22:00:00Z\\tfalse\\n'
    printf '2026-05-03T22:01:00Z\\ttrue\\n'
    exit 0
  fi
fi

printf 'unexpected gh invocation: %s\\n' "$*" >&2
exit 1
`;

  try {
    await writeFile(mockGhPath, mockGh);
    await chmod(mockGhPath, 0o755);
    return await execFileAsync(
      "bash",
      ["skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh", "--pr", "222", "--no-wait"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          MOCK_CODERABBIT_PASS: coderabbitPass ? "1" : "0",
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        },
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("[NFR-STABILITY-005-AC1] PR 後レビューサイクル検出 workflow", () => {
  it("Claude hooks ではなく gh-gantt-workflow skill 付属 script を正本にする", async () => {
    const raw = await readRepoFile(".claude/settings.json");
    const settings = JSON.parse(raw) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>>;
    };

    const allHookCommands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command ?? "")),
    );
    const workflow = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");

    expect(allHookCommands.join("\n")).not.toContain("pr-review-cycle");
    expect(workflow).toContain("skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh");
  });

  it("wait script が gh pr / gh api graphql で非同期 review surface の安定を待つ", async () => {
    const script = await readRepoFile("skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh");

    expect(script).toContain("gh pr checks");
    expect(script).toContain('.bucket != "skipping"');
    expect(script).toContain("gh pr view");
    expect(script).toContain("--json number,url,state,isDraft,headRefOid,reviewDecision,updatedAt");
    expect(script).toContain("reviewDecision");
    expect(script).toContain('then "NONE" else .reviewDecision end');
    expect(script).not.toContain('then "UNKNOWN" else .reviewDecision end');
    expect(script).toContain('[ "$review_decision" = "UNKNOWN" ] && return 0');
    expect(script).toContain('review_decision="UNKNOWN"');
    expect(script).toContain("gh api graphql");
    expect(script).toContain("reviewThreads(first: 100, after: $cursor)");
    expect(script).toContain("pageInfo");
    expect(script).toContain("hasNextPage");
    expect(script).toContain("isResolved == false");
    expect(script).toContain("comments(last: 20)");
    expect(script).toContain("reviews(last: 20)");
    expect(script).toContain("reviewThreads(last: 50)");
    expect(script).toContain("checks_seen");
    expect(script).toContain("updatedAt");
    expect(script).toContain("rate limited by coderabbit.ai");
    expect(script).toContain("failed to list open PRs for repository");
    expect(script).toContain("quiet_seconds=180");
    expect(script).toContain("stable_samples=3");
    expect(script).toContain("timeout_seconds=900");
    expect(script).toContain("usage: $0 --pr <number>");
  });

  it("CodeRabbit status が成功済みなら rate-limit コメントだけで追対応扱いにしない", async () => {
    const script = await readRepoFile("skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh");
    const checkCounts = extractBetween(script, "check_counts() {", "\n}\n\ncollect_snapshot()");
    const collectSnapshot = extractBetween(
      script,
      "collect_snapshot() {",
      "\n}\n\nsnapshot_needs_followup()",
    );

    expect(checkCounts).toContain('contains("coderabbit")');
    expect(checkCounts).toContain('.bucket == "pass"');
    expect(collectSnapshot).toContain("coderabbit_pass");
    expect(collectSnapshot).toContain('[ "$rate_limit" = "1" ] && [ "$coderabbit_pass" -gt 0 ]');
    expect(collectSnapshot).toContain('rate_limit="0"');
    expect(collectSnapshot).toContain("UNKNOWN\\tUNKNOWN\\tUNKNOWN\\tUNKNOWN");
  });

  it("mock gh で CodeRabbit pass 時だけ rate-limit コメントを解除する", async () => {
    const passResult = await runReviewCycleWithMockGh(true);
    expect(passResult.stdout).toContain("- active CodeRabbit rate limit: 0");

    let failure: (Error & { code?: number; stdout?: string }) | undefined;
    try {
      await runReviewCycleWithMockGh(false);
    } catch (error) {
      failure = error as Error & { code?: number; stdout?: string };
    }

    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toContain("- active CodeRabbit rate limit: 1");
  });

  it("セッションをまたぐ入口として all-open sweep を固定する", async () => {
    const reference = await readRepoFile("skills/gh-gantt-workflow/references/pr-review-cycle.md");

    expect(reference).toContain("--all-open --no-wait");
  });

  it("完了判定前にリポジトリのオープン PR 全件 sweep を必須にする", async () => {
    const workflow = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");
    const reference = await readRepoFile("skills/gh-gantt-workflow/references/pr-review-cycle.md");
    const script = await readRepoFile("skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh");
    const basicTemplate = await readRepoFile(
      "skills/gh-gantt-workflow/templates/workflow.basic.md",
    );
    const superpowersTemplate = await readRepoFile(
      "skills/gh-gantt-workflow/templates/workflow.superpowers.md",
    );
    const allOpenBlock = extractCaseBlock(script, "all-open");
    const skillSessionStartStep = extractBetween(
      workflow,
      "0. **★`on_session_start`",
      "\n1. **REQUIRED:**",
    );
    const basicReviewReceived = extractMarkdownSection(basicTemplate, "## on_review_received");
    const basicSessionEnd = extractMarkdownSection(basicTemplate, "## on_session_end");
    const superpowersSessionEnd = extractMarkdownSection(superpowersTemplate, "## on_session_end");

    expect(workflow).toContain("リポジトリのオープン PR 全件");
    expect(workflow).toContain("pr-review-cycle-wait.sh --all-open");
    expect(workflow).toContain("`CHANGES_REQUESTED`");
    expect(workflow).toContain("追対応条件が 0 件");
    expect(workflow).toContain("quiet window と stable samples");
    expect(reference).toContain("完了報告前");
    expect(reference).toContain(
      "完了報告前: `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --all-open`",
    );
    expect(reference).not.toContain(
      "完了報告前: `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --all-open --no-wait`",
    );
    expect(reference).toContain("リポジトリのオープン PR 全件");
    expect(reference).toContain("`NONE`");
    expect(reference).toContain("API 取得失敗を示す `UNKNOWN`");
    expect(script).toContain("failed to list open PRs for repository");
    expect(allOpenBlock).toContain("gh api --paginate");
    expect(allOpenBlock).toContain("pulls?state=open&per_page=100");
    expect(allOpenBlock).not.toContain("--author @me");
    expect(basicTemplate).toContain("gh api --paginate");
    expect(superpowersTemplate).toContain("gh api --paginate");
    expect(basicTemplate).not.toContain("gh pr list --state open");
    expect(superpowersTemplate).not.toContain("gh pr list --state open");
    expect(skillSessionStartStep).not.toContain("pr-review-cycle-wait.sh --all-open");
    expect(basicSessionEnd).not.toContain("pr-review-cycle-wait.sh --all-open");
    expect(superpowersSessionEnd).not.toContain("pr-review-cycle-wait.sh --all-open");
    expect(basicReviewReceived).not.toContain("\n\n- **軽微な修正**");
    expect(basicReviewReceived).toContain("\n    - **軽微な修正**");
  });

  it("ADR-010 は PR 後レビューサイクルの正本を ADR-013 に委譲する", async () => {
    const adr010 = await readRepoFile("docs/adr/ADR-010-three-layer-workflow-guard.md");
    const adr013 = await readRepoFile("docs/adr/ADR-013-pr-review-cycle-as-agent-workflow.md");

    expect(adr010).toContain("ADR-013");
    expect(adr010).toContain("正本");
    expect(adr010).not.toContain("addPullRequestReviewThreadReply");
    expect(adr013).toContain("ADR-010");
    expect(adr013).toContain("supersede");
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

describe("[NFR-STABILITY-007-AC1] lint gate は未追跡 worktree と生成 CHANGELOG を検査対象に含めない", () => {
  it("pnpm lint を tracked file 限定かつ生成 CHANGELOG 除外の vp check として定義し hook と CI から使う", async () => {
    const packageJsonRaw = await readRepoFile("package.json");
    const packageJson = JSON.parse(packageJsonRaw) as { scripts: Record<string, string> };
    const lefthook = await readRepoFile("lefthook.yml");
    const ci = await readRepoFile(".github/workflows/ci.yml");

    expect(packageJson.scripts.lint).toBe(
      "git ls-files -z -- . ':(exclude)CHANGELOG.md' ':(exclude)packages/*/CHANGELOG.md' | xargs -0 vp check",
    );
    expect(lefthook).toContain("run: pnpm lint < /dev/null");
    expect(lefthook).not.toContain("run: vp check < /dev/null");
    expect(ci).toContain("vp run lint");
    expect(ci).not.toContain("run: vp check");
  });
});

describe("[NFR-STABILITY-007-AC1] Release Please 設定", () => {
  it("GitHub Release と CHANGELOG を root component に統合し package version だけ同期する", async () => {
    const configRaw = await readRepoFile("release-please-config.json");
    const manifestRaw = await readRepoFile(".release-please-manifest.json");
    const config = ReleasePleaseConfigSchema.parse(JSON.parse(configRaw));
    const manifest = ReleasePleaseManifestSchema.parse(JSON.parse(manifestRaw));

    expect(config["linked-versions"]).toBeUndefined();
    expect(config["group-pull-request-title-pattern"]).toBeUndefined();
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(Object.keys(manifest)).toEqual(["."]);
    expect(config.packages["."]?.component).toBe("gh-gantt");
    expect(config.packages["."]?.["extra-files"]).toEqual([
      {
        type: "json",
        path: "packages/cli/package.json",
        jsonpath: "$.version",
      },
      {
        type: "json",
        path: "packages/shared/package.json",
        jsonpath: "$.version",
      },
      {
        type: "json",
        path: "packages/ui/package.json",
        jsonpath: "$.version",
      },
    ]);
  });
});
