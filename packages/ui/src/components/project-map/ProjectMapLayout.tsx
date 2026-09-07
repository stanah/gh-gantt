import React, { useEffect, useState } from "react";
import {
  PROJECT_MAP_GRID_COLUMNS,
  defaultProjectMapLayoutSettings,
  packProjectMapPanels,
  type ProjectMapLayoutSettings,
  type ProjectMapPanelId,
} from "@gh-gantt/shared";

interface ProjectMapLayoutProps {
  tree: React.ReactNode;
  board: React.ReactNode;
  dependency: React.ReactNode;
  nextActions: React.ReactNode;
  timeline: React.ReactNode;
  runGraph: React.ReactNode;
  /** パネル構成。省略時は既定構成（6 パネル・固定順）。 */
  settings?: ProjectMapLayoutSettings;
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  background: "var(--color-surface)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  minWidth: 0,
};

/** パネル section の aria-label。既存テスト・スキルが参照する名前を維持する。 */
const PANEL_ARIA_LABELS: Record<ProjectMapPanelId, string> = {
  tree: "System Tree",
  board: "Project Board",
  dependency: "Dependency Map",
  next: "Next Actions",
  timeline: "Compact Timeline",
  run: "Run Graph",
};

/** この幅以下では 1 カラムに折り返す。 */
export const PROJECT_MAP_NARROW_QUERY = "(max-width: 980px)";

/** 画面幅が狭い（1 カラム表示にすべき）かどうかを matchMedia で監視する。 */
function useNarrowViewport(): boolean {
  const canMatch = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [narrow, setNarrow] = useState<boolean>(() =>
    canMatch ? window.matchMedia(PROJECT_MAP_NARROW_QUERY).matches : false,
  );
  useEffect(() => {
    if (!canMatch) return;
    const mq = window.matchMedia(PROJECT_MAP_NARROW_QUERY);
    const handler = (e: { matches: boolean }) => setNarrow(e.matches);
    setNarrow(mq.matches);
    // Safari 14 未満は addEventListener 未実装のため addListener にフォールバックする
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, [canMatch]);
  return narrow;
}

/**
 * Project Map の 6 パネルを設定に従って配置するレイアウト。
 * 3 カラムの grid に可視パネルを表示順で行パッキングし、サイズを column span
 * （標準=1 / 広い=2 / 全幅=3）で表現する。行に収まらないパネルは次行へ送り、
 * 各行末尾のパネルを残り列まで広げるので、非表示パネルの領域は残りに再配分される。
 * 既定構成では上段に System Tree /
 * Project Board / Dependency Map、中段に Next Actions / Compact Gantt、下段に Run Graph が並ぶ。
 * 画面幅が狭い場合 (max-width 980px) は 1 カラムに折り返す。
 */
export function ProjectMapLayout({
  tree,
  board,
  dependency,
  nextActions,
  timeline,
  runGraph,
  settings,
}: ProjectMapLayoutProps) {
  const narrow = useNarrowViewport();
  const columns = narrow ? 1 : PROJECT_MAP_GRID_COLUMNS;
  const content: Record<ProjectMapPanelId, React.ReactNode> = {
    tree,
    board,
    dependency,
    next: nextActions,
    timeline,
    run: runGraph,
  };
  const panels = packProjectMapPanels(settings ?? defaultProjectMapLayoutSettings(), columns);

  return (
    <div
      data-testid="project-map-layout"
      data-columns={String(columns)}
      style={{
        display: "grid",
        gap: 8,
        padding: 8,
        height: "100%",
        boxSizing: "border-box",
        // 旧固定レイアウトと同程度の最小列幅を残し、狭幅では 1 カラムに折り返す
        gridTemplateColumns: `repeat(${columns}, minmax(220px, 1fr))`,
        gridAutoRows: "minmax(240px, 1fr)",
        gridAutoFlow: "row",
        overflow: "auto",
      }}
    >
      {panels.map((panel) => (
        <section
          key={panel.id}
          data-panel={panel.id}
          style={{ ...panelStyle, gridColumn: `span ${panel.span}` }}
          aria-label={PANEL_ARIA_LABELS[panel.id]}
        >
          {content[panel.id]}
        </section>
      ))}
    </div>
  );
}

/** パネル共通のヘッダー。 */
export function PanelHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      style={{
        padding: "6px 10px",
        borderBottom: "1px solid var(--color-border)",
        fontSize: 12,
        fontWeight: 600,
        color: "var(--color-text)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span>{title}</span>
      {hint && (
        <span style={{ fontSize: 10, fontWeight: 400, color: "var(--color-text-muted)" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** パネル本文のスクロール領域。 */
export function PanelBody({ children }: { children: React.ReactNode }) {
  return <div style={{ overflow: "auto", padding: 8, flex: 1, minHeight: 0 }}>{children}</div>;
}

/** パネル内の空状態メッセージ。 */
export function PanelEmpty({ message }: { message: string }) {
  return (
    <div
      style={{ padding: 16, fontSize: 12, color: "var(--color-text-muted)", textAlign: "center" }}
    >
      {message}
    </div>
  );
}
