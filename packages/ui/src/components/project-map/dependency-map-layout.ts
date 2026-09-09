import dagre from "@dagrejs/dagre";
import type { DependencySubgraph } from "@gh-gantt/shared";

/** Dependency Map ノードの固定幅 (px)。 */
export const NODE_WIDTH = 220;
/** Dependency Map ノードの固定高さ (px)。 */
export const NODE_HEIGHT = 44;

/** レイアウト済みノード。`x` / `y` は左上座標。 */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** レイアウト済みエッジ。`points` は from の右辺から to の左辺へ至る経路。 */
export interface LayoutEdge {
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

/** dagre が返す Dependency Map の座標一式。 */
export interface DependencyMapLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /**
   * 親子エッジ (`from` が親)。dagre には渡さず、配置確定後にノード境界同士を直結した経路を持つ。
   * 段付けに影響させないため、依存エッジとは別に扱う。
   */
  parentEdges: LayoutEdge[];
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

/** 段の方向。`LR` が本番の設定で、`TB` は比較・検証用に残している。 */
export type RankDirection = "LR" | "TB";

/** dagre の段割り当てアルゴリズム。 */
export type DagreRanker = "network-simplex" | "tight-tree" | "longest-path";

/** レイアウトの調整項目。省略時は本番設定 (LR / network-simplex / 連結成分の分割あり)。 */
export interface LayoutOptions {
  rankdir?: RankDirection;
  ranker?: DagreRanker;
  /**
   * 互いに依存で繋がっていない連結成分を個別に配置するか。
   * true なら成分ごとに dagre を実行し、大きい成分から順に行単位で敷き詰める。
   */
  splitComponents?: boolean;
}

/** 同じ段に並ぶノード同士の間隔 (px)。 */
const NODE_SEP = 16;
/** 段同士の間隔 (px)。 */
const RANK_SEP = 48;
const MARGIN = 12;
/** 連結成分同士の間隔 (px)。成分の境界が分かるよう段間隔より広く取る。 */
const COMPONENT_GAP = 56;

/**
 * 実データ (gh-gantt 自身、201 タスク / 依存 38 件) で ranker を比較し、交差数と縦横比が最良だった
 * network-simplex を採用している。比較結果は docs/project-map.md 9.1 節を参照。
 */
export const DEFAULT_RANKER: DagreRanker = "network-simplex";

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  rankdir: "LR",
  ranker: DEFAULT_RANKER,
  splitComponents: true,
};

/**
 * 依存サブグラフを dagre で階層配置する。既定は `rankdir: LR` で、
 * エッジは `from` が `to` をブロックする向きなので上流 (ブロッカー) が左・下流が右に並び、
 * 同じ段のノードは縦に積まれる。互いに繋がっていない連結成分は個別にレイアウトし、
 * 大きい成分から順に縦に積んで左端を揃える (横軸の意味を保つため横には並べない)。
 * サブグラフに存在しないノードを参照するエッジと自己ループは無視する。
 * 親子エッジ (`graph.parentEdges`) は段付けに使わず、配置確定後にノード境界同士を直結する。
 */
export function layoutDependencyGraph(
  graph: DependencySubgraph,
  options: LayoutOptions = {},
): DependencyMapLayout {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ids = new Set(graph.nodes.map((n) => n.task.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  if (ids.size === 0) return { nodes: [], edges: [], parentEdges: [], width: 0, height: 0 };

  // 連結成分ごとに独立した dagre グラフを組み、成分を縦に積む。
  // 全依存モードでは無関係な成分が多数あるため、1 つのグラフに渡すと巨大な単一段に潰れてしまう
  const components = opts.splitComponents
    ? connectedComponents([...ids], edges)
    : [[...ids].sort()];

  const placed = stackComponents(
    components.map((component) => {
      const member = new Set(component);
      const componentEdges = edges.filter((e) => member.has(e.from) && member.has(e.to));
      return layoutComponent(component, componentEdges, opts);
    }),
  );
  const nodes: LayoutNode[] = [];
  const layoutEdges: LayoutEdge[] = [];
  for (const { layout, dx, dy } of placed) {
    for (const n of layout.nodes) nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
    for (const e of layout.edges) {
      layoutEdges.push({ ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
    }
  }

  // 入力順を保って返す (React Flow のノード配列順を安定させる)
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const orderedNodes = graph.nodes.map((n) => nodeById.get(n.task.id)!);

  // 親子エッジは配置後の座標からノード境界同士を直結する (dagre の段付けには関与しない)
  const parentEdges: LayoutEdge[] = [];
  for (const e of graph.parentEdges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to || e.from === e.to) continue;
    const { start, end } = parentEdgeAnchors(from, to);
    parentEdges.push({ from: e.from, to: e.to, points: [start, end] });
  }

  let maxX = 0;
  let maxY = 0;
  for (const n of orderedNodes) {
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
    nodes: orderedNodes,
    edges: layoutEdges,
    parentEdges,
    width: maxX + MARGIN,
    height: maxY + MARGIN,
  };
}

/**
 * 無向の連結成分に分ける。成分はノード数の多い順 (同数なら先頭 id 順) に並べ、
 * 大きな成分が先頭 (左上) に来るようにする。
 */
function connectedComponents(
  ids: string[],
  edges: readonly { from: string; to: string }[],
): string[][] {
  const g = new dagre.graphlib.Graph({ directed: false });
  for (const id of ids) g.setNode(id);
  for (const e of edges) g.setEdge(e.from, e.to);
  const components = dagre.graphlib.alg.components(g).map((c) => [...c].sort());
  components.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return components;
}

/**
 * 連結成分を縦に一列に積み、左端 (最上流の段) を揃える。
 * LR 配置では横軸が「左 = 上流、右 = 下流」の意味を持つため、無関係な成分を右隣に並べると
 * 左の成分の下流に続いているように読めてしまう。縦長になる分はパン・ズームと初期ビューポートで吸収する。
 */
function stackComponents(
  layouts: readonly DependencyMapLayout[],
): { layout: DependencyMapLayout; dx: number; dy: number }[] {
  const placed: { layout: DependencyMapLayout; dx: number; dy: number }[] = [];
  let y = 0;
  for (const layout of layouts) {
    placed.push({ layout, dx: 0, dy: y });
    y += layout.height + COMPONENT_GAP;
  }
  return placed;
}

/** 1 つの連結成分を dagre で配置し、原点基準の座標で返す。 */
function layoutComponent(
  ids: readonly string[],
  edges: readonly { from: string; to: string }[],
  opts: Required<LayoutOptions>,
): DependencyMapLayout {
  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({
    rankdir: opts.rankdir,
    ranker: opts.ranker,
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) g.setEdge(edge.from, edge.to);
  dagre.layout(g);

  // dagre はノード中心座標を返すので左上座標へ変換する
  const nodes: LayoutNode[] = ids.map((id) => {
    const p = g.node(id);
    return {
      id,
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
    const { start, end } = edgeAnchors(from, to, opts.rankdir);
    const points = [start, ...raw.slice(1, -1), end];
    return { from: edge.from, to: edge.to, points };
  });

  let width = 0;
  let height = 0;
  for (const n of nodes) {
    width = Math.max(width, n.x + n.width);
    height = Math.max(height, n.y + n.height);
  }
  for (const e of layoutEdges) {
    for (const p of e.points) {
      width = Math.max(width, p.x);
      height = Math.max(height, p.y);
    }
  }
  return { nodes, edges: layoutEdges, parentEdges: [], width, height };
}

type Point = { x: number; y: number };

/**
 * エッジの始点 / 終点をノード境界に固定する。LR では from の右辺中央から to の左辺中央へ、
 * TB では from の下辺中央から to の上辺中央へ結ぶ。
 * 循環で to が from より上流側に置かれた逆向きエッジは反対側の辺 (LR なら from の左辺 → to の右辺)
 * から出し、ノード本体を貫通させない。
 */
function edgeAnchors(
  from: LayoutNode,
  to: LayoutNode,
  rankdir: RankDirection,
): { start: Point; end: Point } {
  if (rankdir === "LR") {
    const backward = to.x + to.width <= from.x;
    return backward
      ? {
          start: { x: from.x, y: from.y + from.height / 2 },
          end: { x: to.x + to.width, y: to.y + to.height / 2 },
        }
      : {
          start: { x: from.x + from.width, y: from.y + from.height / 2 },
          end: { x: to.x, y: to.y + to.height / 2 },
        };
  }
  const backward = to.y + to.height <= from.y;
  return backward
    ? {
        start: { x: from.x + from.width / 2, y: from.y },
        end: { x: to.x + to.width / 2, y: to.y + to.height },
      }
    : {
        start: { x: from.x + from.width / 2, y: from.y + from.height },
        end: { x: to.x + to.width / 2, y: to.y },
      };
}

/**
 * 親子エッジの始点 / 終点。中心同士のずれが横方向に大きければ左右の辺、
 * そうでなければ上下の辺の中央同士を結び、ノード本体を貫通させない。
 */
function parentEdgeAnchors(from: LayoutNode, to: LayoutNode): { start: Point; end: Point } {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0
      ? { start: { x: from.x + from.width, y: fromCy }, end: { x: to.x, y: toCy } }
      : { start: { x: from.x, y: fromCy }, end: { x: to.x + to.width, y: toCy } };
  }
  return dy >= 0
    ? { start: { x: fromCx, y: from.y + from.height }, end: { x: toCx, y: to.y } }
    : { start: { x: fromCx, y: from.y }, end: { x: toCx, y: to.y + to.height } };
}

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
 * エッジを from / to のノード境界中央を結ぶ直線とみなし、直線同士の交差数を数える。
 * LR では from の右辺中央 → to の左辺中央、TB では from の下辺中央 → to の上辺中央を結ぶ。
 * レイアウト方式の比較指標として使う (端点を共有する辺同士は交差と数えない)。
 * 実際の描画は dagre の折れ線経路なので、この指標は見た目の交差数と一致するとは限らない。
 */
export function countEdgeCrossings(
  nodes: readonly Pick<LayoutNode, "id" | "x" | "y" | "width" | "height">[],
  edges: readonly { from: string; to: string }[],
  rankdir: RankDirection = "LR",
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
      a:
        rankdir === "LR"
          ? { x: from.x + from.width, y: from.y + from.height / 2 }
          : { x: from.x + from.width / 2, y: from.y + from.height },
      b:
        rankdir === "LR"
          ? { x: to.x, y: to.y + to.height / 2 }
          : { x: to.x + to.width / 2, y: to.y },
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
 * 収まらなければ選択タスクを中央に置いて 0.8 倍で表示し、選択がなければ左上 (先頭の成分) を 0.8 倍で表示する。
 * 外接領域の幅と高さの両方を見るため、横向き (LR) でも縦向きでも同じ判定で動く。
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
  // 選択がなければ先頭 (左上) の成分が読める倍率で見えるようにする。
  // 成分は縦積みなので中央を出すと途中の成分しか見えない
  return { x: FIT_PADDING, y: FIT_PADDING, zoom: FOCUS_ZOOM };
}
