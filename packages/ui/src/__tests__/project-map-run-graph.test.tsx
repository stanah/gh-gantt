// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectMapRunGraphViewModel } from "@gh-gantt/shared";
import { RunGraphPanel } from "../components/project-map/RunGraphPanel.js";
import { useRunGraphDeepLink } from "../hooks/useRunGraphDeepLink.js";
import { useProjectMapRunGraph } from "../hooks/useProjectMapRunGraph.js";

const viewModel: ProjectMapRunGraphViewModel = {
  schemaVersion: "1",
  taskId: "stanah/gh-gantt#330",
  runs: {
    total: 1,
    limit: 20,
    truncated: false,
    items: [
      {
        runId: "run-330",
        taskId: "stanah/gh-gantt#330",
        state: "waiting_human",
        displayState: "waiting_human",
        currentNodeId: "node-2",
        currentContractNodeId: "implementer",
        waitReason: "review_budget_exhausted",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:04:00.000Z",
        nodeCount: 2,
        attemptCount: 1,
        deepLink: "?view=project-map&task=stanah%2Fgh-gantt%23330&run=run-330&node=node-2",
      },
    ],
  },
  selectedRun: {
    runId: "run-330",
    taskId: "stanah/gh-gantt#330",
    state: "waiting_human",
    displayState: "waiting_human",
    waitReason: "review_budget_exhausted",
    selectedNodeId: "node-2",
    deepLink: "?view=project-map&task=stanah%2Fgh-gantt%23330&run=run-330&node=node-2",
    planned: {
      nodes: {
        total: 2,
        limit: 20,
        truncated: false,
        items: [
          { id: "planner", role: "planner" },
          { id: "implementer", role: "implementer" },
        ],
      },
      edges: {
        total: 1,
        limit: 20,
        truncated: false,
        items: [
          { id: "plan-valid", from: "planner", to: "implementer", conditions: ["plan_valid"] },
        ],
      },
    },
    actual: {
      nodes: [
        {
          id: "node-1",
          contractNodeId: "planner",
          state: "completed",
          displayState: "completed",
          actor: { id: "planner-1", role: "planner" },
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:01:00.000Z",
          endedAt: "2026-07-30T00:01:00.000Z",
          durationMs: 60000,
          attemptCount: 1,
          artifactCount: 0,
          evidenceCount: 0,
          isPlanned: true,
          deepLink: "?view=project-map&task=stanah%2Fgh-gantt%23330&run=run-330&node=node-1",
        },
        {
          id: "node-2",
          contractNodeId: "implementer",
          state: "ready",
          displayState: "retrying",
          actor: { id: "implementer-1", role: "implementer" },
          createdAt: "2026-07-30T00:01:00.000Z",
          updatedAt: "2026-07-30T00:04:00.000Z",
          endedAt: null,
          durationMs: 180000,
          attemptCount: 0,
          artifactCount: 0,
          evidenceCount: 0,
          isPlanned: true,
          deepLink: "?view=project-map&task=stanah%2Fgh-gantt%23330&run=run-330&node=node-2",
        },
      ],
      transitions: [
        {
          fromNodeId: "node-1",
          toNodeId: "node-2",
          fromContractNodeId: "planner",
          toContractNodeId: "implementer",
          isPlanned: true,
        },
      ],
      attempts: [
        {
          id: "attempt-1",
          nodeId: "node-1",
          ordinal: 1,
          state: "succeeded",
          actor: { id: "planner-1", role: "planner" },
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:01:00.000Z",
          endedAt: "2026-07-30T00:01:00.000Z",
          durationMs: 60000,
          artifactCount: 0,
          evidenceCount: 0,
        },
      ],
      nodesTruncated: false,
      attemptsTruncated: false,
    },
    deviations: [
      {
        id: "retry:node-2",
        kind: "retry",
        nodeId: "node-2",
        transition: null,
        reason: "implementer を再試行",
      },
    ],
    metrics: {
      duration: { known: true, value: 240000, unit: "ms" },
      tokens: { known: false, value: null, unit: "token" },
      cost: { known: false, value: null, unit: "currency" },
      latency: { known: false, value: null, unit: "ms" },
    },
    artifacts: { total: 0, limit: 20, truncated: false, items: [] },
    evidence: { total: 0, limit: 20, truncated: false, items: [] },
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function DeepLinkProbe() {
  const { selectedRunId, selectedNodeId, setSelectedRunId, setSelectedNodeId } =
    useRunGraphDeepLink();
  return (
    <div>
      <output aria-label="selected run">{selectedRunId ?? ""}</output>
      <output aria-label="selected node">{selectedNodeId ?? ""}</output>
      <button type="button" onClick={() => setSelectedRunId("run-next")}>
        run
      </button>
      <button type="button" onClick={() => setSelectedNodeId("node-next")}>
        node
      </button>
    </div>
  );
}

function FetchProbe({ taskId = "stanah/gh-gantt#330" }: { taskId?: string | null }) {
  const result = useProjectMapRunGraph(taskId, "run-330", "node-2", true);
  return (
    <div>
      <output aria-label="run loading">{String(result.loading)}</output>
      <output aria-label="run data">{result.viewModel?.selectedRun?.runId ?? ""}</output>
      <output aria-label="run error">{result.error ?? ""}</output>
    </div>
  );
}

describe("[FR-VIS-026-AC6] planned-vs-actual panel の操作性", () => {
  it("状態、待機理由、planned/actual、attempt、差分、unknown metric を表示する", () => {
    const { getByLabelText, getByText, getAllByText } = render(
      <RunGraphPanel
        viewModel={viewModel}
        loading={false}
        error={null}
        onSelectRun={vi.fn()}
        onSelectNode={vi.fn()}
      />,
    );

    expect(getByText("Planned vs Actual")).toBeTruthy();
    expect(getByText("waiting_human")).toBeTruthy();
    expect(getByText("review_budget_exhausted")).toBeTruthy();
    expect(getByLabelText("Planned nodes").textContent).toContain("planner");
    expect(getByLabelText("Planned nodes").textContent).toContain("planner → implementer");
    expect(getByLabelText("Actual nodes").textContent).toContain("retrying");
    expect(getByLabelText("Actual nodes").textContent).toContain("node-1 → node-2");
    expect(getByLabelText("Actual nodes").textContent).toContain("artifact 0 · evidence 0");
    expect(getByText("implementer を再試行")).toBeTruthy();
    expect(
      within(getByLabelText("Attempts")).getByText(
        /node-1.*attempt-1.*planner-1.*planner.*2026-07-30T00:00:00.000Z.*2026-07-30T00:01:00.000Z.*60s.*artifact 0.*evidence 0/,
      ),
    ).toBeTruthy();
    expect(getAllByText("unknown")).toHaveLength(3);
  });

  it("run 選択と node の Enter 操作を callback に渡し deep link を公開する", () => {
    const onSelectRun = vi.fn();
    const onSelectNode = vi.fn();
    const { getByLabelText, getByRole } = render(
      <RunGraphPanel
        viewModel={viewModel}
        loading={false}
        error={null}
        onSelectRun={onSelectRun}
        onSelectNode={onSelectNode}
      />,
    );

    fireEvent.change(getByLabelText("Run を選択"), { target: { value: "run-330" } });
    expect(onSelectRun).toHaveBeenCalledWith("run-330");

    const node = getByRole("button", { name: /implementer.*node-2/ });
    fireEvent.keyDown(node, { key: "Enter" });
    expect(onSelectNode).toHaveBeenCalledWith("node-2");
    expect(getByRole("link", { name: "選択 node の deep link" }).getAttribute("href")).toContain(
      "node=node-2",
    );
  });

  it("Run Graph がない場合は空状態を表示する", () => {
    const { getByText } = render(
      <RunGraphPanel
        viewModel={{
          ...viewModel,
          runs: { total: 0, limit: 20, truncated: false, items: [] },
          selectedRun: null,
        }}
        loading={false}
        error={null}
        onSelectRun={vi.fn()}
        onSelectNode={vi.fn()}
      />,
    );

    expect(getByText("このタスクの Run Graph はありません")).toBeTruthy();
  });
});

describe("[FR-VIS-026-AC4] run/node の URL deep link", () => {
  it("query から復元し、run 変更時は stale node を消して Project Map view を維持する", () => {
    window.history.replaceState({}, "", "/?labels=area%3Aui&run=run-330&node=node-2");
    const { getByLabelText, getByText } = render(<DeepLinkProbe />);

    expect(getByLabelText("selected run").textContent).toBe("run-330");
    expect(getByLabelText("selected node").textContent).toBe("node-2");

    fireEvent.click(getByText("run"));
    const afterRun = new URL(window.location.href).searchParams;
    expect(afterRun.get("run")).toBe("run-next");
    expect(afterRun.has("node")).toBe(false);
    expect(afterRun.get("view")).toBe("project-map");
    expect(afterRun.get("labels")).toBe("area:ui");

    fireEvent.click(getByText("node"));
    expect(new URL(window.location.href).searchParams.get("node")).toBe("node-next");
  });

  it("選択 task/run/node だけを bounded API query に渡す", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => viewModel,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText } = render(<FetchProbe />);
    await waitFor(() => expect(getByLabelText("run data").textContent).toBe("run-330"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(requestUrl.pathname).toBe("/api/project-map/run-graph");
    expect(requestUrl.searchParams.get("taskId")).toBe("stanah/gh-gantt#330");
    expect(requestUrl.searchParams.get("runId")).toBe("run-330");
    expect(requestUrl.searchParams.get("nodeId")).toBe("node-2");
    expect(requestUrl.searchParams.get("limit")).toBe("20");
    expect(getByLabelText("run loading").textContent).toBe("false");
    expect(getByLabelText("run error").textContent).toBe("");
  });

  it("strict schema に合わない API 応答を表示へ渡さない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          schemaVersion: "1",
          taskId: "stanah/gh-gantt#330",
          runs: { total: 0, limit: 20, truncated: false, items: [] },
          selectedRun: null,
          unexpected: "field",
        }),
      }),
    );

    const { getByLabelText } = render(<FetchProbe />);
    await waitFor(() => expect(getByLabelText("run error").textContent).not.toBe(""));

    expect(getByLabelText("run data").textContent).toBe("");
  });
});
