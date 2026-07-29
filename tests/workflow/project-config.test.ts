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

describe("[NFR-STABILITY-013-AC3] AGENTS.md の新品クローン bootstrap 手順は build 後の local CLI init / pull / status / loop status を定義する", () => {
  it("build後のbootstrap手順がlocal CLI entrypointで完結する", async () => {
    const agents = await readRepoFile("AGENTS.md");

    expect(agents).toContain("pnpm install && pnpm build");
    expect(agents).toContain("node packages/cli/dist/index.js pull");
    expect(agents).toContain("node packages/cli/dist/index.js status");
    expect(agents).toContain("node packages/cli/dist/index.js loop status");
    expect(agents).toContain(
      "node packages/cli/dist/index.js init --owner <owner> --repo <repo> --project <N>",
    );
  });
});
