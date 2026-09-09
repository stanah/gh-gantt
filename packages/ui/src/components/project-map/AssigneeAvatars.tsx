import React, { useEffect, useState } from "react";

/** アバターの一辺 (px)。ノードの右下に半分はみ出して重ねる前提の大きさ。 */
export const AVATAR_SIZE = 18;
/** ノード上に画像で表示する担当者の最大人数。超過分は「+N」にまとめる。 */
export const MAX_VISIBLE_ASSIGNEES = 2;

/**
 * GitHub の決定的なアバター URL。追加の API 呼び出しや同期フィールドを増やさず、
 * login だけから画像を取得できる。
 */
export function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=40`;
}

/** イニシャルのプレースホルダ用に login の先頭 2 文字を大文字で返す。 */
export function assigneeInitials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

const circleStyle: React.CSSProperties = {
  boxSizing: "border-box",
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  borderRadius: "50%",
  border: "1px solid var(--color-surface, #fff)",
  background: "var(--color-hover-bg, #f5f8ff)",
  flexShrink: 0,
  overflow: "hidden",
};

/**
 * 担当者 1 人分のアバター。画像の取得に失敗した場合 (オフライン等) は同じ寸法の
 * イニシャルのプレースホルダに置き換え、レイアウトを崩さない。
 */
function AssigneeAvatar({ login, overlap }: { login: string; overlap: boolean }) {
  const [failed, setFailed] = useState(false);
  // login が変わったら再度画像の取得を試みる
  useEffect(() => setFailed(false), [login]);
  const style: React.CSSProperties = { ...circleStyle, marginLeft: overlap ? -5 : 0 };
  if (failed) {
    return (
      <span
        data-avatar={login}
        data-avatar-fallback="true"
        title={login}
        aria-hidden="true"
        style={{
          ...style,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 8,
          fontWeight: 600,
          lineHeight: 1,
          color: "var(--color-text)",
        }}
      >
        {assigneeInitials(login)}
      </span>
    );
  }
  return (
    <img
      data-avatar={login}
      src={githubAvatarUrl(login)}
      alt=""
      title={login}
      width={AVATAR_SIZE}
      height={AVATAR_SIZE}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ ...style, display: "block", objectFit: "cover" }}
    />
  );
}

/**
 * Dependency Map のノードに置く担当者アバター列。最大 {@link MAX_VISIBLE_ASSIGNEES} 人を
 * 重ねて表示し、超過分は「+N」の丸で示す。担当者がいなければ何も描画せず空領域を作らない。
 * 各要素の title に login を持たせ、ホバーで担当者名が分かるようにする。
 */
export function AssigneeAvatars({ assignees }: { assignees: string[] }) {
  if (assignees.length === 0) return null;
  const visible = assignees.slice(0, MAX_VISIBLE_ASSIGNEES);
  const rest = assignees.slice(MAX_VISIBLE_ASSIGNEES);
  return (
    <span
      data-assignees={assignees.join(",")}
      role="img"
      aria-label={`担当: ${assignees.join(", ")}`}
      title={assignees.join(", ")}
      style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}
    >
      {visible.map((login, i) => (
        <AssigneeAvatar key={login} login={login} overlap={i > 0} />
      ))}
      {rest.length > 0 && (
        <span
          data-avatar-overflow={String(rest.length)}
          title={rest.join(", ")}
          aria-hidden="true"
          style={{
            ...circleStyle,
            marginLeft: -5,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 8,
            fontWeight: 600,
            lineHeight: 1,
            color: "var(--color-text-muted)",
          }}
        >
          +{rest.length}
        </span>
      )}
    </span>
  );
}
