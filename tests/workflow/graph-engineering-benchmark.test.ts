import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GraphRecoveryEvidencePackSchema } from "../../packages/smoke/src/graph-benchmark.js";

const ROOT = resolve(import.meta.dirname, "../..");
const RootPackageSchema = z.object({ scripts: z.record(z.string()) });

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(ROOT, path), "utf8");
}

describe("[NFR-STABILITY-016-AC4] Graph Engineering benchmark CLI", () => {
  it("smoke packageの要件タグをreq:validateの走査対象にする", async () => {
    const validator = await readRepoFile("scripts/req-validate.ts");

    expect(validator).toContain('"packages/smoke/src/__tests__"');
  });
});

describe("[NFR-STABILITY-016-AC5] Graph Engineering の実環境 recovery smoke", () => {
  it("5つのfailure classを別々のpostconditionとevidenceで検証する", async () => {
    const [reference, benchmark, evidenceText] = await Promise.all([
      readRepoFile("skills/gh-gantt-workflow/references/graph-engineering.md"),
      readRepoFile("docs/benchmarks/graph-engineering-2026-08-03.md"),
      readRepoFile("docs/benchmarks/graph-engineering-recovery-evidence.json"),
    ]);
    const evidence = GraphRecoveryEvidencePackSchema.parse(JSON.parse(evidenceText));

    const scenarios = [
      "runner_failure",
      "process_restart",
      "stale_lease",
      "github_api_transient",
      "sync_conflict",
    ];
    expect(evidence.schemaVersion).toBe("1");
    expect(evidence.baseRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.observations.map((entry) => entry.scenario).sort()).toEqual(
      [...scenarios].sort(),
    );
    const benchmarkDigest = `sha256:${createHash("sha256").update(benchmark).digest("hex")}`;
    const benchmarkByteLength = Buffer.byteLength(benchmark);

    for (const scenario of scenarios) {
      expect(reference).toContain(`\`${scenario}\``);
      expect(benchmark).toContain(`\`${scenario}\``);
      const observation = evidence.observations.find((entry) => entry.scenario === scenario)!;
      expect(observation.status).toBe("passed");
      expect(observation.evidence).toEqual([
        {
          kind: "recovery",
          uri: "docs/benchmarks/graph-engineering-2026-08-03.md",
          sha256: benchmarkDigest,
          byteLength: benchmarkByteLength,
        },
      ]);
    }
    expect(evidenceText).not.toMatch(/(?:\/Users\/|\/private\/tmp\/|file:\/\/)/);
    expect(evidenceText).not.toMatch(/(?:run|claim)-[0-9a-f]{8}-[0-9a-f-]{27,}/);
    expect(
      GraphRecoveryEvidencePackSchema.safeParse({ ...evidence, rawRunnerLog: "非公開" }).success,
    ).toBe(false);
    const firstObservation = evidence.observations[0]!;
    expect(
      GraphRecoveryEvidencePackSchema.safeParse({
        ...evidence,
        observations: [
          { ...firstObservation, commands: ["gh-gantt run show <run-id> --json"] },
          ...evidence.observations.slice(1),
        ],
      }).success,
    ).toBe(false);
    for (const uri of [
      "/etc/passwd",
      "/home/user/evidence.json",
      "~/private/evidence.json",
      "C:\\temp\\evidence.json",
      "\\\\server\\share\\evidence.json",
      "file:///tmp/evidence.json",
    ]) {
      expect(
        GraphRecoveryEvidencePackSchema.safeParse({
          ...evidence,
          observations: [
            {
              ...firstObservation,
              evidence: [{ ...firstObservation.evidence[0]!, uri }],
            },
            ...evidence.observations.slice(1),
          ],
        }).success,
        uri,
      ).toBe(false);
    }
    expect(reference).toContain("実 rate-limit や GitHub 障害を発生させない");
    expect(reference).toContain("postcondition");
    expect(reference).toContain("raw prompt");
    expect(reference).toContain("絶対 path");
    expect(benchmark).toContain("single_loop");
    expect(benchmark).toContain("paired_trial_count_insufficient");
    expect(benchmark).toContain("resource_metrics_unknown");
    expect(benchmark).toContain("operational_metrics_unknown");
    expect(benchmark).toContain("recovery_time_unknown");
    expect(benchmark).toContain("unknown (`not_collected`)");
    expect(benchmark).toContain("graph-engineering-recovery-evidence.json");
  });
});

describe("[NFR-STABILITY-016-AC6] Graph Engineering の導入・停止・復旧導線", () => {
  it("root script、README、workflow、Project Mapを同じ運用referenceへ結ぶ", async () => {
    const rootPackage = RootPackageSchema.parse(JSON.parse(await readRepoFile("package.json")));
    const [readme, workflow, projectMap, smokeReadme] = await Promise.all([
      readRepoFile("README.md"),
      readRepoFile("skills/gh-gantt-workflow/SKILL.md"),
      readRepoFile("docs/project-map.md"),
      readRepoFile("packages/smoke/README.md"),
    ]);

    expect(rootPackage.scripts["benchmark:graph"]).toBe(
      "pnpm --filter @gh-gantt/smoke benchmark:graph",
    );
    for (const content of [readme, workflow, projectMap, smokeReadme]) {
      expect(content).toContain("graph-engineering.md");
    }
    expect(smokeReadme).toContain("--require-qualified");
    expect(smokeReadme).toContain("single_loop");
    expect(smokeReadme).toContain("graph_candidate");
  });

  it("single-loop既定とcontract ceilingをbenchmark推奨から分離する", async () => {
    const [reference, adr] = await Promise.all([
      readRepoFile("skills/gh-gantt-workflow/references/graph-engineering.md"),
      readRepoFile("docs/adr/ADR-026-measured-graph-engineering-adoption.md"),
    ]);

    for (const content of [reference, adr]) {
      expect(content).toContain("single-loop");
      expect(content).toContain("concurrency 1");
      expect(content).toContain("contract ceiling");
      expect(content).toContain("human gate");
      expect(content).toContain("outputReferenceLimit: 20");
    }
  });
});

describe("[NFR-STABILITY-016-AC7] Graph Engineering の一次資料境界", () => {
  it("外部一次資料の事実とgh-gantt固有の推論を混同しない", async () => {
    const [research, adr] = await Promise.all([
      readRepoFile("docs/research/graph-engineering-primary-sources.md"),
      readRepoFile("docs/adr/ADR-026-measured-graph-engineering-adoption.md"),
    ]);

    expect(research).toContain("事実");
    expect(research).toContain("推論");
    expect(research).toContain("90.2%");
    expect(research).toContain("約 15 倍");
    expect(research).toContain("coding task");
    expect(research).toContain("memory-only");
    expect(adr).toContain("Graph Engineering は外部標準ではない");
    expect(adr).toContain("Symphony");
  });
});
