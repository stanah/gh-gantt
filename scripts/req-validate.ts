import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REQ_PATH = resolve(ROOT, "docs/requirements.yaml");
const ADR_DIR = resolve(ROOT, "docs/adr");

interface AcceptanceCriteria {
  id: string;
  description: string;
  status: string;
  tests: string[];
}

interface Requirement {
  id: string;
  summary: string;
  acceptance_criteria: AcceptanceCriteria[];
}

interface Area {
  id: string;
  name: string;
  description: string;
  requirements: Requirement[];
}

interface Requirements {
  version: string;
  vision: string;
  areas: Area[];
}

interface ADR {
  id: string;
  related_requirements: string[];
}

async function collectTestReqIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const testDirs = [
    "packages/cli/src/__tests__",
    "packages/shared/src/__tests__",
    "packages/ui/src/__tests__",
  ];

  for (const dir of testDirs) {
    const fullDir = resolve(ROOT, dir);
    let files: string[];
    try {
      files = (await readdir(fullDir)).filter(
        (f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const content = await readFile(resolve(fullDir, file), "utf-8");
      for (const match of content.matchAll(/\[((?:FR|NFR)-[A-Z]+-\d+-AC\d+)\]/g)) {
        ids.add(match[1]);
      }
    }
  }
  return ids;
}

async function main() {
  const reqYaml = await readFile(REQ_PATH, "utf-8");
  const req: Requirements = parse(reqYaml);
  const errors: string[] = [];
  const warnings: string[] = [];

  const allAcIds = new Set<string>();
  const allReqIds = new Set<string>();
  for (const area of req.areas) {
    for (const requirement of area.requirements) {
      allReqIds.add(requirement.id);
      for (const ac of requirement.acceptance_criteria) {
        allAcIds.add(ac.id);
      }
    }
  }

  const testReqIds = await collectTestReqIds();

  for (const acId of allAcIds) {
    if (!testReqIds.has(acId)) {
      warnings.push(`Orphaned AC: ${acId} はテストから参照されていません`);
    }
  }

  for (const testId of testReqIds) {
    if (!allAcIds.has(testId)) {
      errors.push(`Orphaned Tag: テストの [${testId}] は requirements.yaml に存在しません`);
    }
  }

  try {
    const adrFiles = (await readdir(ADR_DIR)).filter((f) => f.endsWith(".yaml"));
    for (const file of adrFiles) {
      const content = await readFile(resolve(ADR_DIR, file), "utf-8");
      const adr: ADR = parse(content);
      if (adr.related_requirements) {
        for (const reqId of adr.related_requirements) {
          if (!allReqIds.has(reqId)) {
            errors.push(
              `Stale ADR Ref: ${adr.id} の related_requirements "${reqId}" は requirements.yaml に存在しません`,
            );
          }
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // ADR ディレクトリが存在しない場合はスキップ
    } else {
      throw err;
    }
  }

  if (warnings.length > 0) {
    console.warn("Warnings:\n");
    for (const w of warnings) {
      console.warn(`  ⚠ ${w}`);
    }
    console.warn();
  }

  if (errors.length > 0) {
    console.error("Errors:\n");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    console.error(`\n${errors.length} 件のエラーが見つかりました`);
    process.exit(1);
  }

  console.log(`✓ すべての検証に合格しました (${warnings.length} 件の warning)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
