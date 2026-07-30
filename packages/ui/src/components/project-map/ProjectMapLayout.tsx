import React from "react";

interface ProjectMapLayoutProps {
  tree: React.ReactNode;
  board: React.ReactNode;
  dependency: React.ReactNode;
  nextActions: React.ReactNode;
  timeline: React.ReactNode;
  runGraph: React.ReactNode;
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

/**
 * Project Map の 6 パネルを 3 段グリッドで配置するレイアウト。
 * 上段に System Tree / Project Board / Dependency Map、中段に Next Actions / Compact Gantt、
 * 下段に Planned vs Actual Run Graph を配置する。
 * 画面幅が狭い場合 (max-width 980px) は 1 カラムに折り返す。
 */
export function ProjectMapLayout({
  tree,
  board,
  dependency,
  nextActions,
  timeline,
  runGraph,
}: ProjectMapLayoutProps) {
  return (
    <div
      data-testid="project-map-layout"
      style={{
        display: "grid",
        gap: 8,
        padding: 8,
        height: "100%",
        boxSizing: "border-box",
        gridTemplateColumns: "minmax(220px, 1fr) minmax(280px, 1.6fr) minmax(240px, 1fr)",
        gridTemplateRows: "minmax(280px, 1.4fr) minmax(220px, 1fr) minmax(260px, 1.1fr)",
        gridTemplateAreas: `
          "tree board dependency"
          "next next timeline"
          "run run run"
        `,
        overflow: "auto",
      }}
    >
      <section style={{ ...panelStyle, gridArea: "tree" }} aria-label="System Tree">
        {tree}
      </section>
      <section style={{ ...panelStyle, gridArea: "board" }} aria-label="Project Board">
        {board}
      </section>
      <section style={{ ...panelStyle, gridArea: "dependency" }} aria-label="Dependency Map">
        {dependency}
      </section>
      <section style={{ ...panelStyle, gridArea: "next" }} aria-label="Next Actions">
        {nextActions}
      </section>
      <section style={{ ...panelStyle, gridArea: "timeline" }} aria-label="Compact Timeline">
        {timeline}
      </section>
      <section style={{ ...panelStyle, gridArea: "run" }} aria-label="Run Graph">
        {runGraph}
      </section>
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
