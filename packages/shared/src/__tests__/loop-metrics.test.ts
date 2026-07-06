import { describe, it, expect } from "vitest";
import type { LoopIteration, LoopState } from "../loop-state.js";
import { computeLoopMetrics } from "../loop-metrics.js";

let seq = 0;

const iteration = (overrides: Partial<LoopIteration>): LoopIteration => ({
  id: ++seq,
  startedAt: "2026-07-01T00:00:00Z",
  selectedTask: "T-1",
  decision: "テスト用イテレーション",
  ...overrides,
});

const state = (iterations: LoopIteration[]): LoopState => ({ version: "1", iterations });

describe("computeLoopMetrics によるジャーナルメトリクス (ADR-016 案D)", () => {
  it("state 未初期化 (null) は空メトリクスを返す", () => {
    const metrics = computeLoopMetrics(null);
    expect(metrics.totalIterations).toBe(0);
    expect(metrics.outcomeCounts).toEqual({});
    expect(metrics.verifyAttemptHistogram).toEqual({});
    expect(metrics.currentFailureStreak).toBe(0);
    expect(metrics.repeatedTasks).toEqual([]);
  });

  it("outcome 別の件数を集計する（未記録の進行中イテレーションは含まない）", () => {
    const metrics = computeLoopMetrics(
      state([
        iteration({ outcome: "completed" }),
        iteration({ outcome: "completed" }),
        iteration({ outcome: "verify_failed" }),
        iteration({}), // 進行中
      ]),
    );
    expect(metrics.totalIterations).toBe(4);
    expect(metrics.outcomeCounts).toEqual({ completed: 2, verify_failed: 1 });
  });

  it("verify の最大 attempt 数でヒストグラムを作る（改善反復の可視化）", () => {
    const metrics = computeLoopMetrics(
      state([
        iteration({
          outcome: "completed",
          verifyResults: [{ command: "pnpm test", passed: true, attempt: 1 }],
        }),
        iteration({
          outcome: "completed",
          verifyResults: [
            { command: "pnpm test", passed: false, attempt: 1 },
            { command: "pnpm test", passed: true, attempt: 2 },
          ],
        }),
        iteration({
          outcome: "completed",
          verifyResults: [{ command: "pnpm lint", passed: true, attempt: 1 }],
        }),
      ]),
    );
    expect(metrics.verifyAttemptHistogram).toEqual({ 1: 2, 2: 1 });
  });

  it("verify 失敗を経て completed に至ったイテレーションを recovered として数える", () => {
    const metrics = computeLoopMetrics(
      state([
        iteration({
          outcome: "completed",
          verifyResults: [
            { command: "pnpm test", passed: false, attempt: 1 },
            { command: "pnpm test", passed: true, attempt: 2 },
          ],
        }),
        // 失敗のまま断念したものは recovered ではない
        iteration({
          outcome: "verify_failed",
          verifyResults: [{ command: "pnpm test", passed: false, attempt: 1 }],
        }),
        // 一発合格も recovered ではない
        iteration({
          outcome: "completed",
          verifyResults: [{ command: "pnpm test", passed: true, attempt: 1 }],
        }),
      ]),
    );
    expect(metrics.recoveredCount).toBe(1);
  });

  it("直近から遡った連続失敗数を数える（進行中はスキップ、completed で止まる）", () => {
    const metrics = computeLoopMetrics(
      state([
        iteration({ outcome: "verify_failed" }), // completed より前の失敗は数えない
        iteration({ outcome: "completed" }),
        iteration({ outcome: "verify_failed" }),
        iteration({ outcome: "abandoned" }),
        iteration({}), // 進行中（判定材料にしない）
      ]),
    );
    expect(metrics.currentFailureStreak).toBe(2);
  });

  it("直近が completed なら連続失敗数は 0", () => {
    const metrics = computeLoopMetrics(
      state([iteration({ outcome: "verify_failed" }), iteration({ outcome: "completed" })]),
    );
    expect(metrics.currentFailureStreak).toBe(0);
  });

  it("複数回選定されて未完了のタスクを repeatedTasks として返す（選定回数の降順）", () => {
    const metrics = computeLoopMetrics(
      state([
        iteration({ selectedTask: "T-A", outcome: "verify_failed" }),
        iteration({ selectedTask: "T-A", outcome: "abandoned" }),
        iteration({ selectedTask: "T-A", outcome: "verify_failed" }),
        iteration({ selectedTask: "T-B", outcome: "verify_failed" }),
        iteration({ selectedTask: "T-B" }),
        // T-C は再選定の末に完了しているので停滞ではない
        iteration({ selectedTask: "T-C", outcome: "verify_failed" }),
        iteration({ selectedTask: "T-C", outcome: "completed" }),
      ]),
    );
    expect(metrics.repeatedTasks).toEqual([
      { taskId: "T-A", selections: 3 },
      { taskId: "T-B", selections: 2 },
    ]);
  });

  it("選定 1 回だけのタスクは未完了でも repeatedTasks に含まれない", () => {
    const metrics = computeLoopMetrics(
      state([iteration({ selectedTask: "T-once", outcome: "verify_failed" })]),
    );
    expect(metrics.repeatedTasks).toEqual([]);
  });
});
