import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

type RequirementStatus = "covered" | "failing" | "partial" | "uncovered";

const AcceptanceStatusSchema = z.enum(["covered", "failing", "uncovered"]);
type AcceptanceStatus = z.infer<typeof AcceptanceStatusSchema>;

const AcceptanceCriteriaSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  status: AcceptanceStatusSchema,
  tests: z.array(z.string().min(1)),
});

const RequirementSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  acceptance_criteria: z.array(AcceptanceCriteriaSchema).min(1),
});

const AreaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  requirements: z.array(RequirementSchema).min(1),
});

const RequirementsSchema = z.object({
  version: z.string().min(1),
  vision: z.string().min(1),
  areas: z.array(AreaSchema).min(1),
});

type Requirements = z.infer<typeof RequirementsSchema>;

interface CountSummary {
  total: number;
  covered: number;
  failing: number;
  uncovered: number;
  coverage_percent: number;
}

interface AreaCoverage {
  id: string;
  name: string;
  requirements: number;
  acceptance_criteria: CountSummary;
}

interface RequirementCoverage {
  area_id: string;
  id: string;
  summary: string;
  status: RequirementStatus;
  acceptance_criteria: CountSummary;
  tests: string[];
}

interface AcceptanceCriteriaCoverage {
  area_id: string;
  requirement_id: string;
  requirement_summary: string;
  id: string;
  description: string;
  status: AcceptanceStatus;
  tests: string[];
}

interface TestFileCoverage {
  path: string;
  acceptance_criteria: string[];
}

export interface RequirementsCoverageReport {
  source: string;
  coverage_basis: string;
  summary: {
    areas: number;
    requirements: number;
    acceptance_criteria: CountSummary;
    test_files: number;
  };
  areas: AreaCoverage[];
  requirements: RequirementCoverage[];
  acceptance_criteria: AcceptanceCriteriaCoverage[];
  test_files: TestFileCoverage[];
}

export interface GenerateRequirementsCoverageOptions {
  requirementsPath: string;
  outDir: string;
  sourceLabel?: string;
}

export interface GeneratedRequirementsCoverageArtifacts {
  markdownPath: string;
  jsonPath: string;
  report: RequirementsCoverageReport;
}

export function buildRequirementsCoverageReport(
  requirements: Requirements,
  source = "docs/requirements.yaml",
): RequirementsCoverageReport {
  const acceptanceCriteria: AcceptanceCriteriaCoverage[] = [];
  const requirementRows: RequirementCoverage[] = [];
  const areaRows: AreaCoverage[] = [];
  const testMap = new Map<string, Set<string>>();

  for (const area of requirements.areas) {
    const areaCriteria: AcceptanceCriteriaCoverage[] = [];
    for (const requirement of area.requirements) {
      const criteria = requirement.acceptance_criteria.map((ac) => {
        const row: AcceptanceCriteriaCoverage = {
          area_id: area.id,
          requirement_id: requirement.id,
          requirement_summary: requirement.summary,
          id: ac.id,
          description: ac.description,
          status: ac.status,
          tests: [...ac.tests].sort(),
        };
        for (const test of row.tests) {
          const ids = testMap.get(test) ?? new Set<string>();
          ids.add(row.id);
          testMap.set(test, ids);
        }
        return row;
      });

      acceptanceCriteria.push(...criteria);
      areaCriteria.push(...criteria);

      const counts = summarizeCriteria(criteria);
      requirementRows.push({
        area_id: area.id,
        id: requirement.id,
        summary: requirement.summary,
        status: summarizeRequirementStatus(counts),
        acceptance_criteria: counts,
        tests: [...new Set(criteria.flatMap((ac) => ac.tests))].sort(),
      });
    }

    areaRows.push({
      id: area.id,
      name: area.name,
      requirements: area.requirements.length,
      acceptance_criteria: summarizeCriteria(areaCriteria),
    });
  }

  const testFiles = [...testMap.entries()]
    .map(([path, ids]) => ({
      path,
      acceptance_criteria: [...ids].sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    source,
    coverage_basis: "acceptance_criteria.status と tests[]",
    summary: {
      areas: requirements.areas.length,
      requirements: requirementRows.length,
      acceptance_criteria: summarizeCriteria(acceptanceCriteria),
      test_files: testFiles.length,
    },
    areas: areaRows,
    requirements: requirementRows,
    acceptance_criteria: acceptanceCriteria,
    test_files: testFiles,
  };
}

export function renderRequirementsCoverageMarkdown(report: RequirementsCoverageReport): string {
  const lines: string[] = [
    "# 要件・テスト網羅レポート",
    "",
    "> このファイルは `pnpm docs:gen` が生成する表示用ドキュメントです。",
    `> 正本は \`${report.source}\` の \`status\` と \`tests[]\` です。手で編集してはいけません。`,
    "",
    "## サマリー",
    "",
    "| 指標 | 値 |",
    "| --- | ---: |",
    `| Area | ${report.summary.areas} |`,
    `| Requirement | ${report.summary.requirements} |`,
    `| Acceptance Criteria | ${report.summary.acceptance_criteria.total} |`,
    `| Covered AC | ${report.summary.acceptance_criteria.covered} |`,
    `| Failing AC | ${report.summary.acceptance_criteria.failing} |`,
    `| Uncovered AC | ${report.summary.acceptance_criteria.uncovered} |`,
    `| AC Coverage | ${formatPercent(report.summary.acceptance_criteria.coverage_percent)} |`,
    `| Test files | ${report.summary.test_files} |`,
    "",
    "## Area 別網羅",
    "",
    "| Area | Name | Requirements | AC | Covered | Failing | Uncovered | Coverage |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const area of report.areas) {
    lines.push(
      `| ${area.id} | ${escapeTable(area.name)} | ${area.requirements} | ${area.acceptance_criteria.total} | ${area.acceptance_criteria.covered} | ${area.acceptance_criteria.failing} | ${area.acceptance_criteria.uncovered} | ${formatPercent(area.acceptance_criteria.coverage_percent)} |`,
    );
  }

  lines.push(
    "",
    "## Requirement 別網羅",
    "",
    "| Area | Requirement | Summary | Status | AC | Covered | Failing | Uncovered | Coverage | Test files |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const requirement of report.requirements) {
    lines.push(
      `| ${requirement.area_id} | ${requirement.id} | ${escapeTable(requirement.summary)} | ${requirement.status} | ${requirement.acceptance_criteria.total} | ${requirement.acceptance_criteria.covered} | ${requirement.acceptance_criteria.failing} | ${requirement.acceptance_criteria.uncovered} | ${formatPercent(requirement.acceptance_criteria.coverage_percent)} | ${requirement.tests.length} |`,
    );
  }

  const failing = report.acceptance_criteria.filter((ac) => ac.status === "failing");
  const uncovered = report.acceptance_criteria.filter((ac) => ac.status === "uncovered");

  lines.push(
    "",
    "## Failing AC",
    "",
    "| AC | Requirement | Description | Tests |",
    "| --- | --- | --- | --- |",
  );
  if (failing.length === 0) {
    lines.push("| - | - | なし | - |");
  } else {
    for (const ac of failing) {
      lines.push(renderAcceptanceCriteriaRow(ac));
    }
  }

  lines.push(
    "",
    "## Uncovered AC",
    "",
    "| AC | Requirement | Description | Tests |",
    "| --- | --- | --- | --- |",
  );
  if (uncovered.length === 0) {
    lines.push("| - | - | なし | - |");
  } else {
    for (const ac of uncovered) {
      lines.push(renderAcceptanceCriteriaRow(ac));
    }
  }

  lines.push(
    "",
    "## Test file 別トレース",
    "",
    "| Test file | AC count | Acceptance Criteria |",
    "| --- | ---: | --- |",
  );
  if (report.test_files.length === 0) {
    lines.push("| - | 0 | - |");
  } else {
    for (const testFile of report.test_files) {
      lines.push(
        `| ${testFile.path} | ${testFile.acceptance_criteria.length} | ${testFile.acceptance_criteria.join("<br>")} |`,
      );
    }
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

export async function generateRequirementsCoverageArtifacts(
  options: GenerateRequirementsCoverageOptions,
): Promise<GeneratedRequirementsCoverageArtifacts> {
  const raw = await readFile(options.requirementsPath, "utf-8");
  const requirements = RequirementsSchema.parse(parse(raw) as unknown);
  const report = buildRequirementsCoverageReport(
    requirements,
    options.sourceLabel ?? "docs/requirements.yaml",
  );

  await mkdir(options.outDir, { recursive: true });
  const markdownPath = resolve(options.outDir, "requirements-coverage.md");
  const jsonPath = resolve(options.outDir, "requirements-coverage.json");
  await Promise.all([
    writeFile(markdownPath, renderRequirementsCoverageMarkdown(report), "utf-8"),
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8"),
  ]);

  return { markdownPath, jsonPath, report };
}

function summarizeCriteria(criteria: AcceptanceCriteriaCoverage[]): CountSummary {
  const covered = criteria.filter((ac) => ac.status === "covered").length;
  const failing = criteria.filter((ac) => ac.status === "failing").length;
  const uncovered = criteria.length - covered - failing;
  return {
    total: criteria.length,
    covered,
    failing,
    uncovered,
    coverage_percent: percentage(covered, criteria.length),
  };
}

function summarizeRequirementStatus(counts: CountSummary): RequirementStatus {
  if (counts.total === 0) return "uncovered";
  if (counts.failing > 0) return "failing";
  if (counts.covered === counts.total) return "covered";
  if (counts.covered > 0) return "partial";
  return "uncovered";
}

function percentage(value: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function renderAcceptanceCriteriaRow(ac: AcceptanceCriteriaCoverage): string {
  return `| ${ac.id} | ${ac.requirement_id} | ${escapeTable(oneLine(ac.description))} | ${ac.tests.length === 0 ? "-" : ac.tests.join("<br>")} |`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}
