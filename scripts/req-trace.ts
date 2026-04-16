import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REQ_PATH = resolve(ROOT, "docs/requirements.yaml");
const TEST_RESULTS_PATHS = [
  resolve(ROOT, "test-results.json"),
  resolve(ROOT, "test-results-shared.json"),
  resolve(ROOT, "test-results-cli.json"),
  resolve(ROOT, "test-results-ui.json"),
  resolve(ROOT, "test-results-smoke.json"),
];

interface VitestResult {
  testResults: Array<{
    name: string;
    assertionResults: Array<{
      ancestorTitles: string[];
      title: string;
      status: "passed" | "failed" | "pending";
    }>;
  }>;
}

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

function extractReqIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/\[((?:FR|NFR)-[A-Z]+-\d+-AC\d+)\]/g)) {
    ids.push(match[1]);
  }
  return ids;
}

async function main() {
  const reqYaml = await readFile(REQ_PATH, "utf-8");
  const req: Requirements = parse(reqYaml);

  const testResults: VitestResult = { testResults: [] };
  let found = false;
  for (const path of TEST_RESULTS_PATHS) {
    try {
      const json = await readFile(path, "utf-8");
      const data: VitestResult = JSON.parse(json);
      testResults.testResults.push(...data.testResults);
      found = true;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw err;
    }
  }
  if (!found) {
    console.error("テスト結果ファイルが見つかりません");
    console.error(
      "先に各パッケージで --reporter=json --outputFile を指定してテストを実行してください",
    );
    process.exit(1);
  }

  // テスト結果から ID → { status, testFiles } のマップを構築
  const idMap = new Map<string, { status: "passed" | "failed"; testFiles: Set<string> }>();

  for (const suite of testResults.testResults) {
    const relPath = relative(ROOT, suite.name).replaceAll("\\", "/");

    for (const test of suite.assertionResults) {
      if (test.status !== "passed" && test.status !== "failed") continue;
      const fullTitle = [...test.ancestorTitles, test.title].join(" ");
      const ids = extractReqIds(fullTitle);
      for (const id of ids) {
        const existing = idMap.get(id);
        if (existing) {
          existing.testFiles.add(relPath);
          if (test.status === "failed") {
            existing.status = "failed";
          }
        } else {
          idMap.set(id, {
            status: test.status,
            testFiles: new Set([relPath]),
          });
        }
      }
    }
  }

  // requirements.yaml を更新
  let updated = 0;
  for (const area of req.areas) {
    for (const requirement of area.requirements) {
      for (const ac of requirement.acceptance_criteria) {
        const result = idMap.get(ac.id);
        if (result) {
          const newStatus = result.status === "passed" ? "covered" : "failing";
          const testFiles = [...result.testFiles].sort();

          if (ac.status !== newStatus || JSON.stringify(ac.tests) !== JSON.stringify(testFiles)) {
            ac.status = newStatus;
            ac.tests = testFiles;
            updated++;
          }
        } else if (ac.status !== "uncovered" || (ac.tests && ac.tests.length > 0)) {
          ac.status = "uncovered";
          ac.tests = [];
          updated++;
        }
      }
    }
  }

  await writeFile(REQ_PATH, stringify(req, { lineWidth: 0 }), "utf-8");
  console.log(`requirements.yaml を更新しました (${updated} 件の AC を変更)`);

  // サマリー出力
  let covered = 0;
  let uncovered = 0;
  let failing = 0;
  for (const area of req.areas) {
    for (const requirement of area.requirements) {
      for (const ac of requirement.acceptance_criteria) {
        if (ac.status === "covered") covered++;
        else if (ac.status === "uncovered") uncovered++;
        else if (ac.status === "failing") failing++;
      }
    }
  }
  console.log(`\nサマリー: covered=${covered}, uncovered=${uncovered}, failing=${failing}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
