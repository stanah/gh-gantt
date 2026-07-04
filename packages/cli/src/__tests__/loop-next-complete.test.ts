import { describe, it, expect } from "vitest";
import type { Config, LoopState, Task } from "@gh-gantt/shared";
import { createEmptyLoopState } from "@gh-gantt/shared";
import {
  completeIteration,
  decideNextIteration,
  formatLoopNext,
  parseVerifySpecs,
} from "../commands/loop.js";

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
    field_mapping: {
      start_date: "Start",
      end_date: "End",
      status: "Status",
      estimate_hours: "Estimate",
    },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
    epic: { label: "Epic", display: "summary", color: "#111", github_label: null },
  },
  type_hierarchy: { epic: ["task"], task: [] },
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

const NOW = "2026-07-04T10:00:00Z";

const readyTasks = () => [
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

function decide(overrides: {
  state?: LoopState;
  tasks?: Task[];
  hasConflicts?: boolean;
  decision?: string;
}) {
  return decideNextIteration({
    state: overrides.state ?? createEmptyLoopState(),
    config,
    tasks: overrides.tasks ?? readyTasks(),
    hasConflicts: overrides.hasConflicts ?? false,
    now: NOW,
    decision: overrides.decision,
  });
}

describe("decideNextIteration による次イテレーションの決定", () => {
  it("最高スコアの ready タスクを選定し NextAction スナップショットを記録する", () => {
    const result = decide({});
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.iteration.id).toBe(1);
      expect(result.iteration.selectedTask).toBe("unblocker");
      expect(result.iteration.selection?.category).toBe("unlocker");
      expect(result.iteration.decision).toContain("unblocker");
      expect(result.alternatives.map((a) => a.taskId)).toContain("plain");
    }
  });

  it("--decision 指定で decision を上書きできる", () => {
    const result = decide({ decision: "設計から着手する" });
    if (result.kind === "selected") {
      expect(result.iteration.decision).toBe("設計から着手する");
    } else {
      expect.fail("selected になるべき");
    }
  });

  it("未完了のイテレーションがあると開始を拒否する", () => {
    const state: LoopState = {
      version: "1",
      iterations: [
        { id: 1, startedAt: "2026-07-04T09:00:00Z", selectedTask: "plain", decision: "着手" },
      ],
    };
    const result = decide({ state });
    expect(result).toEqual({ kind: "open_iteration", openIterationId: 1 });
  });

  it("コンフリクト検出中は conflicts_present で停止イテレーションを記録する", () => {
    const result = decide({ hasConflicts: true });
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") {
      expect(result.stopReason).toBe("conflicts_present");
      expect(result.iteration?.outcome).toBe("stopped");
    }
  });

  it("直前と同一理由の停止はジャーナルに追記しない（重複防止）", () => {
    const state: LoopState = {
      version: "1",
      iterations: [
        {
          id: 1,
          startedAt: "2026-07-04T09:00:00Z",
          selectedTask: null,
          decision: "停止",
          outcome: "stopped",
          stopReason: "conflicts_present",
        },
      ],
    };
    const result = decide({ state, hasConflicts: true });
    if (result.kind === "stopped") {
      expect(result.iteration).toBeNull();
    } else {
      expect.fail("stopped になるべき");
    }
  });

  it("選定済みイテレーション数が maxIterations に達すると budget_exhausted で停止する", () => {
    const budgetConfig: Config = { ...config, loop: { maxIterations: 1 } };
    const state: LoopState = {
      version: "1",
      iterations: [
        {
          id: 1,
          startedAt: "2026-07-04T08:00:00Z",
          completedAt: "2026-07-04T09:00:00Z",
          selectedTask: "plain",
          decision: "着手",
          outcome: "completed",
        },
      ],
    };
    const result = decideNextIteration({
      state,
      config: budgetConfig,
      tasks: readyTasks(),
      hasConflicts: false,
      now: NOW,
    });
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.stopReason).toBe("budget_exhausted");
  });

  it("全タスク完了なら all_done で停止する", () => {
    const result = decide({ tasks: [baseTask({ id: "d", state: "closed" })] });
    if (result.kind === "stopped") {
      expect(result.stopReason).toBe("all_done");
    } else {
      expect.fail("stopped になるべき");
    }
  });

  it("子なし epic のみ残存なら backlog_needs_decomposition で停止し分解候補を示す", () => {
    const tasks = [baseTask({ id: "e", type: "epic", custom_fields: { Status: "Todo" } })];
    const result = decide({ tasks });
    if (result.kind === "stopped") {
      expect(result.stopReason).toBe("backlog_needs_decomposition");
      expect(result.exhaustion?.reason).toBe("backlog_needs_decomposition");
      expect(formatLoopNext(result)).toContain("gh-gantt-decompose");
    } else {
      expect.fail("stopped になるべき");
    }
  });

  it("停止イテレーションは次回の開始をブロックしない", () => {
    const state: LoopState = {
      version: "1",
      iterations: [
        {
          id: 1,
          startedAt: "2026-07-04T09:00:00Z",
          selectedTask: null,
          decision: "停止",
          outcome: "stopped",
          stopReason: "all_blocked",
        },
      ],
    };
    const result = decide({ state });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") expect(result.iteration.id).toBe(2);
  });
});

describe("completeIteration による実績記録", () => {
  const openState = (): LoopState => ({
    version: "1",
    iterations: [
      {
        id: 1,
        startedAt: "2026-07-04T08:30:00Z",
        selectedTask: "plain",
        decision: "着手",
      },
    ],
  });

  it("開いたイテレーションに completedAt / outcome / verify / review を記録し予実を返す", () => {
    const state = openState();
    const tasks = [baseTask({ id: "plain", custom_fields: { Status: "Todo", Estimate: 2 } })];
    const result = completeIteration({
      state,
      config,
      tasks,
      now: NOW,
      outcome: "completed",
      reviewOutcome: "approve",
      verify: parseVerifySpecs(["pnpm test=fail", "pnpm test=pass"]),
    });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.durationHours).toBe(1.5);
      expect(result.estimateHours).toBe(2);
    }
    const it1 = state.iterations[0];
    expect(it1.completedAt).toBe(NOW);
    expect(it1.outcome).toBe("completed");
    expect(it1.reviewOutcome).toBe("approve");
    expect(it1.verifyResults).toEqual([
      { command: "pnpm test", passed: false, attempt: 1 },
      { command: "pnpm test", passed: true, attempt: 2 },
    ]);
  });

  it("開いたイテレーションがなければ no_open_iteration", () => {
    const state = createEmptyLoopState();
    const result = completeIteration({
      state,
      config,
      tasks: [],
      now: NOW,
      outcome: "completed",
    });
    expect(result).toEqual({ kind: "no_open_iteration" });
  });
});

describe("parseVerifySpecs による --verify のパース", () => {
  it("command=pass|fail をパースし同一コマンドの attempt を採番する", () => {
    expect(parseVerifySpecs(["pnpm lint=pass", "pnpm test=fail", "pnpm test=pass"])).toEqual([
      { command: "pnpm lint", passed: true, attempt: 1 },
      { command: "pnpm test", passed: false, attempt: 1 },
      { command: "pnpm test", passed: true, attempt: 2 },
    ]);
  });

  it("形式が不正ならエラーになる", () => {
    expect(() => parseVerifySpecs(["pnpm test"])).toThrow(/形式が不正/);
    expect(() => parseVerifySpecs(["pnpm test=ok"])).toThrow(/形式が不正/);
  });
});
