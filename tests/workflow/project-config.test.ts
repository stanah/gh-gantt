import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../packages/shared/src/schema.js";

const repoRoot = resolve(import.meta.dirname, "../..");

async function readRepoFile(path: string): Promise<string> {
  const content = await readFile(resolve(repoRoot, path), "utf-8");
  return z.string().min(1).parse(content);
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

describe("[NFR-STABILITY-013-AC2] 共有 workflow は Living Documentation と CI / pre-push を包含する PR 前 gate を定義する", () => {
  it("追跡中のADRと追加検査を含むPR前gateを参照する", async () => {
    const workflow = await readRepoFile(".gantt-sync/workflow.md");

    expect(workflow).toContain("docs/adr/ADR-012-living-documentation-four-layer-system.md");
    expect(workflow).toContain('- "pnpm lint"');
    expect(workflow).toContain(
      "CI / pre-push の検査を包含し、`typecheck` / `lint` も加えた PR 前 gate",
    );
  });
});

describe("[NFR-STABILITY-013-AC3] 新品クローンは build 後に local CLI だけで初期化・同期・状態確認できる", () => {
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
