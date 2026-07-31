import React from "react";
import {
  PROJECT_MAP_RUN_DEVIATION_LIMIT,
  type ProjectMapRunGraphViewModel,
  type ProjectMapRunMetric,
} from "@gh-gantt/shared";
import { PanelBody, PanelEmpty, PanelHeader } from "./ProjectMapLayout.js";

interface RunGraphPanelProps {
  viewModel: ProjectMapRunGraphViewModel | null;
  loading: boolean;
  error: string | null;
  onSelectRun: (runId: string) => void;
  onSelectNode: (nodeId: string) => void;
}

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  padding: 8,
  minWidth: 0,
};

function formatDuration(value: number | null): string {
  if (value == null) return "unknown";
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function Metric({ label, metric }: { label: string; metric: ProjectMapRunMetric }) {
  const value =
    metric.known && metric.value != null
      ? metric.unit === "ms"
        ? formatDuration(metric.value)
        : `${metric.value} ${metric.unit}`
      : "unknown";
  return (
    <div>
      <dt style={{ color: "var(--color-text-muted)" }}>{label}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>{value}</dd>
    </div>
  );
}

/** Project Map 上で planned と actual の Run Graph を比較する読み取り専用 panel。 */
export function RunGraphPanel({
  viewModel,
  loading,
  error,
  onSelectRun,
  onSelectNode,
}: RunGraphPanelProps) {
  return (
    <>
      <PanelHeader title="Planned vs Actual" hint="Run Graph" />
      {loading ? (
        <div role="status" style={{ padding: 12 }}>
          Run Graph を読み込み中…
        </div>
      ) : null}
      {error ? (
        <div role="alert" style={{ padding: 12, color: "var(--color-danger, #e74c3c)" }}>
          {error}
        </div>
      ) : null}
      {!loading && !error && !viewModel ? <PanelEmpty message="タスクを選択してください" /> : null}
      {!loading && !error && viewModel && viewModel.runs.total === 0 ? (
        <PanelEmpty message="このタスクの Run Graph はありません" />
      ) : null}
      {!loading && !error && viewModel?.selectedRun ? (
        <PanelBody>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <label style={{ fontSize: 11 }}>
              Run
              <select
                aria-label="Run を選択"
                value={viewModel.selectedRun.runId}
                onChange={(event) => onSelectRun(event.target.value)}
                style={{ marginLeft: 6 }}
              >
                {viewModel.runs.items.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId} · {run.displayState}
                  </option>
                ))}
              </select>
            </label>
            <strong style={{ fontSize: 11 }}>{viewModel.selectedRun.displayState}</strong>
            {viewModel.selectedRun.waitReason ? (
              <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                {viewModel.selectedRun.waitReason}
              </span>
            ) : null}
            <a href={viewModel.selectedRun.deepLink} aria-label="選択 node の deep link">
              deep link
            </a>
          </div>

          <dl
            aria-label="Run metrics"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(80px, 1fr))",
              gap: 8,
              margin: "0 0 8px",
              fontSize: 10,
            }}
          >
            <Metric label="duration" metric={viewModel.selectedRun.metrics.duration} />
            <Metric label="tokens" metric={viewModel.selectedRun.metrics.tokens} />
            <Metric label="cost" metric={viewModel.selectedRun.metrics.cost} />
            <Metric label="latency" metric={viewModel.selectedRun.metrics.latency} />
          </dl>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(220px, 1fr))",
              gap: 8,
            }}
          >
            <section aria-label="Planned nodes" style={sectionStyle}>
              <strong style={{ fontSize: 11 }}>Planned</strong>
              <ol style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 11 }}>
                {viewModel.selectedRun.planned.nodes.items.map((node) => (
                  <li key={node.id}>
                    {node.id} · {node.role}
                  </li>
                ))}
              </ol>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 10 }}>
                {viewModel.selectedRun.planned.edges.items.map((edge) => (
                  <li key={edge.id}>
                    {edge.from} → {edge.to} · {edge.conditions.join(" / ")}
                  </li>
                ))}
              </ul>
              {viewModel.selectedRun.planned.nodes.truncated ||
              viewModel.selectedRun.planned.edges.truncated ? (
                <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                  planned detail は上限 {viewModel.selectedRun.planned.nodes.limit} 件
                </div>
              ) : null}
            </section>
            <section aria-label="Actual nodes" style={sectionStyle}>
              <strong style={{ fontSize: 11 }}>Actual</strong>
              <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                {viewModel.selectedRun.actual.nodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    aria-pressed={viewModel.selectedRun?.selectedNodeId === node.id}
                    aria-label={`${node.contractNodeId} ${node.id}`}
                    onClick={() => onSelectNode(node.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onSelectNode(node.id);
                    }}
                    style={{ textAlign: "left", fontSize: 11 }}
                  >
                    {node.contractNodeId} · {node.displayState} · {node.actor.id} · {node.createdAt}{" "}
                    → {node.endedAt ?? "running"} · {formatDuration(node.durationMs)} · artifact{" "}
                    {node.artifactCount} · evidence {node.evidenceCount}
                  </button>
                ))}
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 10 }}>
                {viewModel.selectedRun.actual.transitions.map((transition) => (
                  <li key={`${transition.fromNodeId}->${transition.toNodeId}`}>
                    {transition.fromNodeId} → {transition.toNodeId} ·{" "}
                    {transition.isPlanned ? "planned" : "unplanned"}
                  </li>
                ))}
              </ul>
              {viewModel.selectedRun.actual.nodesTruncated ? (
                <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                  actual node は一部のみ表示
                </div>
              ) : null}
            </section>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(220px, 1fr))",
              gap: 8,
              marginTop: 8,
            }}
          >
            <section aria-label="Attempts" style={sectionStyle}>
              <strong style={{ fontSize: 11 }}>Attempts</strong>
              {viewModel.selectedRun.actual.attempts.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>attempt なし</div>
              ) : (
                <ul style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 11 }}>
                  {viewModel.selectedRun.actual.attempts.map((attempt) => (
                    <li key={attempt.id}>
                      {attempt.nodeId} · {attempt.id} · {attempt.actor.id} · {attempt.actor.role} ·{" "}
                      {attempt.createdAt} → {attempt.endedAt ?? "running"} ·{" "}
                      {formatDuration(attempt.durationMs)} · artifact {attempt.artifactCount} ·
                      evidence {attempt.evidenceCount}
                    </li>
                  ))}
                </ul>
              )}
              {viewModel.selectedRun.actual.attemptsTruncated ? (
                <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                  attempt は一部のみ表示
                </div>
              ) : null}
            </section>
            <section aria-label="Run deviations" style={sectionStyle}>
              <strong style={{ fontSize: 11 }}>Differences</strong>
              {viewModel.selectedRun.deviations.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                  {viewModel.selectedRun.actual.nodesTruncated
                    ? "表示範囲に planned との差分なし（全履歴は未確認）"
                    : "planned との差分なし"}
                </div>
              ) : (
                <ul style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 11 }}>
                  {viewModel.selectedRun.deviations.map((deviation) => (
                    <li key={deviation.id}>{deviation.reason}</li>
                  ))}
                </ul>
              )}
              {viewModel.selectedRun.deviationsTruncated ? (
                <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                  差分は先頭 {PROJECT_MAP_RUN_DEVIATION_LIMIT} 件のみ表示
                </div>
              ) : null}
              {viewModel.selectedRun.artifacts.truncated ||
              viewModel.selectedRun.evidence.truncated ? (
                <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                  artifact/evidence 件数は bounded 表示
                </div>
              ) : null}
            </section>
          </div>
        </PanelBody>
      ) : null}
    </>
  );
}
