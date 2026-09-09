import type { LinkedPullRequest, LinkedPullRequestRef } from "./types.js";

/** 関連 PR の表示上の状態。GitHub の state (open / merged / closed) に Draft を加えた 4 状態。 */
export type LinkedPullRequestStatus = "draft" | "open" | "merged" | "closed";

/**
 * 「進んだ」順の序列。複数 PR の代表を選ぶときに使う。
 * Draft → Open → Merged が本来の進行で、Closed は merge されずに終わった PR なので最下位に置く。
 */
const STATUS_RANK: Record<LinkedPullRequestStatus, number> = {
  closed: 0,
  draft: 1,
  open: 2,
  merged: 3,
};

/** metadata object を持つ参照だけを返す (legacy number は状態を持たないため除く)。 */
export function linkedPullRequestObjects(refs: LinkedPullRequestRef[]): LinkedPullRequest[] {
  return refs.filter((ref): ref is LinkedPullRequest => typeof ref === "object" && ref !== null);
}

/**
 * PR の表示状態を求める。Draft PR は GitHub 上では state が open のまま isDraft が true になるため、
 * `is_draft` が true で open なら draft とする。未知の state は open として扱う。
 */
export function linkedPullRequestStatus(pr: LinkedPullRequest): LinkedPullRequestStatus {
  const state = pr.state.toLowerCase();
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return pr.is_draft === true ? "draft" : "open";
}

/** 複数の関連 PR を代表 1 件に要約した結果。 */
export interface LinkedPullRequestSummary {
  /** 最も進んだ状態。 */
  status: LinkedPullRequestStatus;
  /** 代表 PR の番号。 */
  number: number;
  /** 代表 PR の URL。取得できていなければ null。 */
  url: string | null;
  /** 状態を持つ関連 PR の総数。 */
  count: number;
}

/**
 * 関連 PR から代表 1 件を選ぶ。最も進んだ状態 (merged > open > draft > closed) の PR を代表とし、
 * 同順位なら番号の大きい (新しい) 方を採る。状態を持つ PR が無ければ null。
 */
export function summarizeLinkedPullRequests(
  refs: LinkedPullRequestRef[],
): LinkedPullRequestSummary | null {
  const prs = linkedPullRequestObjects(refs);
  if (prs.length === 0) return null;
  let best = prs[0];
  let bestStatus = linkedPullRequestStatus(best);
  for (const pr of prs.slice(1)) {
    const status = linkedPullRequestStatus(pr);
    const rankDiff = STATUS_RANK[status] - STATUS_RANK[bestStatus];
    if (rankDiff > 0 || (rankDiff === 0 && pr.number > best.number)) {
      best = pr;
      bestStatus = status;
    }
  }
  return { status: bestStatus, number: best.number, url: best.url, count: prs.length };
}
