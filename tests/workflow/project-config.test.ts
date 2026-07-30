import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../packages/shared/src/schema.js";

const repoRoot = resolve(import.meta.dirname, "../..");

async function readRepoFile(path: string): Promise<string> {
  const content = await readFile(resolve(repoRoot, path), "utf-8");
  return z.string().min(1).parse(content);
}

const DevRoleConfigSchema = z.object({
  verifyCommands: z.array(z.string().min(1)),
});

function parseDevRoleConfig(workflow: string): z.infer<typeof DevRoleConfigSchema> {
  const fencedYaml = workflow.match(/## Dev-Role Config[\s\S]*?```yaml\n([\s\S]*?)\n```/)?.[1];
  const parsedYaml = parse(z.string().min(1).parse(fencedYaml));
  return DevRoleConfigSchema.parse(parsedYaml);
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const contentAfterHeading = markdown.split(`${heading}\n`)[1];
  return z.string().min(1).parse(contentAfterHeading).split("\n## ")[0] ?? "";
}

function extractBashCommands(markdown: string, heading: string): string[] {
  const section = extractMarkdownSection(markdown, heading);
  const fencedBash = section.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  const commands = z
    .string()
    .min(1)
    .parse(fencedBash)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return z.array(z.string().min(1)).min(1).parse(commands);
}

describe("[NFR-STABILITY-013-AC1] 共有 project config は schema 検証を通過し、確定した階層とコンフリクトポリシーだけを保持する", () => {
  it("実configが確定値に一致しdeprecated fieldを持たない", async () => {
    const rawConfig = JSON.parse(await readRepoFile(".gantt-sync/gantt.config.json")) as {
      sync: Record<string, unknown> & { field_mapping: Record<string, unknown> };
    };

    const config = ConfigSchema.parse(rawConfig);

    expect(config.type_hierarchy).toEqual({
      task: [],
      epic: ["bug", "feature", "task"],
      feature: ["feature", "task"],
      bug: [],
      milestone: [],
    });
    expect(rawConfig.sync.conflict_policy).toEqual({
      state: "ours",
      start_date: "theirs",
      end_date: "theirs",
      milestone: "theirs",
      assignees: "theirs",
      labels: "theirs",
    });
    expect(rawConfig.sync).not.toHaveProperty("conflict_strategy");
    expect(rawConfig.sync.field_mapping).not.toHaveProperty("status");
  });
});

describe("[NFR-STABILITY-013-AC2] 共有 workflow は Living Documentation の機能領域と8段の Dev-Role PR前gateを定義する", () => {
  it("STABILITY領域と順序を含む8個のverifyCommandsを定義する", async () => {
    const workflow = await readRepoFile(".gantt-sync/workflow.md");
    const devRoleConfig = parseDevRoleConfig(workflow);

    expect(workflow).toContain("docs/adr/ADR-012-living-documentation-four-layer-system.md");
    expect(workflow).toContain(
      "- **機能領域コード**: `SYNC`, `HIER`, `VIS`, `CLI`, `API`, `STORE`, `STABILITY`",
    );
    expect(devRoleConfig.verifyCommands).toEqual([
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test:json",
      "pnpm build",
      "pnpm req:trace",
      "git diff --exit-code docs/requirements.yaml",
      "pnpm req:validate",
      "pnpm docs:gen",
    ]);
  });
});

describe("[NFR-STABILITY-013-AC3] AGENTS.md の新品クローン標準 bootstrap は build 後の local CLI pull / status / loop status だけを復元手順として定義する", () => {
  it("標準bootstrapのbash fenceがinitを含まない復元手順を定義する", async () => {
    const agents = await readRepoFile("AGENTS.md");
    const commands = extractBashCommands(agents, "## エフェメラル環境でのブートストラップ");

    expect(commands).toEqual([
      "pnpm install && pnpm build",
      "export GITHUB_TOKEN=<token>",
      "node packages/cli/dist/index.js pull",
      "node packages/cli/dist/index.js status",
      "node packages/cli/dist/index.js loop status",
    ]);
    expect(commands.join("\n")).not.toContain(" init ");
  });
});

describe("[NFR-STABILITY-013-AC4] AGENTS.md は config 未作成時だけ local CLI init を使い、既存 config では中止し、上書き時だけ --force を使う fallback を定義する", () => {
  it("initを標準復元から分離した安全なfallback条件を定義する", async () => {
    const agents = await readRepoFile("AGENTS.md");
    const bootstrapSection = extractMarkdownSection(
      agents,
      "## エフェメラル環境でのブートストラップ",
    );

    expect(bootstrapSection).toContain("config が未コミット・未作成の場合のみ");
    expect(bootstrapSection).toContain(
      "node packages/cli/dist/index.js init --owner <owner> --repo <repo> --project <N>",
    );
    expect(bootstrapSection).toContain("既存 config がある場合 init は中止する");
    expect(bootstrapSection).toContain("上書きは `--force`");
  });
});

describe("[NFR-STABILITY-014-AC1] 共有 project config が versioned Graph Contract を exact binding する", () => {
  it("config と workflow が同じ plan ID/version/schema version を参照する", async () => {
    const rawConfig = JSON.parse(await readRepoFile(".gantt-sync/gantt.config.json"));
    const config = ConfigSchema.parse(rawConfig);
    const workflow = await readRepoFile(".gantt-sync/workflow.md");

    expect(config.run_graph).toEqual({
      plan_id: "dev-role-fixed",
      plan_version: "1",
      schema_version: "1",
    });
    expect(workflow).toContain("plan_id: dev-role-fixed");
    expect(workflow).toContain('plan_version: "1"');
    expect(workflow).toContain('schema_version: "1"');
    expect(workflow).toContain("gh-gantt run start");
    expect(workflow).toContain("gh-gantt run event");
    expect(workflow).toContain("gh-gantt run show");
    expect(workflow).toContain("gh-gantt run resume");
    expect(workflow).toContain("gh-gantt run decide");
    expect(workflow).toContain("gh-gantt run observe-pr");
  });
});
