import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRequirementsCoverageReport,
  generateRequirementsCoverageArtifacts,
  renderRequirementsCoverageMarkdown,
} from "../../scripts/lib/requirements-coverage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("[NFR-STABILITY-006-AC1] 要件とテストから生成する機能網羅レポート", () => {
  it("Area / Requirement / AC / Test file 別の網羅状況を Markdown と JSON に出力する", async () => {
    const report = buildRequirementsCoverageReport(makeRequirements());
    const markdown = renderRequirementsCoverageMarkdown(report);

    expect(report.summary.acceptance_criteria).toEqual({
      total: 3,
      covered: 1,
      failing: 1,
      uncovered: 1,
      coverage_percent: 33.3,
    });
    expect(report.areas).toMatchObject([
      {
        id: "CLI",
        requirements: 2,
        acceptance_criteria: {
          total: 3,
          covered: 1,
          failing: 1,
          uncovered: 1,
          coverage_percent: 33.3,
        },
      },
    ]);
    expect(report.requirements).toMatchObject([
      {
        id: "FR-CLI-999",
        status: "partial",
        tests: ["packages/cli/src/__tests__/example.test.ts"],
      },
      {
        id: "NFR-CLI-999",
        status: "failing",
        tests: ["tests/workflow/example.test.ts"],
      },
    ]);
    expect(report.test_files).toEqual([
      {
        path: "packages/cli/src/__tests__/example.test.ts",
        acceptance_criteria: ["FR-CLI-999-AC1"],
      },
      {
        path: "tests/workflow/example.test.ts",
        acceptance_criteria: ["NFR-CLI-999-AC1"],
      },
    ]);
    expect(markdown).toContain("| CLI | Command Line | 2 | 3 | 1 | 1 | 1 | 33.3% |");
    expect(markdown).toContain("| FR-CLI-999-AC2 | FR-CLI-999 | 未カバーの振る舞い | - |");
    expect(markdown).toContain("| tests/workflow/example.test.ts | 1 | NFR-CLI-999-AC1 |");
  });
});

describe("[NFR-STABILITY-006-AC2] 要件網羅レポートは再生成で更新される", () => {
  it("生成物が非決定的な日時を含まず docs/generated 配下へ書き出される", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "gh-gantt-coverage-"));
    tempDirs.push(outDir);

    const { markdownPath, jsonPath, report } = await generateRequirementsCoverageArtifacts({
      requirementsPath: "docs/requirements.yaml",
      outDir,
      sourceLabel: "docs/requirements.yaml",
    });
    const markdown = await readFile(markdownPath, "utf-8");
    const json = JSON.parse(await readFile(jsonPath, "utf-8")) as typeof report;

    expect(markdownPath).toBe(join(outDir, "requirements-coverage.md"));
    expect(jsonPath).toBe(join(outDir, "requirements-coverage.json"));
    expect(markdown).toContain("このファイルは `pnpm docs:gen` が生成する表示用ドキュメントです。");
    expect(markdown).toContain("手で編集してはいけません。");
    expect(markdown).not.toMatch(/generated_at|generatedAt|生成日時|Generated at/);
    expect(JSON.stringify(json)).not.toMatch(/generated_at|generatedAt|生成日時|Generated at/);
    expect(json.source).toBe("docs/requirements.yaml");
  });

  it("空の Area / Requirement 定義を不正な requirements.yaml として拒否する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-gantt-coverage-invalid-"));
    tempDirs.push(dir);

    const cases = [
      {
        name: "empty-requirements",
        yaml: `version: "1.0"
vision: fixture
areas:
  - id: CLI
    name: Command Line
    description: fixture
    requirements: []
`,
      },
      {
        name: "empty-acceptance-criteria",
        yaml: `version: "1.0"
vision: fixture
areas:
  - id: CLI
    name: Command Line
    description: fixture
    requirements:
      - id: FR-CLI-999
        summary: fixture requirement
        acceptance_criteria: []
`,
      },
    ];

    for (const testCase of cases) {
      const requirementsPath = join(dir, `${testCase.name}.yaml`);
      await writeFile(requirementsPath, testCase.yaml, "utf-8");

      await expect(
        generateRequirementsCoverageArtifacts({
          requirementsPath,
          outDir: join(dir, `${testCase.name}-generated`),
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
  });
});

function makeRequirements() {
  return {
    version: "1.0",
    vision: "fixture",
    areas: [
      {
        id: "CLI",
        name: "Command Line",
        description: "fixture",
        requirements: [
          {
            id: "FR-CLI-999",
            summary: "fixture requirement",
            acceptance_criteria: [
              {
                id: "FR-CLI-999-AC1",
                description: "カバー済みの振る舞い",
                status: "covered" as const,
                tests: ["packages/cli/src/__tests__/example.test.ts"],
              },
              {
                id: "FR-CLI-999-AC2",
                description: "未カバーの振る舞い",
                status: "uncovered" as const,
                tests: [],
              },
            ],
          },
          {
            id: "NFR-CLI-999",
            summary: "fixture reliability",
            acceptance_criteria: [
              {
                id: "NFR-CLI-999-AC1",
                description: "失敗中の振る舞い",
                status: "failing" as const,
                tests: ["tests/workflow/example.test.ts"],
              },
            ],
          },
        ],
      },
    ],
  };
}
