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
//   ローカルからは PR の所在 (リポジトリ + 番号) の列挙のみ行う。
//   cross-repo の closing reference があるため、リポジトリは PR ごとに解決する。
// ---------------------------------------------------------------------------

/** ゲート評価の対象となる PR の所在。 */
export interface PrGateTarget {
  owner: string;
  repo: string;
  number: number;
  /** タスクのリポジトリと異なるリポジトリの PR かどうか。 */
  crossRepo: boolean;
}

/** GitHub API から取得した PR 1 件の live 状態スナップショット。 */
export interface PrGateState {
  owner: string;
  repo: string;
  number: number;
  crossRepo: boolean;
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

/** PR の所在を一意に識別するキー。番号は repo 単位でしか一意でない。 */
function targetKey(t: { owner: string; repo: string; number: number }): string {
  return `${t.owner.toLowerCase()}/${t.repo.toLowerCase()}#${t.number}`;
}

/** 診断表示用のラベル。同一リポジトリなら従来どおり番号のみ。 */
function prLabel(t: { owner: string; repo: string; number: number; crossRepo: boolean }): string {
  return t.crossRepo ? `${t.owner}/${t.repo}#${t.number}` : `#${t.number}`;
}

/** GitHub PR の URL から所在を解釈する。解釈できなければ null。 */
function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/#?].*)?$/.exec(url);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { owner: m[1], repo: m[2], number };
}

/**
 * linked_prs（番号形式 / メタデータ形式の両方）から PR の所在を重複なしで列挙する。
 * メタデータ形式は url からリポジトリを解決する（cross-repo の closing reference 対応）。
 * url がない・解釈できない場合と番号形式はタスクのリポジトリとみなす。
 * ローカルキャッシュの state はゲート判定に使わない。
 */
export function extractLinkedPrTargets(
  refs: LinkedPullRequestRef[],
  fallback: { owner: string; repo: string },
): PrGateTarget[] {
  const byKey = new Map<string, PrGateTarget>();
  for (const ref of refs) {
    let located: { owner: string; repo: string; number: number };
    if (typeof ref === "number") {
      located = { ...fallback, number: ref };
    } else {
      located = (ref.url ? parsePrUrl(ref.url) : null) ?? { ...fallback, number: ref.number };
    }
    const crossRepo =
      located.owner.toLowerCase() !== fallback.owner.toLowerCase() ||
      located.repo.toLowerCase() !== fallback.repo.toLowerCase();
    const target: PrGateTarget = { ...located, crossRepo };
    byKey.set(targetKey(target), target);
  }
  return [...byKey.values()].sort((a, b) =>
    a.owner === b.owner && a.repo === b.repo
      ? a.number - b.number
      : targetKey(a) < targetKey(b)
        ? -1
        : 1,
  );
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
 * --override-pr-gate の理由を正規化する。
 * 空文字・空白のみは「説明責任を果たしていない」として null を返す（呼び出し側で入力エラー扱い）。
 */
export function normalizeOverrideReason(
  input: string | undefined,
): { ok: true; reason: string | undefined } | { ok: false } {
  if (input === undefined) return { ok: true, reason: undefined };
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false };
  return { ok: true, reason: trimmed };
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
  if (state.crossRepo) evidence.repo = `${state.owner}/${state.repo}`;
  if (state.pendingChecks !== undefined) evidence.pendingChecks = state.pendingChecks;
  if (overrideReason !== undefined) {
    evidence.overridden = true;
    evidence.overrideReason = overrideReason;
  }
  return evidence;
}

/** 取得できなかった PR を UNKNOWN として記録する（override 時のみ生成される）。 */
function toUnknownEvidence(
  target: PrGateTarget,
  checkedAt: string,
  overrideReason: string,
): LoopPrEvidence {
  const evidence: LoopPrEvidence = {
    number: target.number,
    state: "UNKNOWN",
    checkedAt,
    overridden: true,
    overrideReason,
  };
  if (target.crossRepo) evidence.repo = `${target.owner}/${target.repo}`;
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
  targets: PrGateTarget[];
  fetched: PrGateState[] | null;
  fetchError?: string;
  checkedAt: string;
  overrideReason?: string;
}): PrEvidenceEvaluation {
  const { targets, fetched, fetchError, checkedAt, overrideReason } = params;

  const fetchedByKey = new Map((fetched ?? []).map((s) => [targetKey(s), s]));
  const missing = targets.filter((t) => !fetchedByKey.has(targetKey(t)));

  // fail-closed: live 状態が揃わない completed は受理しない（ADR-019）
  if (fetched === null || missing.length > 0) {
    if (overrideReason !== undefined) {
      return {
        kind: "accepted",
        evidence: targets.map((target) => {
          const state = fetchedByKey.get(targetKey(target));
          return state
            ? toEvidence(state, checkedAt, overrideReason)
            : toUnknownEvidence(target, checkedAt, overrideReason);
        }),
      };
    }
    const message =
      fetched === null
        ? (fetchError ?? "原因不明のエラー")
        : `PR ${missing.map(prLabel).join(", ")} の live 状態を取得できませんでした`;
    return { kind: "rejected_fetch_failed", message };
  }

  const states = targets.map((t) => fetchedByKey.get(targetKey(t))!);
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
        `  - PR ${prLabel(pr)}: OPEN (reviewDecision: ${pr.reviewDecision ?? "なし"}, ` +
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
 * cross-repo の PR はそれぞれのリポジトリに問い合わせる。
 * 1 件でも取得に失敗した場合は throw する（呼び出し側で fail-closed 扱いにする）。
 */
export async function fetchPrGateStates(params: {
  targets: PrGateTarget[];
}): Promise<PrGateState[]> {
  const { targets } = params;
  const client = await createGraphQLClient();
  const states: PrGateState[] = [];
  for (const target of targets) {
    const res = await client<PullRequestGateResponse>(PULL_REQUEST_GATE_QUERY, {
      owner: target.owner,
      repo: target.repo,
      number: target.number,
    });
    const pr = res.repository?.pullRequest;
    if (!pr) {
      throw new Error(`PR ${prLabel(target)} が ${target.owner}/${target.repo} に見つかりません`);
    }
    const state = pr.state;
    if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
      // 予期しない状態でゲート判定を誤らせない（fail-closed）
      throw new Error(`PR ${prLabel(target)} の状態 "${state}" を解釈できません`);
    }
    const rollup = pr.commits.nodes?.[0]?.commit.statusCheckRollup ?? null;
    states.push({
      owner: target.owner,
      repo: target.repo,
      number: pr.number,
      crossRepo: target.crossRepo,
      state,
      reviewDecision: pr.reviewDecision,
      unresolvedThreads: (pr.reviewThreads.nodes ?? []).filter((t) => t && !t.isResolved).length,
      pendingChecks: rollup ? countPendingChecks(rollup.contexts.nodes ?? []) : undefined,
    });
  }
  return states;
}
