import { describe, it, expect } from "vitest";
import type { DependencySubgraph, DependencyGraphNode, Task } from "@gh-gantt/shared";
import {
  layoutDependencyGraph,
  countEdgeCrossings,
  computeInitialViewport,
  NODE_WIDTH,
  NODE_HEIGHT,
} from "../components/project-map/dependency-map-layout.js";

const task = (id: string): Task => ({
  id,
  type: "task",
  github_issue: 1,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: id,
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
});

const node = (
  id: string,
  direction: DependencyGraphNode["direction"] = "selected",
  depth = 0,
): DependencyGraphNode => ({ task: task(id), direction, depth });

const edge = (from: string, to: string) => ({ from, to, isCritical: false, isUnresolved: false });

/**
 * 移行前の段組み等間隔配置。direction / depth で段を決め、各段で配列順に等間隔に並べる。
 * 交差数比較 (AC2) の基準としてテスト内に保持する。
 */
function legacyLayout(graph: DependencySubgraph) {
  const rankOf = (n: DependencyGraphNode) =>
    n.direction === "upstream" ? -n.depth : n.direction === "downstream" ? n.depth : 0;
  const byRank = new Map<number, DependencyGraphNode[]>();
  for (const n of graph.nodes) {
    const list = byRank.get(rankOf(n));
    if (list) list.push(n);
    else byRank.set(rankOf(n), [n]);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const nodes: { id: string; x: number; y: number; width: number; height: number }[] = [];
  ranks.forEach((rank, row) => {
    byRank.get(rank)!.forEach((n, col) => {
      nodes.push({
        id: n.task.id,
        x: col * (NODE_WIDTH + 16),
        y: row * (NODE_HEIGHT + 34),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  });
  return nodes;
}

describe("[FR-VIS-027-AC1] 依存サブグラフのノード座標とエッジ経路が dagre の階層レイアウト (上流が上、下流が下) から得られる", () => {
  it("上流 → 選択 → 下流の順に y 座標が増加し、全ノードに座標が与えられる", () => {
    const graph: DependencySubgraph = {
      nodes: [node("sel"), node("up", "upstream", 1), node("down", "downstream", 1)],
      edges: [edge("up", "sel"), edge("sel", "down")],
    };
    const layout = layoutDependencyGraph(graph);
    const y = Object.fromEntries(layout.nodes.map((n) => [n.id, n.y]));
    expect(layout.nodes).toHaveLength(3);
    expect(y.up).toBeLessThan(y.sel);
    expect(y.sel).toBeLessThan(y.down);
    for (const n of layout.nodes) {
      expect(n.width).toBe(NODE_WIDTH);
      expect(n.height).toBe(NODE_HEIGHT);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("エッジは from の下辺付近から to の上辺付近へ至る 2 点以上の経路を持つ", () => {
    const graph: DependencySubgraph = {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    };
    const layout = layoutDependencyGraph(graph);
    expect(layout.edges).toHaveLength(1);
    const [e] = layout.edges;
    const a = layout.nodes.find((n) => n.id === "a")!;
    const b = layout.nodes.find((n) => n.id === "b")!;
    expect(e.from).toBe("a");
    expect(e.to).toBe("b");
    expect(e.points.length).toBeGreaterThanOrEqual(2);
    const first = e.points[0];
    const last = e.points[e.points.length - 1];
    expect(first.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
    expect(last.y).toBeLessThanOrEqual(b.y + 1);
  });

  it("サブグラフに存在しないノードを参照するエッジは無視され、空グラフでも落ちない", () => {
    const graph: DependencySubgraph = {
      nodes: [node("a")],
      edges: [edge("a", "ghost")],
    };
    expect(layoutDependencyGraph(graph).edges).toHaveLength(0);
    const empty = layoutDependencyGraph({ nodes: [], edges: [] });
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
  });

  it("循環を含むグラフでも座標が得られ、逆向きエッジは from の上辺から to の下辺へ結びノードを貫通しない", () => {
    const graph: DependencySubgraph = {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    const layout = layoutDependencyGraph(graph);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const e of layout.edges) {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      const first = e.points[0];
      const last = e.points[e.points.length - 1];
      if (to.y < from.y) {
        // 逆向き: from の上辺 → to の下辺
        expect(first.y).toBeCloseTo(from.y, 5);
        expect(last.y).toBeCloseTo(to.y + to.height, 5);
      } else {
        expect(first.y).toBeCloseTo(from.y + from.height, 5);
        expect(last.y).toBeCloseTo(to.y, 5);
      }
      // 経路がノード本体の内側 (上辺と下辺の間) を縦断しない
      for (const pt of e.points) {
        for (const n of layout.nodes) {
          const inside = pt.y > n.y && pt.y < n.y + n.height;
          expect(inside).toBe(false);
        }
      }
    }
  });
});

describe("[FR-VIS-027-AC2] 同一の依存サブグラフに対するエッジ交差数が段組み等間隔配置と同数以下になる", () => {
  it("countEdgeCrossings は交差する 2 本のエッジを 1 と数え、平行なエッジを 0 と数える", () => {
    const nodes = [
      { id: "a", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", x: 100, y: 0, width: 10, height: 10 },
      { id: "c", x: 0, y: 100, width: 10, height: 10 },
      { id: "d", x: 100, y: 100, width: 10, height: 10 },
    ];
    expect(
      countEdgeCrossings(nodes, [
        { from: "a", to: "d" },
        { from: "b", to: "c" },
      ]),
    ).toBe(1);
    expect(
      countEdgeCrossings(nodes, [
        { from: "a", to: "c" },
        { from: "b", to: "d" },
      ]),
    ).toBe(0);
  });

  it("配列順で交差する 2 段グラフでは dagre が交差を解消する", () => {
    const graph: DependencySubgraph = {
      nodes: [
        node("a", "upstream", 1),
        node("b", "upstream", 1),
        node("c", "selected", 0),
        node("d", "selected", 0),
      ],
      edges: [edge("a", "d"), edge("b", "c")],
    };
    const legacy = countEdgeCrossings(legacyLayout(graph), graph.edges);
    const dagre = countEdgeCrossings(layoutDependencyGraph(graph).nodes, graph.edges);
    expect(legacy).toBe(1);
    expect(dagre).toBe(0);
  });

  it("多段・多分岐のグラフでも交差数が段組み配置と同数以下になる", () => {
    // 3 段: 上流 4 → 選択 4 → 下流 4 を、配列順と噛み合わない順で結ぶ
    const ups = ["u1", "u2", "u3", "u4"];
    const sels = ["s1", "s2", "s3", "s4"];
    const downs = ["d1", "d2", "d3", "d4"];
    const graph: DependencySubgraph = {
      nodes: [
        ...ups.map((id) => node(id, "upstream", 1)),
        ...sels.map((id) => node(id)),
        ...downs.map((id) => node(id, "downstream", 1)),
      ],
      edges: [
        edge("u1", "s4"),
        edge("u2", "s3"),
        edge("u3", "s2"),
        edge("u4", "s1"),
        edge("u1", "s2"),
        edge("s1", "d4"),
        edge("s2", "d3"),
        edge("s3", "d2"),
        edge("s4", "d1"),
        edge("s2", "d1"),
      ],
    };
    const legacy = countEdgeCrossings(legacyLayout(graph), graph.edges);
    const dagre = countEdgeCrossings(layoutDependencyGraph(graph).nodes, graph.edges);
    expect(legacy).toBeGreaterThan(0);
    expect(dagre).toBeLessThanOrEqual(legacy);
  });
});

describe("[FR-VIS-027-AC5] Dependency Map をパン・ズームでき、初期表示で選択タスクが表示領域内に収まる", () => {
  const chain = (n: number): DependencySubgraph => {
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    return {
      nodes: ids.map((id) => node(id)),
      edges: ids.slice(1).map((id, i) => edge(ids[i], id)),
    };
  };

  const nodeInView = (
    layout: ReturnType<typeof layoutDependencyGraph>,
    id: string,
    vp: { x: number; y: number; zoom: number },
    size: { width: number; height: number },
  ) => {
    const n = layout.nodes.find((x) => x.id === id)!;
    const left = n.x * vp.zoom + vp.x;
    const top = n.y * vp.zoom + vp.y;
    const right = (n.x + n.width) * vp.zoom + vp.x;
    const bottom = (n.y + n.height) * vp.zoom + vp.y;
    return left >= 0 && top >= 0 && right <= size.width && bottom <= size.height;
  };

  it("小さなグラフでは全ノードが表示領域に収まり、拡大率は 1 を超えない", () => {
    const layout = layoutDependencyGraph(chain(3));
    const size = { width: 400, height: 300 };
    const vp = computeInitialViewport(layout, "n1", size);
    expect(vp.zoom).toBeLessThanOrEqual(1);
    for (const n of layout.nodes) expect(nodeInView(layout, n.id, vp, size)).toBe(true);
  });

  it("縮小しきれない大きなグラフでは選択タスクを中心に読める倍率で表示する", () => {
    const layout = layoutDependencyGraph(chain(40));
    const size = { width: 300, height: 200 };
    const vp = computeInitialViewport(layout, "n30", size);
    expect(vp.zoom).toBeGreaterThanOrEqual(0.5);
    expect(nodeInView(layout, "n30", vp, size)).toBe(true);
  });

  it("選択がなければグラフ全体の中心を表示する", () => {
    const layout = layoutDependencyGraph(chain(40));
    const size = { width: 300, height: 200 };
    const vp = computeInitialViewport(layout, null, size);
    const centerX = (layout.width / 2) * vp.zoom + vp.x;
    const centerY = (layout.height / 2) * vp.zoom + vp.y;
    expect(centerX).toBeCloseTo(size.width / 2, 5);
    expect(centerY).toBeCloseTo(size.height / 2, 5);
  });
});
