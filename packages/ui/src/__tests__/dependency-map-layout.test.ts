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

const edge = (from: string, to: string) => ({
  from,
  to,
  isCritical: false,
  isUnresolved: false,
  type: "finish-to-start" as const,
  lag: 0,
});

/**
 * 移行前の段組み等間隔配置 (縦向き)。direction / depth で段を決め、各段で配列順に等間隔に並べる。
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

/** 上流 4 → 選択 4 → 下流 4 を配列順と噛み合わない順で結んだ多段・多分岐グラフ。 */
function branchingGraph(): DependencySubgraph {
  const ups = ["u1", "u2", "u3", "u4"];
  const sels = ["s1", "s2", "s3", "s4"];
  const downs = ["d1", "d2", "d3", "d4"];
  return {
    parentEdges: [],
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
}

describe("[FR-VIS-027-AC1] 依存サブグラフのノード座標とエッジ経路が dagre の横向き階層レイアウト (上流が左、下流が右) から得られる", () => {
  it("上流 → 選択 → 下流の順に x 座標が増加し、全ノードに座標が与えられる", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: [node("sel"), node("up", "upstream", 1), node("down", "downstream", 1)],
      edges: [edge("up", "sel"), edge("sel", "down")],
    };
    const layout = layoutDependencyGraph(graph);
    const x = Object.fromEntries(layout.nodes.map((n) => [n.id, n.x]));
    expect(layout.nodes).toHaveLength(3);
    expect(x.up).toBeLessThan(x.sel);
    expect(x.sel).toBeLessThan(x.down);
    for (const n of layout.nodes) {
      expect(n.width).toBe(NODE_WIDTH);
      expect(n.height).toBe(NODE_HEIGHT);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("エッジは from の右辺付近から to の左辺付近へ至る 2 点以上の経路を持つ", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
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
    expect(first.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    expect(last.x).toBeLessThanOrEqual(b.x + 1);
  });

  it("サブグラフに存在しないノードを参照するエッジは無視され、空グラフでも落ちない", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: [node("a")],
      edges: [edge("a", "ghost")],
    };
    expect(layoutDependencyGraph(graph).edges).toHaveLength(0);
    const empty = layoutDependencyGraph({ nodes: [], edges: [], parentEdges: [] });
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
    expect(empty.width).toBe(0);
    expect(empty.height).toBe(0);
  });

  it("循環を含むグラフでも座標が得られ、逆向きエッジは from の左辺から to の右辺へ結びノードを貫通しない", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
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
      if (to.x < from.x) {
        // 逆向き: from の左辺 → to の右辺
        expect(first.x).toBeCloseTo(from.x, 5);
        expect(last.x).toBeCloseTo(to.x + to.width, 5);
      } else {
        expect(first.x).toBeCloseTo(from.x + from.width, 5);
        expect(last.x).toBeCloseTo(to.x, 5);
      }
      // 経路がノード本体の内側 (左辺と右辺の間) を横断しない
      for (const pt of e.points) {
        for (const n of layout.nodes) {
          const inside = pt.x > n.x && pt.x < n.x + n.width;
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
    for (const rankdir of ["LR", "TB"] as const) {
      expect(
        countEdgeCrossings(
          nodes,
          [
            { from: "a", to: "d" },
            { from: "b", to: "c" },
          ],
          rankdir,
        ),
      ).toBe(1);
      expect(
        countEdgeCrossings(
          nodes,
          [
            { from: "a", to: "c" },
            { from: "b", to: "d" },
          ],
          rankdir,
        ),
      ).toBe(0);
    }
  });

  it("配列順で交差する 2 段グラフでは dagre が交差を解消する", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: [
        node("a", "upstream", 1),
        node("b", "upstream", 1),
        node("c", "selected", 0),
        node("d", "selected", 0),
      ],
      edges: [edge("a", "d"), edge("b", "c")],
    };
    const legacy = countEdgeCrossings(legacyLayout(graph), graph.edges, "TB");
    const dagre = countEdgeCrossings(layoutDependencyGraph(graph).nodes, graph.edges);
    expect(legacy).toBe(1);
    expect(dagre).toBe(0);
  });

  it("多段・多分岐のグラフでも交差数が段組み配置と同数以下になる", () => {
    const graph = branchingGraph();
    const legacy = countEdgeCrossings(legacyLayout(graph), graph.edges, "TB");
    const dagre = countEdgeCrossings(layoutDependencyGraph(graph).nodes, graph.edges);
    expect(legacy).toBeGreaterThan(0);
    expect(dagre).toBeLessThanOrEqual(legacy);
  });
});

describe("[FR-VIS-027-AC5] Dependency Map をパン・ズームでき、初期表示で選択タスクが表示領域内に収まる", () => {
  const chain = (n: number): DependencySubgraph => {
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    return {
      parentEdges: [],
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

describe("[FR-VIS-027-AC7] Dependency Map が横向き (LR) 配置で同じ段のノードを縦に積み、エッジの始点 / 終点が左右の辺になり、初期ビューポートが横向きでも機能する", () => {
  it("同じ段の上流ノードは同じ x 座標に縦に積まれ、重ならない", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: [node("sel"), node("u1", "upstream", 1), node("u2", "upstream", 1)],
      edges: [edge("u1", "sel"), edge("u2", "sel")],
    };
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const u1 = byId.get("u1")!;
    const u2 = byId.get("u2")!;
    const sel = byId.get("sel")!;
    expect(u1.x).toBeCloseTo(u2.x, 5);
    expect(u1.x + u1.width).toBeLessThanOrEqual(sel.x);
    const [upper, lower] = u1.y < u2.y ? [u1, u2] : [u2, u1];
    expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y);
  });

  it("エッジの始点は from の右辺中央、終点は to の左辺中央に固定される", () => {
    const layout = layoutDependencyGraph(branchingGraph());
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const e of layout.edges) {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      const first = e.points[0];
      const last = e.points[e.points.length - 1];
      expect(first.x).toBeCloseTo(from.x + from.width, 5);
      expect(first.y).toBeCloseTo(from.y + from.height / 2, 5);
      expect(last.x).toBeCloseTo(to.x, 5);
      expect(last.y).toBeCloseTo(to.y + to.height / 2, 5);
    }
  });

  it("横に長い鎖でも選択タスク中心の初期ビューポートが選択ノードを表示領域内に収める", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: ids.map((id) => node(id)),
      edges: ids.slice(1).map((id, i) => edge(ids[i], id)),
    };
    const layout = layoutDependencyGraph(graph);
    // 鎖は 1 段 1 ノードで横に伸びる
    expect(layout.width).toBeGreaterThan(layout.height);
    const size = { width: 300, height: 200 };
    const vp = computeInitialViewport(layout, "n20", size);
    const n = layout.nodes.find((x) => x.id === "n20")!;
    const left = n.x * vp.zoom + vp.x;
    const right = (n.x + n.width) * vp.zoom + vp.x;
    const top = n.y * vp.zoom + vp.y;
    const bottom = (n.y + n.height) * vp.zoom + vp.y;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(size.width);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(size.height);
  });

  it("横向き配置の交差数と縦横比が移行前の縦向き (TB / 分割なし) 配置より悪化しない", () => {
    const graph = branchingGraph();
    const legacy = layoutDependencyGraph(graph, { rankdir: "TB", splitComponents: false });
    const current = layoutDependencyGraph(graph);
    expect(countEdgeCrossings(current.nodes, graph.edges)).toBeLessThanOrEqual(
      countEdgeCrossings(legacy.nodes, graph.edges, "TB"),
    );
    // 幅 170px のノードが 4 つ横に並ぶ TB より、4 段を横に並べる LR の方が横長にならない
    expect(current.width / current.height).toBeLessThan(legacy.width / legacy.height);
  });
});

describe("[FR-VIS-027-AC8] 全依存モードで互いに依存のない連結成分が個別にレイアウトされ、大きい成分から行単位で敷き詰められて一つの巨大な段に潰れない", () => {
  it("繋がっていない 2 本の鎖は別々の行に配置され、段が混ざらない", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: [node("a"), node("b"), node("c"), node("d"), node("e")],
      edges: [edge("a", "b"), edge("b", "c"), edge("d", "e")],
    };
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const first = ["a", "b", "c"].map((id) => byId.get(id)!);
    const second = ["d", "e"].map((id) => byId.get(id)!);
    // ノード数の多い成分 (a-b-c) が先頭 (上) に来る
    const firstBottom = Math.max(...first.map((n) => n.y + n.height));
    const secondTop = Math.min(...second.map((n) => n.y));
    expect(firstBottom).toBeLessThanOrEqual(secondTop);
    // 各成分は独立した原点から始まる (d は a と同じ x)
    expect(byId.get("d")!.x).toBeCloseTo(byId.get("a")!.x, 5);
    // 分割しなければ d は a と同じ段 (同じ x) の縦並びになる
    const merged = layoutDependencyGraph(graph, { splitComponents: false });
    const mergedById = new Map(merged.nodes.map((n) => [n.id, n]));
    expect(mergedById.get("d")!.x).toBeCloseTo(mergedById.get("a")!.x, 5);
    const mergedA = mergedById.get("a")!;
    const mergedD = mergedById.get("d")!;
    expect(Math.abs(mergedA.y - mergedD.y)).toBeLessThan(NODE_HEIGHT * 2);
  });

  it("孤立ノードが多い場合は複数の行と列に敷き詰められ、一列に潰れない", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: ids.map((id) => node(id)),
      edges: [],
    };
    const layout = layoutDependencyGraph(graph);
    const xs = new Set(layout.nodes.map((n) => Math.round(n.x)));
    const ys = new Set(layout.nodes.map((n) => Math.round(n.y)));
    expect(xs.size).toBeGreaterThan(1);
    expect(ys.size).toBeGreaterThan(1);
    const ratio = layout.width / layout.height;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(3);
    // ノード同士が重ならない
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });

  it("成分間のエッジ経路も成分のオフセット分だけ平行移動され、ノード境界に一致する", () => {
    const graph: DependencySubgraph = {
      parentEdges: [],
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [edge("a", "b"), edge("c", "d")],
    };
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const e of layout.edges) {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      expect(e.points[0].x).toBeCloseTo(from.x + from.width, 5);
      expect(e.points[e.points.length - 1].x).toBeCloseTo(to.x, 5);
    }
    expect(layout.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("[FR-VIS-027-AC13] 親子エッジは Dependency Map のレイアウトの段付けに使わず、配置確定後にノード境界同士を直結する", () => {
  it("親子エッジを加えてもノード座標は依存エッジだけの場合と同じになる", () => {
    const withoutParents: DependencySubgraph = {
      parentEdges: [],
      nodes: [node("epic"), node("up"), node("child")],
      edges: [edge("up", "child")],
    };
    const withParents: DependencySubgraph = {
      ...withoutParents,
      parentEdges: [{ from: "epic", to: "child" }],
    };
    const a = layoutDependencyGraph(withoutParents);
    const b = layoutDependencyGraph(withParents);
    expect(b.nodes).toEqual(a.nodes);
    expect(b.edges).toEqual(a.edges);
    expect(a.parentEdges).toEqual([]);
    expect(b.parentEdges).toHaveLength(1);
  });

  it("親子エッジの経路は親と子のノード境界 (左右または上下の辺の中央) を結ぶ 2 点になる", () => {
    const graph: DependencySubgraph = {
      parentEdges: [{ from: "epic", to: "child" }],
      nodes: [node("epic"), node("up"), node("child")],
      edges: [edge("up", "child")],
    };
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const epic = byId.get("epic")!;
    const child = byId.get("child")!;
    const [start, end] = layout.parentEdges[0].points;
    expect(layout.parentEdges[0].points).toHaveLength(2);
    const onBoundary = (p: { x: number; y: number }, n: typeof epic) =>
      (p.x === n.x || p.x === n.x + n.width) && p.y === n.y + n.height / 2
        ? true
        : (p.y === n.y || p.y === n.y + n.height) && p.x === n.x + n.width / 2;
    expect(onBoundary(start, epic)).toBe(true);
    expect(onBoundary(end, child)).toBe(true);
  });

  it("サブグラフに無いノードを指す親子エッジと自己ループは無視する", () => {
    const graph: DependencySubgraph = {
      parentEdges: [
        { from: "ghost", to: "a" },
        { from: "a", to: "a" },
      ],
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    };
    expect(layoutDependencyGraph(graph).parentEdges).toEqual([]);
  });
});
