import React from "react";
import {
  summarizeLinkedPullRequests,
  type LinkedPullRequestRef,
  type LinkedPullRequestStatus,
} from "@gh-gantt/shared";

/** アイコンの一辺 (px)。アバターと同じ高さに揃える。 */
const ICON_SIZE = 14;

/** 状態ごとの色。GitHub の PR 状態色に合わせつつ既存トークンを優先する。 */
const STATUS_COLOR: Record<LinkedPullRequestStatus, string> = {
  draft: "var(--color-text-muted, #6e7781)",
  open: "var(--color-success, #1a7f37)",
  merged: "#8250df",
  closed: "var(--color-danger, #cf222e)",
};

const STATUS_LABEL: Record<LinkedPullRequestStatus, string> = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

/**
 * PR 状態のアイコン。Octicons の git-pull-request 系を簡略化した線画で、
 * draft は破線、merged は合流線、closed は右上の × で区別する。
 */
function PrStatusIcon({ status }: { status: LinkedPullRequestStatus }) {
  const stroke = "currentColor";
  const common = { fill: "none", stroke, strokeWidth: 1.6, strokeLinecap: "round" } as const;
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      {/* 左の縦線: ブランチ */}
      <circle cx="4" cy="3" r="1.8" {...common} />
      <circle cx="4" cy="13" r="1.8" {...common} />
      <line
        x1="4"
        y1="4.8"
        x2="4"
        y2="11.2"
        {...common}
        strokeDasharray={status === "draft" ? "1.5 1.5" : undefined}
      />
      {status === "merged" ? (
        <>
          {/* 合流線: 上のブランチから右下の点へ */}
          <circle cx="12" cy="13" r="1.8" {...common} />
          <path d="M4 5 C4 9 12 8 12 11.2" {...common} />
        </>
      ) : status === "closed" ? (
        <>
          <circle cx="12" cy="13" r="1.8" {...common} />
          <line x1="12" y1="11.2" x2="12" y2="8.5" {...common} />
          <path d="M9.8 2.5 L14.2 6.9 M14.2 2.5 L9.8 6.9" {...common} />
        </>
      ) : (
        <>
          {/* open / draft: 右側は PR の枝 */}
          <circle cx="12" cy="13" r="1.8" {...common} />
          <path d="M8 3 H10.5 A1.5 1.5 0 0 1 12 4.5 V11.2" {...common} />
        </>
      )}
    </svg>
  );
}

/**
 * Dependency Map のノードに置く関連 PR の状態バッジ。複数 PR がある場合は最も進んだ状態を代表し、
 * 件数を添える。クリックで代表 PR の URL を新規タブで開く (ノードの選択には伝播させない)。
 * 状態を持つ PR が無ければ何も描画しない。
 */
export function LinkedPrBadge({ linkedPrs }: { linkedPrs: LinkedPullRequestRef[] }) {
  const summary = summarizeLinkedPullRequests(linkedPrs);
  if (!summary) return null;
  const label =
    summary.count > 1
      ? `PR ${summary.count} 件 (代表: #${summary.number} ${STATUS_LABEL[summary.status]})`
      : `PR #${summary.number} ${STATUS_LABEL[summary.status]}`;
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 1,
    flexShrink: 0,
    color: STATUS_COLOR[summary.status],
    fontSize: 9,
    fontWeight: 600,
    lineHeight: 1,
    textDecoration: "none",
  };
  const content = (
    <>
      <PrStatusIcon status={summary.status} />
      {summary.count > 1 && <span data-pr-count={String(summary.count)}>{summary.count}</span>}
    </>
  );
  if (!summary.url) {
    return (
      <span data-pr-status={summary.status} title={label} aria-label={label} style={style}>
        {content}
      </span>
    );
  }
  return (
    <a
      data-pr-status={summary.status}
      href={summary.url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      // ノードの選択 (onNodeClick) やキー操作に伝播させない
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={style}
    >
      {content}
    </a>
  );
}
