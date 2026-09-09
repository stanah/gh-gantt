import { describe, it, expect } from "vitest";
import type { DependencySubgraph, DependencyGraphNode, Task } from "@gh-gantt/shared";
import {
  layoutDependencyGraph,
  countEdgeCrossings,
  computeInitialViewport,
  cubicPoint,
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

const parent = (from: string, to: string) => ({ from, to });

/** テスト用のサブグラフ。省略した辺は空にする。 */
const subgraph = (
  nodes: DependencyGraphNode[],
  init: Partial<Pick<DependencySubgraph, "edges" | "parentEdges" | "isolatedTaskIds">> = {},
): DependencySubgraph => ({
  nodes,
  edges: init.edges ?? [],
  parentEdges: init.parentEdges ?? [],
  isolatedTaskIds: init.isolatedTaskIds ?? [],
});

/** 親 → 子 → 孫 … と 1 本に繋がる親子の鎖。 */
const chain = (n: number): DependencySubgraph => {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  return subgraph(
    ids.map((id) => node(id)),
    { parentEdges: ids.slice(1).map((id, i) => parent(ids[i], id)) },
  );
};

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

/**
 * 親 4 → 子 4 → 孫 4 を配列順と噛み合わない順で結んだ多段・多分岐のツリー (森) に、
 * ブロック辺 2 本を重ねたグラフ。
 */
function branchingGraph(): DependencySubgraph {
  const ups = ["u1", "u2", "u3", "u4"];
  const sels = ["s1", "s2", "s3", "s4"];
  const downs = ["d1", "d2", "d3", "d4"];
  return subgraph(
    [
      ...ups.map((id) => node(id, "upstream", 1)),
      ...sels.map((id) => node(id)),
      ...downs.map((id) => node(id, "downstream", 1)),
    ],
    {
      parentEdges: [
        parent("u1", "s4"),
        parent("u2", "s3"),
        parent("u3", "s2"),
        parent("u4", "s1"),
        parent("s1", "d4"),
        parent("s2", "d3"),
        parent("s3", "d2"),
        parent("s4", "d1"),
      ],
      edges: [edge("u1", "s2"), edge("s2", "d1")],
    },
  );
}

/** 全ての辺 (親子 + ブロック) を交差数の対象にする。 */
const allEdges = (graph: DependencySubgraph) => [...graph.parentEdges, ...graph.edges];

describe("[FR-VIS-027-AC1] 依存サブグラフのノード座標とエッジ経路が dagre の横向き階層レイアウト (親が左、子が右) から得られる", () => {
  it("[Issue #398] 親 → 子 → 孫の順に x 座標が増加し、全ノードに座標が与えられる", () => {
    const graph = subgraph([node("epic"), node("child"), node("grandchild")], {
      parentEdges: [parent("epic", "child"), parent("child", "grandchild")],
    });
    const layout = layoutDependencyGraph(graph);
    const x = Object.fromEntries(layout.nodes.map((n) => [n.id, n.x]));
    expect(layout.nodes).toHaveLength(3);
    expect(x.epic).toBeLessThan(x.child);
    expect(x.child).toBeLessThan(x.grandchild);
    for (const n of layout.nodes) {
      expect(n.width).toBe(NODE_WIDTH);
      expect(n.height).toBe(NODE_HEIGHT);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("[Issue #398] ブロック辺だけで繋がるノードは段付けされず同じ x に縦に積まれ、辺は from の右辺から to の左辺へ至る経路を持つ", () => {
    const graph = subgraph([node("a"), node("b")], { edges: [edge("a", "b")] });
    const layout = layoutDependencyGraph(graph);
    const a = layout.nodes.find((n) => n.id === "a")!;
    const b = layout.nodes.find((n) => n.id === "b")!;
    expect(a.x).toBeCloseTo(b.x, 5);
    expect(layout.edges).toHaveLength(1);
    const [e] = layout.edges;
    expect(e.from).toBe("a");
    expect(e.to).toBe("b");
    expect(e.points.length).toBeGreaterThanOrEqual(2);
    expect(e.points[0].x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    expect(e.points[e.points.length - 1].x).toBeLessThanOrEqual(b.x + 1);
  });

  it("サブグラフに存在しないノードを参照するエッジは無視され、空グラフでも落ちない", () => {
    const graph = subgraph([node("a")], { edges: [edge("a", "ghost")] });
    expect(layoutDependencyGraph(graph).edges).toHaveLength(0);
    const empty = layoutDependencyGraph(subgraph([]));
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
    expect(empty.width).toBe(0);
    expect(empty.height).toBe(0);
  });

  it("[Issue #398] 親子が循環していても座標が得られ、逆向きの親子辺は親の左辺から子の右辺へ結びノードを貫通しない", () => {
    const graph = subgraph([node("a"), node("b")], {
      parentEdges: [parent("a", "b"), parent("b", "a")],
    });
    const layout = layoutDependencyGraph(graph);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.parentEdges).toHaveLength(2);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const e of layout.parentEdges) {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      const first = e.points[0];
      const last = e.points[e.points.length - 1];
      if (to.x < from.x) {
        // 逆向き: 親の左辺 → 子の右辺
        expect(first.x).toBeCloseTo(from.x, 5);
        expect(last.x).toBeCloseTo(to.x + to.width, 5);
      } else {
        expect(first.x).toBeCloseTo(from.x + from.width, 5);
        expect(last.x).toBeCloseTo(to.x, 5);
      }
      // 経路がノード本体の内側 (左辺と右辺の間) を横断しない
      for (const pt of e.points) {
        for (const n of layout.nodes) {
          expect(pt.x > n.x && pt.x < n.x + n.width).toBe(false);
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

  it("[Issue #398] 配列順で交差する 2 段の親子ツリーでは dagre が交差を解消する", () => {
    const graph = subgraph(
      [
        node("a", "upstream", 1),
        node("b", "upstream", 1),
        node("c", "selected", 0),
        node("d", "selected", 0),
      ],
      { parentEdges: [parent("a", "d"), parent("b", "c")] },
    );
    const legacy = countEdgeCrossings(legacyLayout(graph), allEdges(graph), "TB");
    const dagre = countEdgeCrossings(layoutDependencyGraph(graph).nodes, allEdges(graph));
    expect(legacy).toBe(1);
    expect(dagre).toBe(0);
  });

  it("多段・多分岐のグラフでも交差数が段組み配置と同数以下になる", () => {
    const graph = branchingGraph();
    const legacy = countEdgeCrossings(legacyLayout(graph), allEdges(graph), "TB");
    const dagre = countEdgeCrossings(layoutDependencyGraph(graph).nodes, allEdges(graph));
    expect(legacy).toBeGreaterThan(0);
    expect(dagre).toBeLessThanOrEqual(legacy);
  });
});

describe("[FR-VIS-027-AC5] Dependency Map をパン・ズームでき、初期表示で選択タスクが表示領域内に収まる", () => {
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
    // 3 段分 (ノード幅 220 × 3 + 段間隔) が 0.5 倍以上で収まる幅
    const size = { width: 600, height: 300 };
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

  it("[Issue #393] 選択がなく縮小しきれない場合は左上 (先頭の成分) を読める倍率で表示する", () => {
    const layout = layoutDependencyGraph(chain(40));
    const size = { width: 300, height: 200 };
    const vp = computeInitialViewport(layout, null, size);
    expect(vp.zoom).toBeGreaterThanOrEqual(0.5);
    // 最上流 (左端) の先頭ノードが表示領域に収まる
    expect(nodeInView(layout, "n0", vp, size)).toBe(true);
    expect(vp.x).toBeGreaterThanOrEqual(0);
    expect(vp.y).toBeGreaterThanOrEqual(0);
  });
});

describe("[FR-VIS-027-AC7] Dependency Map が横向き (LR) 配置で同じ段のノードを縦に積み、エッジの始点 / 終点が左右の辺になり、初期ビューポートが横向きでも機能する", () => {
  it("[Issue #398] 同じ親を持つ子ノードは同じ x 座標に縦に積まれ、重ならない", () => {
    const graph = subgraph([node("p"), node("c1"), node("c2")], {
      parentEdges: [parent("p", "c1"), parent("p", "c2")],
    });
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const c1 = byId.get("c1")!;
    const c2 = byId.get("c2")!;
    const p = byId.get("p")!;
    expect(c1.x).toBeCloseTo(c2.x, 5);
    expect(p.x + p.width).toBeLessThanOrEqual(c1.x);
    const [upper, lower] = c1.y < c2.y ? [c1, c2] : [c2, c1];
    expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y);
  });

  it("親子辺もブロック辺も、始点は from の右辺中央、終点は to の左辺中央に固定される", () => {
    const layout = layoutDependencyGraph(branchingGraph());
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const e of [...layout.parentEdges, ...layout.edges]) {
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
    const layout = layoutDependencyGraph(chain(30));
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
    expect(countEdgeCrossings(current.nodes, allEdges(graph))).toBeLessThanOrEqual(
      countEdgeCrossings(legacy.nodes, allEdges(graph), "TB"),
    );
    // 横長のノードが 4 つ横に並ぶ TB より、3 段を横に並べる LR の方が横長にならない
    expect(current.width / current.height).toBeLessThan(legacy.width / legacy.height);
  });
});

describe("[FR-VIS-027-AC8] 全依存モードで親子でもブロック関係でも繋がっていない連結成分が個別にレイアウトされ、大きい成分から縦に積まれて左端が揃い、横軸上に別の成分が並ばない", () => {
  it("[Issue #393] 繋がっていない 2 本の鎖は上下に積まれ、左端が揃う", () => {
    const graph = subgraph([node("a"), node("b"), node("c"), node("d"), node("e")], {
      parentEdges: [parent("a", "b"), parent("b", "c"), parent("d", "e")],
    });
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

  it("[Issue #398] ブロック辺で繋がる 2 本のツリーは 1 つの成分として一緒に配置され、成分の間隔で離れない", () => {
    const apart = subgraph([node("p1"), node("c1"), node("p2"), node("c2")], {
      parentEdges: [parent("p1", "c1"), parent("p2", "c2")],
    });
    const linked = subgraph(apart.nodes, {
      parentEdges: apart.parentEdges,
      edges: [edge("c1", "p2")],
    });
    const gapOf = (layout: ReturnType<typeof layoutDependencyGraph>) => {
      const byId = new Map(layout.nodes.map((n) => [n.id, n]));
      const p1 = byId.get("p1")!;
      const p2 = byId.get("p2")!;
      return Math.abs(p2.y - p1.y) - NODE_HEIGHT;
    };
    // 別成分なら成分間隔 (段間隔より広い) で離れ、ブロック辺で繋がれば同じ段の隣接間隔になる
    expect(gapOf(layoutDependencyGraph(apart))).toBeGreaterThanOrEqual(48);
    expect(gapOf(layoutDependencyGraph(linked))).toBeLessThan(48);
    // ブロック辺は段付けに使わないので p1 と p2 は同じ段のまま
    const byId = new Map(layoutDependencyGraph(linked).nodes.map((n) => [n.id, n]));
    expect(byId.get("p1")!.x).toBeCloseTo(byId.get("p2")!.x, 5);
  });

  it("[Issue #393] 孤立ノードが多くても横には並べず、すべて同じ x で縦に積まれる", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const layout = layoutDependencyGraph(subgraph(ids.map((id) => node(id))));
    const xs = new Set(layout.nodes.map((n) => Math.round(n.x)));
    expect(xs.size).toBe(1);
    // 成分同士は段間隔より広い間隔で区切られ、重ならない
    const sorted = [...layout.nodes].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i].y - (sorted[i - 1].y + sorted[i - 1].height);
      expect(gap).toBeGreaterThanOrEqual(48);
    }
  });

  it("[Issue #393] 横に長い成分と短い成分が混在しても、短い成分が長い成分の右隣に置かれない", () => {
    // a-b-c-d-e の長い鎖と、孤立ノード f / g
    const graph = subgraph(
      ["a", "b", "c", "d", "e", "f", "g"].map((id) => node(id)),
      {
        parentEdges: [parent("a", "b"), parent("b", "c"), parent("c", "d"), parent("d", "e")],
      },
    );
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const chainBottom = Math.max(
      ...["a", "b", "c", "d", "e"].map((id) => byId.get(id)!.y + NODE_HEIGHT),
    );
    for (const id of ["f", "g"]) {
      const n = byId.get(id)!;
      expect(n.x).toBeCloseTo(byId.get("a")!.x, 5);
      expect(n.y).toBeGreaterThanOrEqual(chainBottom);
    }
    expect(byId.get("g")!.y).toBeGreaterThan(byId.get("f")!.y);
  });

  it("成分間のエッジ経路も成分のオフセット分だけ平行移動され、ノード境界に一致する", () => {
    const graph = subgraph([node("a"), node("b"), node("c"), node("d")], {
      parentEdges: [parent("a", "b")],
      edges: [edge("c", "d")],
    });
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const e of [...layout.parentEdges, ...layout.edges]) {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      expect(e.points[0].x).toBeCloseTo(from.x + from.width, 5);
      expect(e.points[e.points.length - 1].x).toBeCloseTo(to.x, 5);
    }
    expect(layout.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("[FR-VIS-027-AC13] 親子辺が Dependency Map の段付けの骨格になり、ブロック辺は段付けに使わず配置確定後にノード境界同士を 3 次ベジェで結ぶ", () => {
  it("[Issue #398] ブロック辺を加えてもノード座標と親子辺は親子辺だけの場合と同じになる", () => {
    // up と child は兄弟。ブロック辺 up → child は同じ成分の中に閉じるので、成分の分割にも段付けにも影響しない
    const withoutBlocks = subgraph([node("epic"), node("up"), node("child")], {
      parentEdges: [parent("epic", "up"), parent("epic", "child")],
    });
    const withBlocks = subgraph(withoutBlocks.nodes, {
      parentEdges: withoutBlocks.parentEdges,
      edges: [edge("up", "child")],
    });
    const a = layoutDependencyGraph(withoutBlocks);
    const b = layoutDependencyGraph(withBlocks);
    expect(b.nodes).toEqual(a.nodes);
    expect(b.parentEdges).toEqual(a.parentEdges);
    expect(a.edges).toEqual([]);
    expect(b.edges).toHaveLength(1);
  });

  it("[Issue #398] 親子辺の経路は親の右辺中央と子の左辺中央を結ぶ 2 点の直線になる", () => {
    const graph = subgraph([node("epic"), node("up"), node("child")], {
      parentEdges: [parent("epic", "child")],
      edges: [edge("up", "child")],
    });
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const epic = byId.get("epic")!;
    const child = byId.get("child")!;
    expect(layout.parentEdges).toHaveLength(1);
    const [pe] = layout.parentEdges;
    expect(pe.shape).toBe("polyline");
    expect(pe.points).toEqual([
      { x: epic.x + epic.width, y: epic.y + epic.height / 2 },
      { x: child.x, y: child.y + child.height / 2 },
    ]);
  });

  it("[Issue #398] ブロック辺は from の右辺中央から to の左辺中央へ至る 4 点の 3 次ベジェで、制御点は始点の右・終点の左に置かれる", () => {
    const graph = subgraph([node("p"), node("c"), node("q")], {
      parentEdges: [parent("p", "c")],
      edges: [edge("q", "c")],
    });
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const q = byId.get("q")!;
    const c = byId.get("c")!;
    const [e] = layout.edges;
    expect(e.shape).toBe("cubic");
    expect(e.points).toHaveLength(4);
    const [start, c1, c2, end] = e.points;
    expect(start).toEqual({ x: q.x + q.width, y: q.y + q.height / 2 });
    expect(end).toEqual({ x: c.x, y: c.y + c.height / 2 });
    expect(c1.x).toBeGreaterThan(start.x);
    expect(c1.y).toBe(start.y);
    expect(c2.x).toBeLessThan(end.x);
    expect(c2.y).toBe(end.y);
    // 中点は始点と終点の間にある
    const mid = cubicPoint(e.points, 0.5);
    expect(mid.x).toBeGreaterThan(start.x);
    expect(mid.x).toBeLessThan(end.x);
    expect(cubicPoint(e.points, 0)).toEqual(start);
    expect(cubicPoint(e.points, 1)).toEqual(end);
  });

  it("[Issue #398] to が from より左にある逆向き (同じ段の兄弟や循環) のブロック辺も同じ規則で結ばれ、座標が破綻しない", () => {
    const graph = subgraph([node("p"), node("c1"), node("c2")], {
      parentEdges: [parent("p", "c1"), parent("p", "c2")],
      // 兄弟間 (同じ段) と、子から親へ戻る逆向きのブロック辺
      edges: [edge("c1", "c2"), edge("c2", "p")],
    });
    const layout = layoutDependencyGraph(graph);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(layout.edges).toHaveLength(2);
    for (const e of layout.edges) {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      const [start, c1, c2, end] = e.points;
      expect(start).toEqual({ x: from.x + from.width, y: from.y + from.height / 2 });
      expect(end).toEqual({ x: to.x, y: to.y + to.height / 2 });
      // 始点から右へ出て、終点へ左から入る (制御点がノードの外側にある)
      expect(c1.x).toBeGreaterThanOrEqual(start.x + 40);
      expect(c2.x).toBeLessThanOrEqual(end.x - 40);
      for (const p of e.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
    // 逆向きの辺があっても外接領域は全経路点を含む
    for (const e of layout.edges) {
      for (const p of e.points) {
        expect(p.x).toBeLessThanOrEqual(layout.width);
        expect(p.y).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it("サブグラフに無いノードを指す親子エッジと自己ループは無視する", () => {
    const graph = subgraph([node("a"), node("b")], {
      parentEdges: [parent("ghost", "a"), parent("a", "a")],
      edges: [edge("a", "b")],
    });
    expect(layoutDependencyGraph(graph).parentEdges).toEqual([]);
  });
});
