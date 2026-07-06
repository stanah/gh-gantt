import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, LoopState, Task } from "@gh-gantt/shared";
import { createEmptyLoopState } from "@gh-gantt/shared";
import { buildLoopStatusReport, formatLoopStatus } from "../commands/loop.js";
import { LoopStateStore } from "../store/loop-state.js";

const baseTask = (overrides: Partial<Task>): Task => ({
  id: "T",
  type: "task",
  github_issue: null,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "task",
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
  ...overrides,
});

const config: Config = {
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
    values: {
      Todo: { color: "#3498DB", done: false, category: "todo" },
      Done: { color: "#2ECC71", done: true, category: "done" },
    },
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
  require_review_for_types: [],
  require_close_evidence: false,
};

const sampleState: LoopState = {
  version: "1",
  iterations: [
    {
      id: 1,
      startedAt: "2026-07-04T00:00:00Z",
      completedAt: "2026-07-04T01:00:00Z",
      selectedTask: "stanah/gh-gantt#279",
      decision: "LoopState 型を実装する",
      outcome: "completed",
    },
  ],
};

describe("buildLoopStatusReport によるループ現在地の導出", () => {
  it("loop-state 未初期化 (null) でもレポートを組み立てられる", () => {
    const report = buildLoopStatusReport(null, config, [baseTask({ id: "a" })]);
    expect(report.initialized).toBe(false);
    expect(report.iterationCount).toBe(0);
    expect(report.lastIteration).toBeNull();
  });

  it("直近イテレーションと件数を報告する", () => {
    const report = buildLoopStatusReport(sampleState, config, []);
    expect(report.initialized).toBe(true);
    expect(report.iterationCount).toBe(1);
    expect(report.lastIteration?.selectedTask).toBe("stanah/gh-gantt#279");
  });

  it("loop 未設定の config ではデフォルト停止条件（全 6 条件）が実効値になる", () => {
    const report = buildLoopStatusReport(null, config, []);
    expect(report.stop.maxIterations).toBeNull();
    expect(report.stop.stopWhen).toContain("all_done");
    expect(report.stop.stopWhen).toContain("backlog_needs_decomposition");
    expect(report.stop.stopWhen).toHaveLength(6);
    expect(report.stop.onVerifyFailure).toBe("retry");
  });

  it("config.loop の停止条件が実効値に反映される", () => {
    const report = buildLoopStatusReport(
      null,
      { ...config, loop: { maxIterations: 3, stopWhen: ["all_done"] } },
      [],
    );
    expect(report.stop.maxIterations).toBe(3);
    expect(report.stop.stopWhen).toEqual(["all_done"]);
  });

  it("[ADR-017] ready 候補は blocked タスクを含まない（スコアが高くても排除される）", () => {
    // blocked: 未完了依存を持つが、risk ラベル + 下流 2 件解除でスコア自体は高い
    const tasks = [
      baseTask({ id: "dep", title: "上流", custom_fields: { Status: "Todo" } }),
      baseTask({
        id: "blocked",
        title: "高スコアだがブロック中",
        labels: ["risk"],
        blocked_by: [{ task: "dep", type: "finish-to-start", lag: 0 }],
        custom_fields: { Status: "Todo" },
      }),
      baseTask({
        id: "down1",
        blocked_by: [{ task: "blocked", type: "finish-to-start", lag: 0 }],
        custom_fields: { Status: "Todo" },
      }),
      baseTask({
        id: "down2",
        blocked_by: [{ task: "blocked", type: "finish-to-start", lag: 0 }],
        custom_fields: { Status: "Todo" },
      }),
    ];
    const report = buildLoopStatusReport(null, config, tasks);
    const candidateIds = report.readyCandidates.map((c) => c.taskId);
    expect(candidateIds).not.toContain("blocked");
    expect(candidateIds).toContain("dep");
  });

  it("子タスクを持つ親（コンテナ）は ready 件数にも候補にも含まれない", () => {
    const tasks = [
      baseTask({
        id: "epic",
        type: "task",
        title: "コンテナ",
        sub_tasks: ["leaf"],
        custom_fields: { Status: "Todo" },
      }),
      baseTask({ id: "leaf", parent: "epic", title: "葉", custom_fields: { Status: "Todo" } }),
    ];
    const report = buildLoopStatusReport(null, config, tasks);
    expect(report.readyCount).toBe(1);
    expect(report.readyCandidates.map((c) => c.taskId)).toEqual(["leaf"]);
  });

  it("ready 候補は Next Actions のスコア降順で並び selection 相当の根拠を含む", () => {
    const tasks = [
      baseTask({ id: "plain", title: "通常", custom_fields: { Status: "Todo" } }),
      baseTask({ id: "unblocker", title: "下流解除", custom_fields: { Status: "Todo" } }),
      baseTask({
        id: "down1",
        blocked_by: [{ task: "unblocker", type: "finish-to-start", lag: 0 }],
        custom_fields: { Status: "Todo" },
      }),
      baseTask({
        id: "down2",
        blocked_by: [{ task: "unblocker", type: "finish-to-start", lag: 0 }],
        custom_fields: { Status: "Todo" },
      }),
    ];
    const report = buildLoopStatusReport(null, config, tasks);
    expect(report.readyCandidates[0].taskId).toBe("unblocker");
    expect(report.readyCandidates[0].category).toBe("unlocker");
    expect(report.readyCandidates[0].reason).toContain("下流");
    expect(report.readyCandidates[0].score).toBeGreaterThan(
      report.readyCandidates.find((c) => c.taskId === "plain")!.score,
    );
  });
});

describe("スリップ検出と予実の表示 (ADR-017)", () => {
  const today = "2026-07-04";

  it("期日超過タスクが slips に載り、テキストに警告が出る", () => {
    const tasks = [
      baseTask({
        id: "late",
        title: "遅延中",
        end_date: "2026-07-01",
        custom_fields: { Status: "Todo" },
      }),
    ];
    const report = buildLoopStatusReport(null, config, tasks, false, today);
    expect(report.slips).toEqual([{ taskId: "late", title: "遅延中", kind: "overdue", days: 3 }]);
    const text = formatLoopStatus(report);
    expect(text).toContain("Schedule slips");
    expect(text).toContain("期日超過 3日");
    expect(text).toContain("gh-gantt update");
  });

  it("直近の完了イテレーションの所要と見積が表示される", () => {
    const tasks = [baseTask({ id: "stanah/gh-gantt#279", custom_fields: { Status: "Todo" } })];
    const report = buildLoopStatusReport(sampleState, config, tasks, false, today);
    expect(report.lastActual).toEqual({
      iterationId: 1,
      taskId: "stanah/gh-gantt#279",
      durationHours: 1,
      estimateHours: null,
    });
    expect(formatLoopStatus(report)).toContain("所要 1h / 見積 未設定");
  });

  it("全ブロック時は exhaustion にブロッカー一覧が載る", () => {
    const tasks = [
      baseTask({ id: "dep", custom_fields: { Status: "Todo" } }),
      baseTask({
        id: "b",
        blocked_by: [{ task: "外部", type: "finish-to-start", lag: 0 }],
        custom_fields: { Status: "Todo" },
      }),
    ];
    // dep 自体は ready なので枯渇にはならない
    expect(buildLoopStatusReport(null, config, tasks, false, today).exhaustion).toBeNull();

    const allBlocked = [tasks[1]];
    const report = buildLoopStatusReport(null, config, allBlocked, false, today);
    expect(report.exhaustion?.reason).toBe("all_blocked");
    const text = formatLoopStatus(report);
    expect(text).toContain("all_blocked");
    expect(text).toContain("blocked by: 外部");
  });
});

describe("コンフリクト検出時の HARD-GATE", () => {
  it("has_conflicts が真なら readyCandidates を提示しない", () => {
    const tasks = [baseTask({ id: "r", title: "着手可能", custom_fields: { Status: "Todo" } })];
    const report = buildLoopStatusReport(null, config, tasks, true);
    expect(report.hasConflicts).toBe(true);
    expect(report.readyCandidates).toEqual([]);
  });

  it("テキスト出力はコンフリクト警告を表示し候補一覧を出さない", () => {
    const tasks = [baseTask({ id: "r", title: "着手可能", custom_fields: { Status: "Todo" } })];
    const text = formatLoopStatus(buildLoopStatusReport(null, config, tasks, true));
    expect(text).toContain("conflicts_present");
    expect(text).toContain("gh-gantt conflicts");
    expect(text).not.toContain("Next candidates");
  });
});

describe("formatLoopStatus によるテキスト整形", () => {
  it("未初期化の場合はその旨と管理方法を表示する", () => {
    const text = formatLoopStatus(buildLoopStatusReport(null, config, []));
    expect(text).toContain("未初期化");
    expect(text).toContain("gh-gantt loop");
  });

  it("直近イテレーション・停止条件・ready 件数を表示する", () => {
    const tasks = [baseTask({ id: "r", title: "着手可能", custom_fields: { Status: "Todo" } })];
    const text = formatLoopStatus(buildLoopStatusReport(sampleState, config, tasks));
    expect(text).toContain("Iterations: 1");
    expect(text).toContain("#1 stanah/gh-gantt#279");
    expect(text).toContain("Stop conditions:");
    expect(text).toContain("Ready tasks: 1");
    expect(text).toContain("r: 着手可能");
  });
});

describe("LoopStateStore によるジャーナルの読み書き", () => {
  it("ファイル不在なら null を返し、write 後は同じ内容を読み戻せる", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-gantt-loop-"));
    const store = new LoopStateStore(dir);

    expect(await store.readOrNull()).toBeNull();

    const state = createEmptyLoopState();
    state.iterations.push({
      id: 1,
      startedAt: "2026-07-04T00:00:00Z",
      selectedTask: null,
      decision: "初期化",
      outcome: "stopped",
      stopReason: "all_done",
    });
    await store.write(state);
    expect(await store.readOrNull()).toEqual(state);

    // 末尾改行付きの整形 JSON で永続化される
    const raw = await readFile(join(dir, ".gantt-sync", "loop-state.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("スキーマに合わない内容は例外になる（直接編集の破損を検出する）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-gantt-loop-"));
    await mkdir(join(dir, ".gantt-sync"), { recursive: true });
    await writeFile(
      join(dir, ".gantt-sync", "loop-state.json"),
      JSON.stringify({ version: "1", iterations: [{ id: -1 }] }),
    );
    await expect(new LoopStateStore(dir).readOrNull()).rejects.toThrow();
  });
});

describe("ループメトリクスの提示 (ADR-016 案D)", () => {
  const failingState: LoopState = {
    version: "1",
    iterations: [
      {
        id: 1,
        startedAt: "2026-07-04T00:00:00Z",
        completedAt: "2026-07-04T01:00:00Z",
        selectedTask: "T-A",
        decision: "初回実装",
        outcome: "completed",
        verifyResults: [
          { command: "pnpm test", passed: false, attempt: 1 },
          { command: "pnpm test", passed: true, attempt: 2 },
        ],
      },
      {
        id: 2,
        startedAt: "2026-07-05T00:00:00Z",
        completedAt: "2026-07-05T01:00:00Z",
        selectedTask: "T-B",
        decision: "難所 1 回目",
        outcome: "verify_failed",
      },
      {
        id: 3,
        startedAt: "2026-07-05T02:00:00Z",
        completedAt: "2026-07-05T03:00:00Z",
        selectedTask: "T-B",
        decision: "難所 2 回目",
        outcome: "abandoned",
      },
    ],
  };

  it("レポートにジャーナル由来のメトリクスが含まれる", () => {
    const report = buildLoopStatusReport(failingState, config, []);
    expect(report.metrics.totalIterations).toBe(3);
    expect(report.metrics.outcomeCounts).toEqual({
      completed: 1,
      verify_failed: 1,
      abandoned: 1,
    });
    expect(report.metrics.verifyAttemptHistogram).toEqual({ 2: 1 });
    expect(report.metrics.recoveredCount).toBe(1);
    expect(report.metrics.currentFailureStreak).toBe(2);
    expect(report.metrics.repeatedTasks).toEqual([{ taskId: "T-B", selections: 2 }]);
  });

  it("整形出力に outcomes と verify 反復、停滞警告が含まれる", () => {
    const text = formatLoopStatus(buildLoopStatusReport(failingState, config, []));
    expect(text).toContain("Loop metrics:");
    expect(text).toContain("outcomes: completed 1 / verify_failed 1 / abandoned 1");
    expect(text).toContain("verify 反復: 2回 1件 (失敗から回復 1件)");
    expect(text).toContain("⚠ 停滞: 直近 2 イテレーション連続で失敗しています");
    expect(text).toContain("⚠ 停滞: T-B は 2 回選定されましたが未完了です");
  });

  it("ジャーナルが空なら metrics セクションも停滞警告も出さない", () => {
    const text = formatLoopStatus(buildLoopStatusReport(createEmptyLoopState(), config, []));
    expect(text).not.toContain("Loop metrics:");
    expect(text).not.toContain("停滞");
  });
});
