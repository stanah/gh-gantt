import type { LinkedPullRequestRef, LoopIterationOutcome, LoopPrEvidence } from "@gh-gantt/shared";
import { createGraphQLClient } from "../github/client.js";
import { PULL_REQUEST_GATE_QUERY } from "../github/queries.js";

// ---------------------------------------------------------------------------
// loop complete の PR evidence ゲート（ADR-019）
//
// - ゲート判定は PR の live 状態 (OPEN / MERGED / CLOSED) のみで行う。
//   reviewDecision / 未解決スレッド数 / pending checks は拒否時の診断表示と
//   prEvidence 記録のための参考情報であり、判定には使わない。
// - fail-closed: live 状態を取得できない場合は completed を拒否し、
//   --override-pr-gate による意識的なバイパスだけを許可する。
// - ローカルキャッシュ (linked_prs の state) には依存しない。
//   ローカルからは PR 番号の列挙のみ行う。
// ---------------------------------------------------------------------------

/** GitHub API から取得した PR 1 件の live 状態スナップショット。 */
export interface PrGateState {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  reviewDecision: string | null;
  /** 未解決レビュースレッド数（先頭 100 件までの集計）。 */
  unresolvedThreads: number;
  /** 完了していないチェック数（先頭 100 件までの集計）。チェック未設定なら undefined。 */
  pendingChecks: number | undefined;
}

/** ゲート評価の結果。 */
export type PrEvidenceEvaluation =
  | { kind: "accepted"; evidence: LoopPrEvidence[] }
  | { kind: "rejected_open_prs"; openPrs: PrGateState[] }
  | { kind: "rejected_fetch_failed"; message: string };

export type PrGateRejection =
  | Exclude<PrEvidenceEvaluation, { kind: "accepted" }>
  | { kind: "rejected_task_missing"; taskId: string };

/**
 * linked_prs（番号形式 / メタデータ形式の両方）から PR 番号を重複なしで列挙する。
 * メタデータ形式の state はローカルキャッシュであり、ゲート判定には使わない。
 */
export function extractLinkedPrNumbers(refs: LinkedPullRequestRef[]): number[] {
  const numbers = refs.map((ref) => (typeof ref === "number" ? ref : ref.number));
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/**
 * ゲートを適用すべきかを判定する。
 * 適用しない場合は従来どおり complete する（後方互換）。
 */
export function shouldApplyPrGate(params: {
  outcome: LoopIterationOutcome;
  requirePrEvidence: boolean;
  prNumbers: number[];
}): boolean {
  return params.outcome === "completed" && params.requirePrEvidence && params.prNumbers.length > 0;
}

/**
 * 選定タスクがローカル tasks.json に見つからない場合の fail-closed 判定。
 * タスクが不在だと linked PR を列挙できず、ゲートが黙ってスキップされる
 * fail-open になってしまうため、completed は override なしでは受理しない。
 */
export function detectMissingTaskRejection(params: {
  outcome: LoopIterationOutcome;
  requirePrEvidence: boolean;
  selectedTask: string | null | undefined;
  taskFound: boolean;
  overrideReason?: string;
}): PrGateRejection | null {
  if (params.outcome !== "completed" || !params.requirePrEvidence) return null;
  if (!params.selectedTask || params.taskFound) return null;
  if (params.overrideReason !== undefined) return null;
  return { kind: "rejected_task_missing", taskId: params.selectedTask };
}

/** PrGateState を prEvidence の 1 エントリに変換する。 */
function toEvidence(
  state: PrGateState,
  checkedAt: string,
  overrideReason?: string,
): LoopPrEvidence {
  const evidence: LoopPrEvidence = {
    number: state.number,
    state: state.state,
    reviewDecision: state.reviewDecision,
    unresolvedThreads: state.unresolvedThreads,
    checkedAt,
  };
  if (state.pendingChecks !== undefined) evidence.pendingChecks = state.pendingChecks;
  if (overrideReason !== undefined) {
    evidence.overridden = true;
    evidence.overrideReason = overrideReason;
  }
  return evidence;
}

/**
 * PR evidence ゲートを評価する純粋関数（ADR-019）。
 *
 * - `fetched` が null（API 到達不能）なら fail-closed で拒否する。
 *   override 指定時のみ、取得できなかった PR を state UNKNOWN として記録し受理する。
 * - OPEN の PR が 1 件でも残っていれば拒否する。override 指定時は
 *   evidence 全件に overridden / overrideReason を記録した上で受理する。
 */
export function evaluatePrEvidence(params: {
  prNumbers: number[];
  fetched: PrGateState[] | null;
  fetchError?: string;
  checkedAt: string;
  overrideReason?: string;
}): PrEvidenceEvaluation {
  const { prNumbers, fetched, fetchError, checkedAt, overrideReason } = params;

  const fetchedByNumber = new Map((fetched ?? []).map((s) => [s.number, s]));
  const missing = prNumbers.filter((n) => !fetchedByNumber.has(n));

  // fail-closed: live 状態が揃わない completed は受理しない（ADR-019）
  if (fetched === null || missing.length > 0) {
    if (overrideReason !== undefined) {
      return {
        kind: "accepted",
        evidence: prNumbers.map((number) => {
          const state = fetchedByNumber.get(number);
          return state
            ? toEvidence(state, checkedAt, overrideReason)
            : { number, state: "UNKNOWN" as const, checkedAt, overridden: true, overrideReason };
        }),
      };
    }
    const message =
      fetched === null
        ? (fetchError ?? "原因不明のエラー")
        : `PR #${missing.join(", #")} の live 状態を取得できませんでした`;
    return { kind: "rejected_fetch_failed", message };
  }

  const states = prNumbers.map((n) => fetchedByNumber.get(n)!);
  const openPrs = states.filter((s) => s.state === "OPEN");
  if (openPrs.length === 0) {
    return { kind: "accepted", evidence: states.map((s) => toEvidence(s, checkedAt)) };
  }
  if (overrideReason !== undefined) {
    return {
      kind: "accepted",
      evidence: states.map((s) => toEvidence(s, checkedAt, overrideReason)),
    };
  }
  return { kind: "rejected_open_prs", openPrs };
}

/** ゲート拒否時の診断メッセージ（人間向け・日本語）。 */
export function formatPrGateRejection(rejection: PrGateRejection): string {
  const lines: string[] = [];
  if (rejection.kind === "rejected_task_missing") {
    lines.push(
      `completed を拒否しました: 選定タスク ${rejection.taskId} がローカル tasks.json に` +
        "見つからず、linked PR を列挙できません (fail-closed)",
    );
    lines.push("  gh-gantt pull で同期してから再実行してください。");
  } else if (rejection.kind === "rejected_fetch_failed") {
    lines.push("completed を拒否しました: PR の live 状態を取得できませんでした (fail-closed)");
    lines.push(`  error: ${rejection.message}`);
    lines.push("  ネットワークと認証 (GITHUB_TOKEN / gh auth) を確認して再実行してください。");
  } else {
    lines.push("completed を拒否しました: レビューサイクル未完了の OPEN な PR が残っています");
    for (const pr of rejection.openPrs) {
      const checks =
        pr.pendingChecks === undefined ? "チェックなし" : `pending checks: ${pr.pendingChecks}`;
      lines.push(
        `  - PR #${pr.number}: OPEN (reviewDecision: ${pr.reviewDecision ?? "なし"}, ` +
          `未解決スレッド: ${pr.unresolvedThreads}, ${checks})`,
      );
    }
    lines.push("  PR をマージまたはクローズしてから再実行してください。");
  }
  lines.push('  意識的にバイパスする場合は --override-pr-gate "<理由>" を指定してください。');
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GraphQL フェッチャー（評価ロジックとは分離。単体テストは評価側のみを対象とする）
// ---------------------------------------------------------------------------

/** PULL_REQUEST_GATE_QUERY のレスポンスのうち利用する部分。 */
interface PullRequestGateResponse {
  repository: {
    pullRequest: {
      number: number;
      state: string;
      reviewDecision: string | null;
      reviewThreads: { nodes: Array<{ isResolved: boolean } | null> | null };
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: Array<{ __typename: string; status?: string; state?: string } | null> | null;
              };
            } | null;
          };
        } | null> | null;
      };
    } | null;
  } | null;
}

/** 完了していないチェック数を数える（CheckRun: COMPLETED 以外 / StatusContext: PENDING・EXPECTED）。 */
function countPendingChecks(
  nodes: Array<{ __typename: string; status?: string; state?: string } | null>,
): number {
  let pending = 0;
  for (const node of nodes) {
    if (!node) continue;
    if (node.__typename === "CheckRun") {
      if (node.status !== "COMPLETED") pending++;
    } else if (node.__typename === "StatusContext") {
      if (node.state === "PENDING" || node.state === "EXPECTED") pending++;
    }
  }
  return pending;
}

/**
 * GitHub GraphQL API から PR の live 状態を取得する。
 * 1 件でも取得に失敗した場合は throw する（呼び出し側で fail-closed 扱いにする）。
 */
export async function fetchPrGateStates(params: {
  owner: string;
  repo: string;
  prNumbers: number[];
}): Promise<PrGateState[]> {
  const { owner, repo, prNumbers } = params;
  const client = await createGraphQLClient();
  const states: PrGateState[] = [];
  for (const number of prNumbers) {
    const res = await client<PullRequestGateResponse>(PULL_REQUEST_GATE_QUERY, {
      owner,
      repo,
      number,
    });
    const pr = res.repository?.pullRequest;
    if (!pr) {
      throw new Error(`PR #${number} が ${owner}/${repo} に見つかりません`);
    }
    const state = pr.state;
    if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
      // 予期しない状態でゲート判定を誤らせない（fail-closed）
      throw new Error(`PR #${number} の状態 "${state}" を解釈できません`);
    }
    const rollup = pr.commits.nodes?.[0]?.commit.statusCheckRollup ?? null;
    states.push({
      number: pr.number,
      state,
      reviewDecision: pr.reviewDecision,
      unresolvedThreads: (pr.reviewThreads.nodes ?? []).filter((t) => t && !t.isResolved).length,
      pendingChecks: rollup ? countPendingChecks(rollup.contexts.nodes ?? []) : undefined,
    });
  }
  return states;
}
