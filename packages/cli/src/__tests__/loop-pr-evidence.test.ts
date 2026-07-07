import { describe, it, expect } from "vitest";
import type { Config, LinkedPullRequestRef, LoopState } from "@gh-gantt/shared";
import { resolveLoopConfig } from "@gh-gantt/shared";
import {
  detectMissingTaskRejection,
  evaluatePrEvidence,
  extractLinkedPrNumbers,
  formatPrGateRejection,
  shouldApplyPrGate,
} from "../loop/pr-evidence.js";
import type { PrGateState } from "../loop/pr-evidence.js";
import { completeIteration, formatLoopComplete } from "../commands/loop.js";

const NOW = "2026-07-07T10:00:00Z";

const gateState = (overrides: Partial<PrGateState>): PrGateState => ({
  number: 304,
  state: "MERGED",
  reviewDecision: "APPROVED",
  unresolvedThreads: 0,
  pendingChecks: 0,
  ...overrides,
});

describe("[FR-CLI-018-AC7] extractLinkedPrNumbers による PR 番号の列挙", () => {
  it("番号形式とメタデータ形式の混在から重複なしの昇順で PR 番号を列挙する", () => {
    const refs: LinkedPullRequestRef[] = [
      310,
      { number: 304, title: "PR", state: "open", url: null },
      310,
    ];
    expect(extractLinkedPrNumbers(refs)).toEqual([304, 310]);
  });

  it("ローカルキャッシュの state には依存せず番号のみを使う", () => {
    // メタデータ形式の state (ここでは "merged") はローカルキャッシュであり、
    // ゲート判定には live フェッチの結果だけを使う
    const refs: LinkedPullRequestRef[] = [{ number: 1, title: "PR", state: "merged", url: null }];
    expect(extractLinkedPrNumbers(refs)).toEqual([1]);
  });
});

describe("[FR-CLI-018-AC5] shouldApplyPrGate によるゲート適用要否の判定", () => {
  it("outcome=completed かつ requirePrEvidence 有効かつ linked PR ありなら適用する", () => {
    expect(
      shouldApplyPrGate({ outcome: "completed", requirePrEvidence: true, prNumbers: [304] }),
    ).toBe(true);
  });

  it("outcome が verify_failed / abandoned ならゲートを適用しない", () => {
    expect(
      shouldApplyPrGate({ outcome: "verify_failed", requirePrEvidence: true, prNumbers: [304] }),
    ).toBe(false);
    expect(
      shouldApplyPrGate({ outcome: "abandoned", requirePrEvidence: true, prNumbers: [304] }),
    ).toBe(false);
  });

  it("linked PR がなければゲートを適用しない（後方互換）", () => {
    expect(
      shouldApplyPrGate({ outcome: "completed", requirePrEvidence: true, prNumbers: [] }),
    ).toBe(false);
  });
});

describe("[FR-CLI-018-AC6] requirePrEvidence 設定によるゲートの無効化", () => {
  it("requirePrEvidence が false ならゲートを適用しない", () => {
    expect(
      shouldApplyPrGate({ outcome: "completed", requirePrEvidence: false, prNumbers: [304] }),
    ).toBe(false);
  });

  it("resolveLoopConfig の既定は有効 (true) で、false 指定で無効化できる", () => {
    expect(resolveLoopConfig(undefined).requirePrEvidence).toBe(true);
    expect(resolveLoopConfig({}).requirePrEvidence).toBe(true);
    expect(resolveLoopConfig({ requirePrEvidence: false }).requirePrEvidence).toBe(false);
  });
});

describe("[FR-CLI-018-AC2] evaluatePrEvidence による受理と evidence 生成", () => {
  it("全 PR が MERGED / CLOSED なら受理し PR ごとの評価結果を返す", () => {
    const result = evaluatePrEvidence({
      prNumbers: [304, 310],
      fetched: [
        gateState({ number: 304 }),
        gateState({ number: 310, state: "CLOSED", reviewDecision: null }),
      ],
      checkedAt: NOW,
    });
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.evidence).toEqual([
        {
          number: 304,
          state: "MERGED",
          reviewDecision: "APPROVED",
          unresolvedThreads: 0,
          pendingChecks: 0,
          checkedAt: NOW,
        },
        {
          number: 310,
          state: "CLOSED",
          reviewDecision: null,
          unresolvedThreads: 0,
          pendingChecks: 0,
          checkedAt: NOW,
        },
      ]);
    }
  });

  it("チェック未設定 (pendingChecks が undefined) の PR は pendingChecks を記録しない", () => {
    const result = evaluatePrEvidence({
      prNumbers: [304],
      fetched: [gateState({ pendingChecks: undefined })],
      checkedAt: NOW,
    });
    if (result.kind === "accepted") {
      expect(result.evidence[0]).not.toHaveProperty("pendingChecks");
    } else {
      expect.fail("accepted になるべき");
    }
  });
});

describe("[FR-CLI-018-AC1] evaluatePrEvidence による OPEN な PR の拒否", () => {
  it("OPEN の PR が残っていれば拒否し診断情報を返す", () => {
    const openPr = gateState({
      number: 304,
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      unresolvedThreads: 3,
      pendingChecks: 1,
    });
    const result = evaluatePrEvidence({
      prNumbers: [304, 310],
      fetched: [openPr, gateState({ number: 310 })],
      checkedAt: NOW,
    });
    expect(result.kind).toBe("rejected_open_prs");
    if (result.kind === "rejected_open_prs") {
      expect(result.openPrs).toEqual([openPr]);
      const message = formatPrGateRejection(result);
      expect(message).toContain("PR #304");
      expect(message).toContain("CHANGES_REQUESTED");
      expect(message).toContain("未解決スレッド: 3");
      expect(message).toContain("pending checks: 1");
      expect(message).toContain("--override-pr-gate");
    }
  });
});

describe("[FR-CLI-018-AC3] --override-pr-gate による意識的バイパスの記録", () => {
  it("OPEN の PR が残っていても override 理由付きなら受理し evidence に記録する", () => {
    const result = evaluatePrEvidence({
      prNumbers: [304],
      fetched: [gateState({ number: 304, state: "OPEN" })],
      checkedAt: NOW,
      overrideReason: "hotfix のため先行完了する",
    });
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.evidence[0].state).toBe("OPEN");
      expect(result.evidence[0].overridden).toBe(true);
      expect(result.evidence[0].overrideReason).toBe("hotfix のため先行完了する");
    }
  });

  it("API 到達不能でも override なら受理し state UNKNOWN として記録する", () => {
    const result = evaluatePrEvidence({
      prNumbers: [304],
      fetched: null,
      fetchError: "ネットワークエラー",
      checkedAt: NOW,
      overrideReason: "オフライン作業のため",
    });
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.evidence).toEqual([
        {
          number: 304,
          state: "UNKNOWN",
          checkedAt: NOW,
          overridden: true,
          overrideReason: "オフライン作業のため",
        },
      ]);
    }
  });
});

describe("[FR-CLI-018-AC4] API 到達不能時の fail-closed", () => {
  it("live 状態を取得できなければ拒否し --override-pr-gate を案内する", () => {
    const result = evaluatePrEvidence({
      prNumbers: [304],
      fetched: null,
      fetchError: "ECONNREFUSED",
      checkedAt: NOW,
    });
    expect(result.kind).toBe("rejected_fetch_failed");
    if (result.kind === "rejected_fetch_failed") {
      const message = formatPrGateRejection(result);
      expect(message).toContain("fail-closed");
      expect(message).toContain("ECONNREFUSED");
      expect(message).toContain("--override-pr-gate");
    }
  });

  it("取得結果に含まれない PR があれば拒否する（部分的な取得も fail-closed）", () => {
    const result = evaluatePrEvidence({
      prNumbers: [304, 310],
      fetched: [gateState({ number: 304 })],
      checkedAt: NOW,
    });
    expect(result.kind).toBe("rejected_fetch_failed");
    if (result.kind === "rejected_fetch_failed") {
      expect(result.message).toContain("#310");
    }
  });
});

describe("[FR-CLI-018-AC4] 選定タスクがローカルに不在の場合の fail-closed", () => {
  it("completed かつゲート有効でタスク不在なら拒否する（黙ってスキップしない）", () => {
    const rejection = detectMissingTaskRejection({
      outcome: "completed",
      requirePrEvidence: true,
      selectedTask: "stanah/gh-gantt#308",
      taskFound: false,
    });
    expect(rejection).toEqual({ kind: "rejected_task_missing", taskId: "stanah/gh-gantt#308" });
    if (rejection) {
      const message = formatPrGateRejection(rejection);
      expect(message).toContain("fail-closed");
      expect(message).toContain("gh-gantt pull");
      expect(message).toContain("--override-pr-gate");
    }
  });

  it("タスクが見つかっていれば拒否しない", () => {
    expect(
      detectMissingTaskRejection({
        outcome: "completed",
        requirePrEvidence: true,
        selectedTask: "stanah/gh-gantt#308",
        taskFound: true,
      }),
    ).toBeNull();
  });

  it("--override-pr-gate 指定時は拒否しない", () => {
    expect(
      detectMissingTaskRejection({
        outcome: "completed",
        requirePrEvidence: true,
        selectedTask: "stanah/gh-gantt#308",
        taskFound: false,
        overrideReason: "オフライン作業のため",
      }),
    ).toBeNull();
  });

  it("outcome が completed 以外、または requirePrEvidence=false なら拒否しない", () => {
    expect(
      detectMissingTaskRejection({
        outcome: "abandoned",
        requirePrEvidence: true,
        selectedTask: "stanah/gh-gantt#308",
        taskFound: false,
      }),
    ).toBeNull();
    expect(
      detectMissingTaskRejection({
        outcome: "completed",
        requirePrEvidence: false,
        selectedTask: "stanah/gh-gantt#308",
        taskFound: false,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// completeIteration への prEvidence 記録（ジャーナルとの結線）
// ---------------------------------------------------------------------------

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

describe("[FR-CLI-018-AC2] completeIteration による prEvidence のジャーナル記録", () => {
  const openState = (): LoopState => ({
    version: "1",
    iterations: [
      { id: 1, startedAt: "2026-07-07T08:00:00Z", selectedTask: "T-1", decision: "着手" },
    ],
  });

  it("受理された evidence を開いたイテレーションに記録する", () => {
    const state = openState();
    const evaluation = evaluatePrEvidence({
      prNumbers: [304],
      fetched: [gateState({ number: 304 })],
      checkedAt: NOW,
    });
    if (evaluation.kind !== "accepted") expect.fail("accepted になるべき");
    const result = completeIteration({
      state,
      config,
      tasks: [],
      now: NOW,
      outcome: "completed",
      prEvidence: evaluation.evidence,
    });
    expect(result.kind).toBe("completed");
    expect(state.iterations[0].prEvidence).toEqual([
      {
        number: 304,
        state: "MERGED",
        reviewDecision: "APPROVED",
        unresolvedThreads: 0,
        pendingChecks: 0,
        checkedAt: NOW,
      },
    ]);
    if (result.kind === "completed") {
      expect(formatLoopComplete(result)).toContain("pr evidence: #304 MERGED");
    }
  });

  it("prEvidence 未指定なら従来どおりイテレーションに記録しない（後方互換）", () => {
    const state = openState();
    completeIteration({ state, config, tasks: [], now: NOW, outcome: "completed" });
    expect(state.iterations[0].prEvidence).toBeUndefined();
  });
});
