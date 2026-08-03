import { z } from "zod";

export const GRAPH_BENCHMARK_SCENARIOS = [
  "fixed_run_graph",
  "ready_frontier",
  "verify_failure_recovery",
  "human_gate",
  "approved_work_graph_mutation",
] as const;

export const RECOVERY_SMOKE_SCENARIOS = [
  "runner_failure",
  "process_restart",
  "stale_lease",
  "github_api_transient",
  "sync_conflict",
] as const;

const UNKNOWN_REASONS = [
  "provider_not_exposed",
  "not_collected",
  "not_applicable",
  "redacted",
] as const;

const QUALIFICATION_REASONS = [
  "scenario_coverage_incomplete",
  "recovery_coverage_incomplete",
  "recovery_failed",
  "paired_trial_count_insufficient",
  "trial_order_unbalanced",
  "verified_success_unknown",
  "verified_success_regression",
  "ready_frontier_speedup_insufficient",
  "resource_metrics_unknown",
  "resource_inflation_exceeded",
  "operational_metrics_unknown",
  "coordination_metrics_unknown",
  "coordination_failure_observed",
  "recovery_time_unknown",
] as const;

const SHA256_SCHEMA = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const REVISION_SCHEMA = z.string().regex(/^[0-9a-f]{40}$/);
const OPAQUE_ID_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const UnknownReasonSchema = z.enum(UNKNOWN_REASONS);

const UnknownMetricSchema = z
  .object({
    status: z.literal("unknown"),
    reason: UnknownReasonSchema,
  })
  .strict();

const KnownNumberMetricSchema = z
  .object({
    status: z.literal("known"),
    value: z.number().finite().nonnegative(),
  })
  .strict();

const KnownIntegerMetricSchema = z
  .object({
    status: z.literal("known"),
    value: z.number().int().nonnegative(),
  })
  .strict();

const KnownVerifiedSuccessMetricSchema = z
  .object({
    status: z.literal("known"),
    value: z.enum(["passed", "failed"]),
  })
  .strict();

const NumberMetricSchema = z.discriminatedUnion("status", [
  KnownNumberMetricSchema,
  UnknownMetricSchema,
]);

const IntegerMetricSchema = z.discriminatedUnion("status", [
  KnownIntegerMetricSchema,
  UnknownMetricSchema,
]);

const VerifiedSuccessMetricSchema = z.discriminatedUnion("status", [
  KnownVerifiedSuccessMetricSchema,
  UnknownMetricSchema,
]);

const TrialMetricsSchema = z
  .object({
    verifiedSuccess: VerifiedSuccessMetricSchema,
    wallClockMs: NumberMetricSchema,
    inputTokens: IntegerMetricSchema,
    outputTokens: IntegerMetricSchema,
    costUsd: NumberMetricSchema,
    runNodeCount: IntegerMetricSchema,
    agentInvocationCount: IntegerMetricSchema,
    toolCallCount: IntegerMetricSchema,
    retryCount: IntegerMetricSchema,
    humanInterventionCount: IntegerMetricSchema,
    humanWaitMs: NumberMetricSchema,
    recoveryTimeMs: NumberMetricSchema,
    coordinationFailureCount: IntegerMetricSchema,
  })
  .strict();

/** 公開 evidence は repository 相対 path または HTTPS URL に限定する。 */
function isPublicEvidenceUri(value: string): boolean {
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      const localHostname =
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
        hostname.startsWith("[");
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        !localHostname
      );
    } catch {
      return false;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
  if (/^(?:[\\/]|~|[A-Za-z]:[\\/])/.test(value)) return false;
  const segments = value.split(/[\\/]/);
  return value.length > 0 && !segments.includes("..");
}

const EvidenceReferenceSchema = z
  .object({
    kind: z.enum([
      "verifier",
      "run_graph",
      "dispatch_claim",
      "human_decision",
      "mutation_receipt",
      "recovery",
    ]),
    uri: z.string().trim().min(1).max(500).refine(isPublicEvidenceUri, {
      message: "evidence uri は repository 相対 path または HTTPS URL が必要です",
    }),
    sha256: SHA256_SCHEMA,
    byteLength: z.number().int().nonnegative().max(65_536),
  })
  .strict();

const TrialSchema = z
  .object({
    id: OPAQUE_ID_SCHEMA,
    pairId: OPAQUE_ID_SCHEMA,
    sequence: z.union([z.literal(1), z.literal(2)]),
    strategy: z.enum(["single_loop", "graph_orchestration"]),
    scenario: z.enum(GRAPH_BENCHMARK_SCENARIOS),
    acceptanceCriteriaHash: SHA256_SCHEMA,
    repositoryRevision: REVISION_SCHEMA,
    verifierHash: SHA256_SCHEMA,
    environmentHash: SHA256_SCHEMA,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    metrics: TrialMetricsSchema,
    evidence: z.array(EvidenceReferenceSchema).min(1).max(20),
  })
  .strict()
  .superRefine((trial, context) => {
    const started = Date.parse(trial.startedAt);
    const finished = Date.parse(trial.finishedAt);
    if (finished < started) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt は startedAt 以後である必要があります",
      });
    }
    if (
      trial.metrics.wallClockMs.status === "known" &&
      trial.metrics.wallClockMs.value !== finished - started
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metrics", "wallClockMs"],
        message: "wallClockMs は startedAt と finishedAt の差に一致する必要があります",
      });
    }
  });

const RecoverySmokeSchema = z
  .object({
    scenario: z.enum(RECOVERY_SMOKE_SCENARIOS),
    status: z.enum(["passed", "failed", "not_run"]),
    recoveryTimeMs: NumberMetricSchema,
    evidence: z.array(EvidenceReferenceSchema).max(20),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.status === "passed" && entry.evidence.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "passed recovery smoke には evidence が必要です",
      });
    }
  });

const PublicEvidenceTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !/(?:file:\/\/|(?:^|[\s="'(])(?:\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|\\\\)|(?:run|claim)-[0-9a-f]{8}-[0-9a-f-]{27,})/i.test(
        value,
      ),
    { message: "公開evidenceへ絶対pathまたは内部opaque IDを含められません" },
  );

const RecoveryEvidenceObservationSchema = z
  .object({
    scenario: z.enum(RECOVERY_SMOKE_SCENARIOS),
    faultInjection: PublicEvidenceTextSchema,
    commands: z.array(PublicEvidenceTextSchema).min(1).max(10),
    expectedPostconditions: z.array(PublicEvidenceTextSchema).min(1).max(20),
    observedPostconditions: z.array(PublicEvidenceTextSchema).min(1).max(20),
    recoveryTimeMs: NumberMetricSchema,
    status: z.enum(["passed", "failed"]),
    digest: SHA256_SCHEMA,
  })
  .strict();

export const GraphRecoveryEvidencePackSchema = z
  .object({
    schemaVersion: z.literal("1"),
    recordedAt: z.string().datetime(),
    baseRevision: REVISION_SCHEMA,
    configSummary: PublicEvidenceTextSchema,
    configFingerprint: SHA256_SCHEMA,
    observations: z
      .array(RecoveryEvidenceObservationSchema)
      .length(RECOVERY_SMOKE_SCENARIOS.length),
  })
  .strict()
  .superRefine((pack, context) => {
    const scenarios = new Set(pack.observations.map((entry) => entry.scenario));
    if (scenarios.size !== RECOVERY_SMOKE_SCENARIOS.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observations"],
        message: "recovery evidenceは5 scenarioを重複なく必要とします",
      });
    }
  });

export const GraphBenchmarkSuiteSchema = z
  .object({
    schemaVersion: z.literal("1"),
    suiteId: OPAQUE_ID_SCHEMA,
    recordedAt: z.string().datetime(),
    taskShape: z.string().trim().min(1).max(500),
    trials: z.array(TrialSchema).min(2).max(200),
    recoverySmoke: z.array(RecoverySmokeSchema).max(RECOVERY_SMOKE_SCENARIOS.length),
  })
  .strict()
  .superRefine((suite, context) => {
    const trialIds = new Set<string>();
    const pairs = new Map<string, Array<(typeof suite.trials)[number]>>();
    for (const [index, trial] of suite.trials.entries()) {
      if (trialIds.has(trial.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trials", index, "id"],
          message: "trial id が重複しています",
        });
      }
      trialIds.add(trial.id);
      const pair = pairs.get(trial.pairId) ?? [];
      pair.push(trial);
      pairs.set(trial.pairId, pair);
    }

    for (const pair of pairs.values()) {
      if (pair.length !== 2) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trials"],
          message: "pair は2 trialである必要があります",
        });
        continue;
      }
      const [left, right] = pair as [(typeof pair)[number], (typeof pair)[number]];
      if (
        new Set(pair.map((entry) => entry.sequence)).size !== 2 ||
        new Set(pair.map((entry) => entry.strategy)).size !== 2
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trials"],
          message: "pair はsequence 1/2と両strategyを1件ずつ必要とします",
        });
      }
      const comparable = [
        "scenario",
        "acceptanceCriteriaHash",
        "repositoryRevision",
        "verifierHash",
        "environmentHash",
      ] as const;
      if (comparable.some((key) => left[key] !== right[key])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trials"],
          message: "pair の比較条件が一致しません",
        });
      }
    }

    const recoveryIds = new Set<string>();
    for (const [index, entry] of suite.recoverySmoke.entries()) {
      if (recoveryIds.has(entry.scenario)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recoverySmoke", index, "scenario"],
          message: `recovery scenario が重複しています: ${entry.scenario}`,
        });
      }
      recoveryIds.add(entry.scenario);
    }
  });

export type GraphBenchmarkSuite = z.infer<typeof GraphBenchmarkSuiteSchema>;
export type GraphRecoveryEvidencePack = z.infer<typeof GraphRecoveryEvidencePackSchema>;
export type GraphBenchmarkScenario = (typeof GRAPH_BENCHMARK_SCENARIOS)[number];
export type RecoverySmokeScenario = (typeof RECOVERY_SMOKE_SCENARIOS)[number];
export type GraphBenchmarkQualificationReason = (typeof QUALIFICATION_REASONS)[number];

type Trial = GraphBenchmarkSuite["trials"][number];
type NumericMetric = z.infer<typeof NumberMetricSchema>;

export interface GraphBenchmarkComparison {
  pairOrdinal: number;
  scenario: GraphBenchmarkScenario;
  firstStrategy: Trial["strategy"];
  verifiedSuccess: {
    singleLoop: Trial["metrics"]["verifiedSuccess"];
    graphOrchestration: Trial["metrics"]["verifiedSuccess"];
  };
  wallClockRatio: NumericMetric;
  totalTokenRatio: NumericMetric;
  costRatio: NumericMetric;
}

export interface GraphBenchmarkReport {
  schemaVersion: "1";
  coverage: {
    completePairCount: number;
    missingScenarios: GraphBenchmarkScenario[];
    missingRecoveryScenarios: RecoverySmokeScenario[];
    firstStrategyCounts: { singleLoop: number; graphOrchestration: number };
  };
  comparisons: GraphBenchmarkComparison[];
  qualification: {
    mode: "single_loop" | "graph_candidate";
    reasons: GraphBenchmarkQualificationReason[];
  };
  initialPolicy: {
    defaultStrategy: "single_loop" | "graph_orchestration";
    dispatchConcurrency: 1 | 2;
    automaticRetryBudget: 0 | 1;
    humanGate: "required_for_remote_side_effects";
    outputReferenceLimit: 20;
    inlineEvidenceByteLimit: 0;
  };
}

function knownRatio(numerator: NumericMetric, denominator: NumericMetric): NumericMetric {
  if (numerator.status === "unknown" || denominator.status === "unknown") {
    return { status: "unknown", reason: "not_collected" };
  }
  if (denominator.value === 0) {
    return numerator.value === 0
      ? { status: "known", value: 1 }
      : { status: "unknown", reason: "not_applicable" };
  }
  return { status: "known", value: numerator.value / denominator.value };
}

function totalTokens(trial: Trial): NumericMetric {
  const { inputTokens, outputTokens } = trial.metrics;
  if (inputTokens.status === "unknown" || outputTokens.status === "unknown") {
    return { status: "unknown", reason: "not_collected" };
  }
  return { status: "known", value: inputTokens.value + outputTokens.value };
}

function comparePair(pair: Trial[], pairOrdinal: number): GraphBenchmarkComparison {
  const singleLoop = pair.find((entry) => entry.strategy === "single_loop")!;
  const graph = pair.find((entry) => entry.strategy === "graph_orchestration")!;
  const first = pair.find((entry) => entry.sequence === 1)!;
  return {
    pairOrdinal,
    scenario: singleLoop.scenario,
    firstStrategy: first.strategy,
    verifiedSuccess: {
      singleLoop: singleLoop.metrics.verifiedSuccess,
      graphOrchestration: graph.metrics.verifiedSuccess,
    },
    wallClockRatio: knownRatio(graph.metrics.wallClockMs, singleLoop.metrics.wallClockMs),
    totalTokenRatio: knownRatio(totalTokens(graph), totalTokens(singleLoop)),
    costRatio: knownRatio(graph.metrics.costUsd, singleLoop.metrics.costUsd),
  };
}

function pushReason(
  reasons: GraphBenchmarkQualificationReason[],
  reason: GraphBenchmarkQualificationReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * 同一条件の観測だけを比較し、証拠不足時は single-loop へ縮退する。
 * report は raw prompt/log/evidence 本文を返さない。
 */
export function analyzeGraphBenchmark(input: unknown): GraphBenchmarkReport {
  const suite = GraphBenchmarkSuiteSchema.parse(input);
  const pairs = new Map<string, Trial[]>();
  for (const trial of suite.trials) {
    const pair = pairs.get(trial.pairId) ?? [];
    pair.push(trial);
    pairs.set(trial.pairId, pair);
  }
  const comparisons = [...pairs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, pair], index) => comparePair(pair, index + 1));

  const scenarioSet = new Set(suite.trials.map((trial) => trial.scenario));
  const recoverySet = new Set(suite.recoverySmoke.map((entry) => entry.scenario));
  const missingScenarios = GRAPH_BENCHMARK_SCENARIOS.filter((id) => !scenarioSet.has(id));
  const missingRecoveryScenarios = RECOVERY_SMOKE_SCENARIOS.filter((id) => !recoverySet.has(id));
  const firstStrategyCounts = {
    singleLoop: comparisons.filter((entry) => entry.firstStrategy === "single_loop").length,
    graphOrchestration: comparisons.filter((entry) => entry.firstStrategy === "graph_orchestration")
      .length,
  };

  const reasons: GraphBenchmarkQualificationReason[] = [];
  if (missingScenarios.length > 0) pushReason(reasons, "scenario_coverage_incomplete");
  if (missingRecoveryScenarios.length > 0) {
    pushReason(reasons, "recovery_coverage_incomplete");
  }
  if (comparisons.length < GRAPH_BENCHMARK_SCENARIOS.length) {
    pushReason(reasons, "paired_trial_count_insufficient");
  }
  if (Math.abs(firstStrategyCounts.singleLoop - firstStrategyCounts.graphOrchestration) > 1) {
    pushReason(reasons, "trial_order_unbalanced");
  }

  if (suite.recoverySmoke.some((entry) => entry.status !== "passed")) {
    pushReason(reasons, "recovery_failed");
  }
  if (
    suite.recoverySmoke.some(
      (entry) => entry.status === "passed" && entry.recoveryTimeMs.status === "unknown",
    )
  ) {
    pushReason(reasons, "recovery_time_unknown");
  }

  const allSuccessMetrics = suite.trials.map((trial) => trial.metrics.verifiedSuccess);
  if (allSuccessMetrics.some((metric) => metric.status === "unknown")) {
    pushReason(reasons, "verified_success_unknown");
  } else {
    const singleFailures = suite.trials.filter(
      (trial) =>
        trial.strategy === "single_loop" &&
        trial.metrics.verifiedSuccess.status === "known" &&
        trial.metrics.verifiedSuccess.value === "failed",
    ).length;
    const graphFailures = suite.trials.filter(
      (trial) =>
        trial.strategy === "graph_orchestration" &&
        trial.metrics.verifiedSuccess.status === "known" &&
        trial.metrics.verifiedSuccess.value === "failed",
    ).length;
    if (graphFailures > singleFailures || graphFailures > 0) {
      pushReason(reasons, "verified_success_regression");
    }
  }

  const frontierComparisons = comparisons.filter((entry) => entry.scenario === "ready_frontier");
  if (
    frontierComparisons.length === 0 ||
    frontierComparisons.some(
      (entry) => entry.wallClockRatio.status === "unknown" || entry.wallClockRatio.value > 0.8,
    )
  ) {
    pushReason(reasons, "ready_frontier_speedup_insufficient");
  }

  if (
    comparisons.some(
      (entry) => entry.totalTokenRatio.status === "unknown" || entry.costRatio.status === "unknown",
    )
  ) {
    pushReason(reasons, "resource_metrics_unknown");
  } else if (
    comparisons.some(
      (entry) =>
        (entry.totalTokenRatio.status === "known" && entry.totalTokenRatio.value > 2) ||
        (entry.costRatio.status === "known" && entry.costRatio.value > 2),
    )
  ) {
    pushReason(reasons, "resource_inflation_exceeded");
  }

  const operationalMetricKeys = [
    "wallClockMs",
    "runNodeCount",
    "agentInvocationCount",
    "toolCallCount",
    "retryCount",
    "humanInterventionCount",
    "humanWaitMs",
    "recoveryTimeMs",
  ] as const;
  if (
    suite.trials.some((trial) =>
      operationalMetricKeys.some((key) => trial.metrics[key].status === "unknown"),
    )
  ) {
    pushReason(reasons, "operational_metrics_unknown");
  }

  const coordinationMetrics = suite.trials.map((trial) => trial.metrics.coordinationFailureCount);
  if (coordinationMetrics.some((metric) => metric.status === "unknown")) {
    pushReason(reasons, "coordination_metrics_unknown");
  } else if (coordinationMetrics.some((metric) => metric.status === "known" && metric.value > 0)) {
    pushReason(reasons, "coordination_failure_observed");
  }

  const qualified = reasons.length === 0;
  return {
    schemaVersion: "1",
    coverage: {
      completePairCount: comparisons.length,
      missingScenarios,
      missingRecoveryScenarios,
      firstStrategyCounts,
    },
    comparisons,
    qualification: {
      mode: qualified ? "graph_candidate" : "single_loop",
      reasons,
    },
    initialPolicy: {
      defaultStrategy: qualified ? "graph_orchestration" : "single_loop",
      dispatchConcurrency: qualified ? 2 : 1,
      automaticRetryBudget: qualified ? 1 : 0,
      humanGate: "required_for_remote_side_effects",
      outputReferenceLimit: 20,
      inlineEvidenceByteLimit: 0,
    },
  };
}
