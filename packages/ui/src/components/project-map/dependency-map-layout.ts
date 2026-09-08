import dagre from "@dagrejs/dagre";
import type { DependencySubgraph } from "@gh-gantt/shared";

/** Dependency Map ノードの固定幅 (px)。 */
export const NODE_WIDTH = 170;
/** Dependency Map ノードの固定高さ (px)。 */
export const NODE_HEIGHT = 36;

/** レイアウト済みノード。`x` / `y` は左上座標。 */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** レイアウト済みエッジ。`points` は from の下辺から to の上辺へ至る経路。 */
export interface LayoutEdge {
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

/** dagre が返す Dependency Map の座標一式。 */
export interface DependencyMapLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** 全ノードとエッジを含む外接領域の幅。 */
  width: number;
  /** 全ノードとエッジを含む外接領域の高さ。 */
  height: number;
}

/** 表示領域上のビューポート (React Flow の Viewport と同じ意味)。 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const NODE_SEP = 24;
const RANK_SEP = 40;
const MARGIN = 12;

/**
 * 依存サブグラフを dagre (rankdir TB) で階層配置する。
 * エッジは `from` が `to` をブロックする向きなので、上流が上・下流が下に並ぶ。
 * サブグラフに存在しないノードを参照するエッジは無視する。
 */
export function layoutDependencyGraph(graph: DependencySubgraph): DependencyMapLayout {
  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({
    rankdir: "TB",
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    ids.add(node.task.id);
    g.setNode(node.task.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  for (const edge of edges) g.setEdge(edge.from, edge.to);

  if (ids.size > 0) dagre.layout(g);

  // dagre はノード中心座標を返すので左上座標へ変換する
  const nodes: LayoutNode[] = graph.nodes.map((node) => {
    const p = g.node(node.task.id);
    return {
      id: node.task.id,
      x: p.x - NODE_WIDTH / 2,
      y: p.y - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const layoutEdges: LayoutEdge[] = edges.map((edge) => {
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    const raw = g.edge(edge.from, edge.to)?.points ?? [];
    // 経路の始点 / 終点をノード境界に固定する。循環で to が from より上に置かれた逆向きエッジは
    // from の上辺から to の下辺へ結び、ノード本体を貫通させない
    const backward = to.y + to.height <= from.y;
    const start = backward
      ? { x: from.x + from.width / 2, y: from.y }
      : { x: from.x + from.width / 2, y: from.y + from.height };
    const end = backward
      ? { x: to.x + to.width / 2, y: to.y + to.height }
      : { x: to.x + to.width / 2, y: to.y };
    const points = [start, ...raw.slice(1, -1), end];
    return { from: edge.from, to: edge.to, points };
  });

  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  for (const e of layoutEdges) {
    for (const p of e.points) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }

  return {
    nodes,
    edges: layoutEdges,
    width: nodes.length > 0 ? maxX + MARGIN : 0,
    height: nodes.length > 0 ? maxY + MARGIN : 0,
  };
}

type Point = { x: number; y: number };

function orientation(a: Point, b: Point, c: Point): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : -1;
}

/** 線分 p1-p2 と p3-p4 が端点を共有せずに交差するか。 */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/**
 * from の下辺中央から to の上辺中央へ引いた直線同士の交差数を数える。
 * レイアウト方式の比較指標として使う (端点を共有する辺同士は交差と数えない)。
 * 実際の描画は dagre の折れ線経路なので、この指標は見た目の交差数と一致するとは限らない。
 */
export function countEdgeCrossings(
  nodes: readonly Pick<LayoutNode, "id" | "x" | "y" | "width" | "height">[],
  edges: readonly { from: string; to: string }[],
): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const segments: { from: string; to: string; a: Point; b: Point }[] = [];
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    segments.push({
      from: e.from,
      to: e.to,
      a: { x: from.x + from.width / 2, y: from.y + from.height },
      b: { x: to.x + to.width / 2, y: to.y },
    });
  }
  let count = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const s = segments[i];
      const t = segments[j];
      const sharesNode = s.from === t.from || s.from === t.to || s.to === t.from || s.to === t.to;
      if (sharesNode) continue;
      if (segmentsCross(s.a, s.b, t.a, t.b)) count += 1;
    }
  }
  return count;
}

const FIT_PADDING = 16;
/** fit で縮小してもこの倍率を下回るなら、選択タスク中心の表示に切り替える。 */
const MIN_READABLE_ZOOM = 0.5;
/** 選択タスク中心表示の倍率。 */
const FOCUS_ZOOM = 0.8;

/**
 * 初期ビューポートを決める。グラフ全体が読める倍率 (>= 0.5) で収まるなら全体を中央に表示し、
 * 収まらなければ選択タスク (なければグラフ中心) を中央に置いて 0.8 倍で表示する。
 */
export function computeInitialViewport(
  layout: DependencyMapLayout,
  selectedTaskId: string | null,
  size: { width: number; height: number },
): Viewport {
  if (layout.nodes.length === 0 || size.width <= 0 || size.height <= 0) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const availW = Math.max(1, size.width - FIT_PADDING * 2);
  const availH = Math.max(1, size.height - FIT_PADDING * 2);
  const fitZoom = Math.min(1, availW / layout.width, availH / layout.height);

  const centerOn = (cx: number, cy: number, zoom: number): Viewport => ({
    x: size.width / 2 - cx * zoom,
    y: size.height / 2 - cy * zoom,
    zoom,
  });

  if (fitZoom >= MIN_READABLE_ZOOM) {
    return centerOn(layout.width / 2, layout.height / 2, fitZoom);
  }
  const selected = selectedTaskId ? layout.nodes.find((n) => n.id === selectedTaskId) : undefined;
  if (selected) {
    return centerOn(selected.x + selected.width / 2, selected.y + selected.height / 2, FOCUS_ZOOM);
  }
  return centerOn(layout.width / 2, layout.height / 2, FOCUS_ZOOM);
}
