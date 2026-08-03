import { describe, expect, it } from "vitest";

import {
  analyzeGraphBenchmark,
  GRAPH_BENCHMARK_SCENARIOS,
  GraphBenchmarkSuiteSchema,
  RECOVERY_SMOKE_SCENARIOS,
} from "../graph-benchmark.js";
import { runGraphBenchmarkCli } from "../graph-benchmark-run.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const REVISION = "d".repeat(40);

const known = <T>(value: T) => ({ status: "known" as const, value });
const unknown = (reason = "provider_not_exposed") => ({
  status: "unknown" as const,
  reason,
});

function metrics(
  strategy: "single_loop" | "graph_orchestration",
  options: { resourceKnown?: boolean; success?: "passed" | "failed" } = {},
) {
  const graph = strategy === "graph_orchestration";
  const resourceKnown = options.resourceKnown ?? true;
  return {
    verifiedSuccess: known(options.success ?? "passed"),
    wallClockMs: known(graph ? 600 : 1_000),
    inputTokens: resourceKnown ? known(graph ? 1_200 : 1_000) : unknown(),
    outputTokens: resourceKnown ? known(graph ? 300 : 250) : unknown(),
    costUsd: resourceKnown ? known(graph ? 1.5 : 1) : unknown(),
    runNodeCount: known(graph ? 5 : 1),
    agentInvocationCount: known(graph ? 3 : 1),
    toolCallCount: known(graph ? 8 : 5),
    retryCount: known(0),
    humanInterventionCount: known(graph ? 1 : 0),
    humanWaitMs: known(0),
    recoveryTimeMs: known(0),
    coordinationFailureCount: known(0),
  };
}

function trial(
  scenario: (typeof GRAPH_BENCHMARK_SCENARIOS)[number],
  pairIndex: number,
  strategy: "single_loop" | "graph_orchestration",
  sequence: 1 | 2,
  options: { resourceKnown?: boolean; success?: "passed" | "failed" } = {},
) {
  return {
    id: `trial-${pairIndex}-${strategy}`,
    pairId: `pair-${pairIndex}`,
    sequence,
    strategy,
    scenario,
    acceptanceCriteriaHash: HASH_A,
    repositoryRevision: REVISION,
    verifierHash: HASH_B,
    environmentHash: HASH_C,
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: graphFinish(strategy),
    metrics: metrics(strategy, options),
    evidence: [
      {
        kind: "verifier" as const,
        uri: `evidence/${scenario}-${strategy}.json`,
        sha256: HASH_B,
        byteLength: 128,
      },
    ],
  };
}

function graphFinish(strategy: "single_loop" | "graph_orchestration") {
  return strategy === "graph_orchestration"
    ? "2026-08-03T00:00:00.600Z"
    : "2026-08-03T00:00:01.000Z";
}

function completeSuite(options: { resourceKnown?: boolean } = {}) {
  const trials = GRAPH_BENCHMARK_SCENARIOS.flatMap((scenario, index) => {
    const graphFirst = index % 2 === 1;
    return graphFirst
      ? [
          trial(scenario, index + 1, "graph_orchestration", 1, options),
          trial(scenario, index + 1, "single_loop", 2, options),
        ]
      : [
          trial(scenario, index + 1, "single_loop", 1, options),
          trial(scenario, index + 1, "graph_orchestration", 2, options),
        ];
  });

  return {
    schemaVersion: "1" as const,
    suiteId: "issue-332-pilot",
    recordedAt: "2026-08-03T00:10:00.000Z",
    taskShape: "独立 frontier と外部副作用 gate を持つ bounded coding task",
    trials,
    recoverySmoke: RECOVERY_SMOKE_SCENARIOS.map((scenario) => ({
      scenario,
      status: "passed" as const,
      recoveryTimeMs: known(250),
      evidence: [
        {
          kind: "recovery" as const,
          uri: "docs/benchmarks/graph-engineering-recovery-evidence.json",
          sha256: HASH_C,
          byteLength: 96,
        },
      ],
    })),
  };
}

describe("[NFR-STABILITY-016-AC1] Graph Engineering benchmark の strict metric 契約", () => {
  it("既知の0と理由付きunknownを別の値として保持する", () => {
    const input = completeSuite({ resourceKnown: false });
    const parsed = GraphBenchmarkSuiteSchema.parse(input);
    const graph = parsed.trials.find((entry) => entry.strategy === "graph_orchestration")!;

    expect(graph.metrics.retryCount).toEqual({ status: "known", value: 0 });
    expect(graph.metrics.inputTokens).toEqual({
      status: "unknown",
      reason: "provider_not_exposed",
    });
  });

  it("unknownへ0を混入する入力と未定義のraw fieldを拒否する", () => {
    const input = completeSuite();
    const first = input.trials[0]!;
    const invalid = {
      ...input,
      trials: [
        {
          ...first,
          rawPrompt: "公開してはいけない本文",
          metrics: {
            ...first.metrics,
            inputTokens: { status: "unknown", reason: "not_collected", value: 0 },
          },
        },
        ...input.trials.slice(1),
      ],
    };

    expect(GraphBenchmarkSuiteSchema.safeParse(invalid).success).toBe(false);
  });

  it("絶対path、credential、query、fragmentをpublic evidenceとして拒否する", () => {
    const input = completeSuite();
    const first = input.trials[0]!;
    for (const uri of [
      "/private/tmp/raw.json",
      "file:///tmp/raw.json",
      "../secret.json",
      "\\\\server\\share\\raw.json",
      "https://token@example.com/evidence.json",
      "https://example.com/evidence.json?signature=secret",
      "https://example.com/evidence.json#internal-id",
      "evidence/result.json?signature=secret",
      "evidence/result.json#internal-id",
      "https://localhost/evidence.json",
    ]) {
      const result = GraphBenchmarkSuiteSchema.safeParse({
        ...input,
        trials: [
          {
            ...first,
            evidence: [{ ...first.evidence[0]!, uri }],
          },
          ...input.trials.slice(1),
        ],
      });
      expect(result.success, uri).toBe(false);
    }
  });

  it("reportから入力由来のsuite、task shape、pair識別子を除外する", () => {
    const input = completeSuite();
    input.suiteId = "run-internal-session";
    input.taskShape = "/Users/example/raw-prompt.txt";
    input.trials = input.trials.map((entry) => ({
      ...entry,
      pairId: entry.pairId.replace("pair-", "claim-internal-"),
    }));

    const report = analyzeGraphBenchmark(input);
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("run-internal-session");
    expect(serialized).not.toContain("/Users/example/raw-prompt.txt");
    expect(serialized).not.toContain("claim-internal");
    expect(report.comparisons.map((entry) => entry.pairOrdinal)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("[NFR-STABILITY-016-AC2] 同一条件の paired trial 比較", () => {
  it("pair内のrevision、AC、verifier、environment不一致を拒否する", () => {
    const input = completeSuite();
    const targetIndex = input.trials.findIndex(
      (entry) => entry.pairId === "pair-1" && entry.sequence === 2,
    );
    const target = input.trials[targetIndex]!;
    const trials = [...input.trials];
    trials[targetIndex] = { ...target, repositoryRevision: "e".repeat(40) };

    expect(GraphBenchmarkSuiteSchema.safeParse({ ...input, trials }).success).toBe(false);
  });

  it("5 scenario、5 recovery、交互順序を満たすsuiteを比較する", () => {
    const report = analyzeGraphBenchmark(completeSuite());

    expect(report.coverage.missingScenarios).toEqual([]);
    expect(report.coverage.missingRecoveryScenarios).toEqual([]);
    expect(report.coverage.completePairCount).toBe(5);
    expect(report.coverage.firstStrategyCounts).toEqual({ singleLoop: 3, graphOrchestration: 2 });
    expect(report.comparisons).toHaveLength(5);
  });

  it("先行strategyの件数が均衡していてもsuite順が非交互なら昇格しない", () => {
    const input = completeSuite();
    input.trials = GRAPH_BENCHMARK_SCENARIOS.flatMap((scenario, index) => {
      const pair = input.trials.filter((entry) => entry.scenario === scenario);
      const firstStrategy = index < 3 ? "single_loop" : "graph_orchestration";
      return pair.map((entry) => ({
        ...entry,
        sequence: entry.strategy === firstStrategy ? (1 as const) : (2 as const),
      }));
    });

    const report = analyzeGraphBenchmark(input);

    expect(report.coverage.firstStrategyCounts).toEqual({ singleLoop: 3, graphOrchestration: 2 });
    expect(report.qualification.mode).toBe("single_loop");
    expect(report.qualification.reasons).toContain("trial_order_unbalanced");
  });

  it("派生比率でunknown reasonを保持し0除算をunknownとして扱う", () => {
    const input = completeSuite();
    const graphIndex = input.trials.findIndex(
      (entry) => entry.pairId === "pair-1" && entry.strategy === "graph_orchestration",
    );
    const singleIndex = input.trials.findIndex(
      (entry) => entry.pairId === "pair-1" && entry.strategy === "single_loop",
    );
    const graph = input.trials[graphIndex]!;
    const single = input.trials[singleIndex]!;
    input.trials[graphIndex] = {
      ...graph,
      metrics: {
        ...graph.metrics,
        inputTokens: unknown("redacted"),
        costUsd: known(0),
      },
    };
    input.trials[singleIndex] = {
      ...single,
      metrics: { ...single.metrics, costUsd: known(0) },
    };

    const comparison = analyzeGraphBenchmark(input).comparisons[0]!;

    expect(comparison.totalTokenRatio).toEqual({ status: "unknown", reason: "redacted" });
    expect(comparison.costRatio).toEqual({ status: "unknown", reason: "not_applicable" });
  });
});

describe("[NFR-STABILITY-016-AC3] 実測不足時のfail-closed policy", () => {
  it("token/costがunknownならgraphを昇格せず保守的な初期値を返す", () => {
    const report = analyzeGraphBenchmark(completeSuite({ resourceKnown: false }));

    expect(report.qualification.mode).toBe("single_loop");
    expect(report.qualification.reasons).toContain("resource_metrics_unknown");
    expect(report.initialPolicy).toEqual({
      defaultStrategy: "single_loop",
      dispatchConcurrency: 1,
      automaticRetryBudget: 0,
      humanGate: "required_for_remote_side_effects",
      outputReferenceLimit: 20,
      inlineEvidenceByteLimit: 0,
    });
  });

  it("recoveryが1件でも失敗すればgraphを昇格しない", () => {
    const input = completeSuite();
    input.recoverySmoke[0] = { ...input.recoverySmoke[0]!, status: "failed" };
    const report = analyzeGraphBenchmark(input);

    expect(report.qualification.mode).toBe("single_loop");
    expect(report.qualification.reasons).toContain("recovery_failed");
  });

  it("operational metricが1項目でもunknownならgraphを昇格しない", () => {
    const metricKeys = [
      "wallClockMs",
      "runNodeCount",
      "agentInvocationCount",
      "toolCallCount",
      "retryCount",
      "humanInterventionCount",
      "humanWaitMs",
      "recoveryTimeMs",
    ] as const;

    for (const key of metricKeys) {
      const input = completeSuite();
      const target = input.trials[0]!;
      input.trials[0] = {
        ...target,
        metrics: { ...target.metrics, [key]: unknown() },
      };

      const report = analyzeGraphBenchmark(input);
      expect(report.qualification.mode, key).toBe("single_loop");
      expect(report.qualification.reasons, key).toContain("operational_metrics_unknown");
    }
  });

  it("successまたはcoordinationがunknownならgraphを昇格しない", () => {
    const successInput = completeSuite();
    const successTarget = successInput.trials[0]!;
    successInput.trials[0] = {
      ...successTarget,
      metrics: { ...successTarget.metrics, verifiedSuccess: unknown() },
    };
    expect(analyzeGraphBenchmark(successInput).qualification.reasons).toContain(
      "verified_success_unknown",
    );

    const coordinationInput = completeSuite();
    const coordinationTarget = coordinationInput.trials[0]!;
    coordinationInput.trials[0] = {
      ...coordinationTarget,
      metrics: { ...coordinationTarget.metrics, coordinationFailureCount: unknown() },
    };
    expect(analyzeGraphBenchmark(coordinationInput).qualification.reasons).toContain(
      "coordination_metrics_unknown",
    );
  });

  it("全gateを満たすtask shapeだけgraph候補とし並列度2・自動retry1を上限にする", () => {
    const report = analyzeGraphBenchmark(completeSuite());

    expect(report.qualification).toEqual({ mode: "graph_candidate", reasons: [] });
    expect(report.initialPolicy).toEqual({
      defaultStrategy: "graph_orchestration",
      dispatchConcurrency: 2,
      automaticRetryBudget: 1,
      humanGate: "required_for_remote_side_effects",
      outputReferenceLimit: 20,
      inlineEvidenceByteLimit: 0,
    });
  });
});

describe("[NFR-STABILITY-016-AC4] Graph Engineering benchmark CLI", () => {
  it("output未指定時のstdoutを単一JSON documentにする", async () => {
    const stdout: string[] = [];
    const code = await runGraphBenchmarkCli(["--input", "records/issue-332.json"], {
      readText: async () => JSON.stringify(completeSuite({ resourceKnown: false })),
      writeText: async () => undefined,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!).qualification.mode).toBe("single_loop");
  });

  it("strict inputからraw evidenceを含まないreportを書き出す", async () => {
    let output = "";
    const stdout: string[] = [];
    const code = await runGraphBenchmarkCli(
      ["--input", "records/issue-332.json", "--output", "reports/issue-332.json"],
      {
        readText: async () => JSON.stringify(completeSuite({ resourceKnown: false })),
        writeText: async (_path, value) => {
          output = value;
        },
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output).qualification.mode).toBe("single_loop");
    expect(output).not.toContain("rawPrompt");
    expect(stdout.join("\n")).toContain("single_loop");
  });

  it("--require-qualifiedではunknownを含むsuiteを失敗させる", async () => {
    const stderr: string[] = [];
    const code = await runGraphBenchmarkCli(
      ["--input", "records/issue-332.json", "--require-qualified"],
      {
        readText: async () => JSON.stringify(completeSuite({ resourceKnown: false })),
        writeText: async () => undefined,
        stdout: () => undefined,
        stderr: (value) => stderr.push(value),
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("resource_metrics_unknown");
  });
});
