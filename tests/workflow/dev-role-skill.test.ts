import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const skillDir = "skills/gh-gantt-dev-role";
const roles = ["orchestrator", "planner", "implementer", "executor", "reviewer"] as const;

async function readRepoFile(path: string): Promise<string> {
  const content = await readFile(resolve(repoRoot, path), "utf-8");
  return z.string().min(1).parse(content);
}

function extractMarkdownSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextHeading = content.indexOf("\n## ", start + heading.length);
  return content.slice(start, nextHeading === -1 ? undefined : nextHeading);
}

describe("[NFR-STABILITY-010-AC1] gh-gantt-dev-role skill は5ロールを dispatch する", () => {
  it("frontmatter、role 入力、reference 読み込み手順を定義している", async () => {
    const skill = await readRepoFile(`${skillDir}/SKILL.md`);

    expect(skill).toContain("name: gh-gantt-dev-role");
    expect(skill).toContain("role");
    for (const role of roles) {
      expect(skill).toContain(role);
      expect(skill).toContain(`references/${role}.md`);
    }
    expect(skill).toContain("Role Dispatch");
    expect(skill).toContain("対応する reference を読む");
  });
});

describe("[NFR-STABILITY-010-AC2] gh-gantt-dev-role skill は共通 HARD-GATE を定義する", () => {
  it("Dev-Role Config、valid role、schema 検証、同期データの直接参照禁止を明記する", async () => {
    const skill = await readRepoFile(`${skillDir}/SKILL.md`);
    const hardGate = extractMarkdownSection(skill, "<HARD-GATE>");

    expect(hardGate).toContain("role");
    expect(hardGate).toContain("Dev-Role Config");
    expect(hardGate).toContain("templates/*.schema.json");
    expect(hardGate).toContain("verifyCommands");
    expect(skill).toContain(".gantt-sync/workflow.md");
    expect(skill).toContain(".dev-flow/config.json");
    expect(skill).toContain(
      "`.gantt-sync/tasks.json` と `.gantt-sync/sync-state.json` は読み込まないでください",
    );
    expect(skill).not.toContain("cat .gantt-sync/tasks.json");
    expect(skill).not.toContain("cat .gantt-sync/sync-state.json");
  });
});

describe("[NFR-STABILITY-010-AC3] dev-role reference は role ごとの契約を持つ", () => {
  it("各 reference に HARD-GATE、手順、出力契約、Red Flags、agent 留意点がある", async () => {
    for (const role of roles) {
      const reference = await readRepoFile(`${skillDir}/references/${role}.md`);

      expect(reference).toContain(`role: ${role}`);
      expect(reference).toContain("<HARD-GATE>");
      expect(reference).toContain("## 手順");
      expect(reference).toContain("## 出力契約");
      expect(reference).toContain("## Red Flags");
      expect(reference).toContain("## エージェント別の留意点");
    }
  });

  it("executor は verifyCommands を直列実行する PR 前 gate として定義されている", async () => {
    const executor = await readRepoFile(`${skillDir}/references/executor.md`);

    expect(executor).toContain("verifyCommands");
    expect(executor).toContain("定義順に直列実行");
    expect(executor).toContain("non-zero");
    expect(executor).toContain("コード修正、レビュー、PR 作成は行わない");
    expect(executor).toContain("次 role");
    expect(executor).toContain("reviewer");
  });
});

describe("[NFR-STABILITY-010-AC4] dev-role skill は構造化 artifact schema と rubric を提供する", () => {
  it("5つの JSON Schema は parse でき、主要 required field を持つ", async () => {
    const schemaExpectations = [
      ["plan.schema.json", "issueNumber", "verificationSteps"],
      ["impl-result.schema.json", "changedFiles", "nextRole"],
      ["verify-result.schema.json", "commands", "summary"],
      ["review.schema.json", "verdict", "findings"],
      ["dev-role-config.schema.json", "verifyCommands", "maxImprovementIterations"],
    ] as const;

    for (const [file, firstField, secondField] of schemaExpectations) {
      const schema = JSON.parse(await readRepoFile(`${skillDir}/templates/${file}`)) as {
        properties: Record<string, unknown>;
      };

      expect(schema.properties).toHaveProperty(firstField);
      expect(schema.properties).toHaveProperty(secondField);
    }
  });

  it("schema 間の action / nextRole / findings 契約が揃っている", async () => {
    const implSchema = JSON.parse(
      await readRepoFile(`${skillDir}/templates/impl-result.schema.json`),
    ) as {
      properties: {
        changedFiles: {
          items: { properties: { action: { enum: string[] } } };
        };
      };
    };
    const verifySchema = JSON.parse(
      await readRepoFile(`${skillDir}/templates/verify-result.schema.json`),
    ) as {
      required: string[];
    };
    const reviewSchema = JSON.parse(
      await readRepoFile(`${skillDir}/templates/review.schema.json`),
    ) as {
      allOf: Array<{
        if?: { properties?: { verdict?: { enum?: string[] } } };
        then?: { properties?: { findings?: { minItems?: number } } };
      }>;
    };

    expect(implSchema.properties.changedFiles.items.properties.action.enum).toEqual([
      "create",
      "modify",
      "delete",
    ]);
    expect(verifySchema.required).toContain("nextRole");
    const strictVerdictCondition = reviewSchema.allOf.find((entry) =>
      entry.if?.properties?.verdict?.enum?.includes("block"),
    );
    expect(strictVerdictCondition?.if?.properties?.verdict?.enum).toEqual([
      "request-changes",
      "block",
    ]);
    expect(strictVerdictCondition?.["then"]?.properties?.findings?.minItems).toBe(1);
  });

  it("default review rubric は採点観点と severity を定義する", async () => {
    const rubric = await readRepoFile(`${skillDir}/templates/review-rubric.md`);

    expect(rubric).toContain("要件整合");
    expect(rubric).toContain("検証証跡");
    expect(rubric).toContain("critical");
    expect(rubric).toContain("major");
    expect(rubric).toContain("Yes-Man");
  });
});

describe("[NFR-STABILITY-010-AC5] 既存 workflow と AGENTS は gh-gantt-dev-role へ導線を持つ", () => {
  it("workflow は Dev-Role Config がある場合に role orchestrator へ引き継ぐ", async () => {
    const workflow = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");

    expect(workflow).toContain("ロール分離された開発・検証は gh-gantt-dev-role");
    expect(workflow).toContain("`gh-gantt-dev-role role=orchestrator`");
    expect(workflow).toContain("executor gate");
  });

  it("AGENTS.md の skill 一覧に gh-gantt-dev-role が含まれる", async () => {
    const agents = await readRepoFile("AGENTS.md");

    expect(agents).toContain("`gh-gantt-dev-role`");
    expect(agents).toContain("orchestrator / planner / implementer / executor / reviewer");
    expect(agents).toContain("PR 前の独立検証");
  });
});
