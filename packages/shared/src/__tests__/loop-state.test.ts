import { describe, it, expect } from "vitest";
import {
  LoopStateSchema,
  LoopConfigSchema,
  createEmptyLoopState,
  resolveLoopConfig,
  LOOP_STOP_REASONS,
  DEFAULT_LOOP_STOP_CONDITIONS,
} from "../loop-state.js";
import { ConfigSchema } from "../schema.js";

const validIteration = {
  id: 1,
  startedAt: "2026-07-04T00:00:00Z",
  completedAt: "2026-07-04T01:30:00Z",
  selectedTask: "stanah/gh-gantt#279",
  selection: {
    taskId: "stanah/gh-gantt#279",
    score: 31,
    category: "critical",
    reason: "クリティカルパス上",
  },
  decision: "LoopState 型と Zod スキーマを実装する",
  outcome: "completed",
  verifyResults: [
    { command: "pnpm test", passed: false, attempt: 1 },
    { command: "pnpm test", passed: true, attempt: 2 },
  ],
  reviewOutcome: "approve",
};

const baseConfig = {
  version: "1",
  project: { name: "P", github: { owner: "stanah", repo: "gh-gantt", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
  },
  type_hierarchy: { task: [] },
  statuses: {
    field_name: "Status",
    values: { Todo: { color: "#3498DB", done: false, category: "todo" } },
  },
  gantt: {
    default_view: "month",
    working_days: [1, 2, 3, 4, 5],
    colors: {
      critical_path: "#E74C3C",
      on_track: "#2ECC71",
      at_risk: "#F39C12",
      overdue: "#E74C3C",
    },
  },
};

describe("LoopStateSchema による loop-state.json の検証", () => {
  it("イテレーションを含む正常な state をパースできる", () => {
    const state = LoopStateSchema.parse({ version: "1", iterations: [validIteration] });
    expect(state.iterations).toHaveLength(1);
    expect(state.iterations[0].selection?.category).toBe("critical");
    expect(state.iterations[0].verifyResults?.[1].attempt).toBe(2);
  });

  it("createEmptyLoopState はスキーマ検証を通る空の state を返す", () => {
    expect(() => LoopStateSchema.parse(createEmptyLoopState())).not.toThrow();
    expect(createEmptyLoopState().iterations).toEqual([]);
  });

  it("停止のみのイテレーション（selectedTask: null + stopReason）を許容する", () => {
    const state = LoopStateSchema.parse({
      version: "1",
      iterations: [
        {
          id: 2,
          startedAt: "2026-07-04T02:00:00Z",
          selectedTask: null,
          decision: "ready 候補なしのため停止",
          outcome: "stopped",
          stopReason: "all_blocked",
        },
      ],
    });
    expect(state.iterations[0].stopReason).toBe("all_blocked");
  });

  it("不正な stopReason を拒否する", () => {
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [{ ...validIteration, stopReason: "no_ready_tasks" }],
      }),
    ).toThrow();
  });

  it("不正な selection.category を拒否する", () => {
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [
          { ...validIteration, selection: { ...validIteration.selection, category: "urgent" } },
        ],
      }),
    ).toThrow();
  });

  it("空文字の decision / selection.reason を拒否する（直接編集の破損検知）", () => {
    expect(() =>
      LoopStateSchema.parse({ version: "1", iterations: [{ ...validIteration, decision: "" }] }),
    ).toThrow();
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [{ ...validIteration, selection: { ...validIteration.selection, reason: "" } }],
      }),
    ).toThrow();
  });

  it("selection.taskId と selectedTask の不一致を拒否する（直接編集の破損検知）", () => {
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [{ ...validIteration, selectedTask: "stanah/gh-gantt#999" }],
      }),
    ).toThrow();
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [{ ...validIteration, selectedTask: null }],
      }),
    ).toThrow();
  });

  it("outcome が stopped なのに stopReason がないイテレーションを拒否する", () => {
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [
          {
            id: 2,
            startedAt: "2026-07-04T02:00:00Z",
            selectedTask: null,
            decision: "停止",
            outcome: "stopped",
          },
        ],
      }),
    ).toThrow();
  });

  it("id が正の整数でないイテレーションを拒否する", () => {
    expect(() =>
      LoopStateSchema.parse({ version: "1", iterations: [{ ...validIteration, id: 0 }] }),
    ).toThrow();
  });
});

describe("[FR-CLI-018-AC2] LoopIteration.prEvidence のスキーマ検証", () => {
  const validEvidence = {
    number: 304,
    state: "MERGED",
    reviewDecision: "APPROVED",
    unresolvedThreads: 0,
    pendingChecks: 0,
    checkedAt: "2026-07-07T10:00:00Z",
  };

  it("prEvidence 付きイテレーションをパースできる", () => {
    const state = LoopStateSchema.parse({
      version: "1",
      iterations: [{ ...validIteration, prEvidence: [validEvidence] }],
    });
    expect(state.iterations[0].prEvidence?.[0].state).toBe("MERGED");
    expect(state.iterations[0].prEvidence?.[0].checkedAt).toBe("2026-07-07T10:00:00Z");
  });

  it("[FR-CLI-018-AC3] override 付き evidence（state UNKNOWN）をパースできる", () => {
    const state = LoopStateSchema.parse({
      version: "1",
      iterations: [
        {
          ...validIteration,
          prEvidence: [
            {
              number: 304,
              state: "UNKNOWN",
              checkedAt: "2026-07-07T10:00:00Z",
              overridden: true,
              overrideReason: "オフライン作業のため",
            },
          ],
        },
      ],
    });
    expect(state.iterations[0].prEvidence?.[0].overridden).toBe(true);
    expect(state.iterations[0].prEvidence?.[0].overrideReason).toBe("オフライン作業のため");
  });

  it("[FR-CLI-018-AC3] overridden が true なのに overrideReason がない evidence を拒否する", () => {
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [
          {
            ...validIteration,
            prEvidence: [
              { number: 304, state: "OPEN", checkedAt: "2026-07-07T10:00:00Z", overridden: true },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("不正な state の evidence を拒否する", () => {
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [{ ...validIteration, prEvidence: [{ ...validEvidence, state: "DRAFT" }] }],
      }),
    ).toThrow();
  });

  it("PR 番号が正の整数でない evidence を拒否する", () => {
    expect(() =>
      LoopStateSchema.parse({
        version: "1",
        iterations: [{ ...validIteration, prEvidence: [{ ...validEvidence, number: 0 }] }],
      }),
    ).toThrow();
  });
});

describe("Config.loop セクションの検証と後方互換", () => {
  it("loop 未設定の既存 config をそのままパースできる（後方互換）", () => {
    const config = ConfigSchema.parse(baseConfig);
    expect(config.loop).toBeUndefined();
  });

  it("loop セクションを含む config をパースできる", () => {
    const config = ConfigSchema.parse({
      ...baseConfig,
      loop: {
        maxIterations: 10,
        stopWhen: ["all_done", "conflicts_present"],
        onVerifyFailure: "retry",
      },
    });
    expect(config.loop?.maxIterations).toBe(10);
    expect(config.loop?.stopWhen).toEqual(["all_done", "conflicts_present"]);
  });

  it("廃止された no_ready_tasks を stopWhen に指定するとエラーになる", () => {
    expect(() => LoopConfigSchema.parse({ stopWhen: ["no_ready_tasks"] })).toThrow();
  });

  it("onVerifyFailure に retry 以外を指定するとエラーになる", () => {
    expect(() => LoopConfigSchema.parse({ onVerifyFailure: "ignore" })).toThrow();
  });

  it("maxIterations に 0 以下を指定するとエラーになる", () => {
    expect(() => LoopConfigSchema.parse({ maxIterations: 0 })).toThrow();
  });

  it("[FR-CLI-018-AC6] requirePrEvidence を含む config をパースできる", () => {
    const config = ConfigSchema.parse({
      ...baseConfig,
      loop: { requirePrEvidence: false },
    });
    expect(config.loop?.requirePrEvidence).toBe(false);
    expect(() => LoopConfigSchema.parse({ requirePrEvidence: "yes" })).toThrow();
  });
});

describe("resolveLoopConfig によるデフォルト解決", () => {
  it("loop 未設定なら全停止条件・無制限・retry がデフォルトになる", () => {
    const resolved = resolveLoopConfig(undefined);
    expect(resolved.maxIterations).toBeNull();
    expect(resolved.stopWhen).toEqual([...LOOP_STOP_REASONS]);
    expect(resolved.onVerifyFailure).toBe("retry");
  });

  it("[FR-CLI-018-AC6] requirePrEvidence は未指定なら true、false 指定で無効化できる", () => {
    expect(resolveLoopConfig(undefined).requirePrEvidence).toBe(true);
    expect(resolveLoopConfig({}).requirePrEvidence).toBe(true);
    expect(resolveLoopConfig({ requirePrEvidence: false }).requirePrEvidence).toBe(false);
  });

  it("指定した値がデフォルトより優先される", () => {
    const resolved = resolveLoopConfig({ maxIterations: 5, stopWhen: ["all_done"] });
    expect(resolved.maxIterations).toBe(5);
    expect(resolved.stopWhen).toEqual(["all_done"]);
    expect(resolved.onVerifyFailure).toBe("retry");
  });

  it("デフォルト停止条件には ready 枯渇 3 分類がすべて含まれる", () => {
    expect(DEFAULT_LOOP_STOP_CONDITIONS).toEqual(
      expect.arrayContaining(["all_done", "all_blocked", "backlog_needs_decomposition"]),
    );
  });
});
