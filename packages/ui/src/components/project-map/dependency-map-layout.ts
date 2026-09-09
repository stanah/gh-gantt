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

/** エッジ経路の形。`polyline` は頂点を結ぶ折れ線、`cubic` は 3 次ベジェ (始点 / 制御点 2 つ / 終点)。 */
export type LayoutEdgeShape = "polyline" | "cubic";

/** レイアウト済みエッジ。`points` は from のノード境界から to のノード境界へ至る経路。 */
export interface LayoutEdge {
  from: string;
  to: string;
  /** `shape` が polyline なら折れ線の頂点、cubic なら [始点, 制御点 1, 制御点 2, 終点] の 4 点。 */
  points: { x: number; y: number }[];
  shape: LayoutEdgeShape;
}

/** dagre が返す Dependency Map の座標一式。 */
export interface DependencyMapLayout {
  nodes: LayoutNode[];
  /**
   * ブロック関係のエッジ (`from` が `to` をブロックする)。dagre の段付けには使わず、
   * 配置確定後に from の右辺中央から to の左辺中央へ 3 次ベジェで結ぶ。
   */
  edges: LayoutEdge[];
  /**
   * 親子エッジ (`from` が親)。段付けの骨格で、親の右辺中央と子の左辺中央を直線で結ぶ。
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
   * 親子でもブロック関係でも繋がっていない連結成分を個別に配置するか。
   * true なら成分ごとに dagre を実行し、大きい成分から順に縦に積む。
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
/** ブロック辺のベジェ制御点をノード境界から水平に離す最小距離 (px)。 */
const MIN_BEND = 40;

/**
 * 実データ (gh-gantt 自身) で ranker を比較し、交差数と縦横比が最良だった
 * network-simplex を採用している。比較結果は docs/project-map.md 9.1 節を参照。
 */
export const DEFAULT_RANKER: DagreRanker = "network-simplex";

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  rankdir: "LR",
  ranker: DEFAULT_RANKER,
  splitComponents: true,
};

/**
 * 依存サブグラフを dagre で階層配置する。骨格は親子ツリーで、`rankdir: LR` により親が左・子が右に並び、
 * 同じ段のノードは縦に積まれる。ブロック関係 (`graph.edges`) は dagre に渡さず、配置確定後に
 * from の右辺中央から to の左辺中央へ 3 次ベジェで結んで重ねる。
 * 親子でもブロック関係でも繋がっていない連結成分は個別にレイアウトし、
 * 大きい成分から順に縦に積んで左端を揃える (横軸の意味を保つため横には並べない)。
 * サブグラフに存在しないノードを参照する辺と自己ループは無視する。
 */
export function layoutDependencyGraph(
  graph: DependencySubgraph,
  options: LayoutOptions = {},
): DependencyMapLayout {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ids = new Set(graph.nodes.map((n) => n.task.id));
  const valid = <E extends { from: string; to: string }>(list: readonly E[]) =>
    list.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const parentEdges = valid(graph.parentEdges);
  const blockEdges = valid(graph.edges);
  if (ids.size === 0) return { nodes: [], edges: [], parentEdges: [], width: 0, height: 0 };

  // 連結成分ごとに独立した dagre グラフを組み、成分を縦に積む。
  // 全依存モードでは無関係な成分が多数あるため、1 つのグラフに渡すと巨大な単一段に潰れてしまう。
  // 成分の判定には親子とブロックの両方を使い、ブロックで繋がるツリー同士が離れないようにする
  const components = opts.splitComponents
    ? connectedComponents([...ids], [...parentEdges, ...blockEdges])
    : [[...ids].sort()];

  const placed = stackComponents(
    components.map((component) => {
      const member = new Set(component);
      return layoutComponent(
        component,
        parentEdges.filter((e) => member.has(e.from) && member.has(e.to)),
        opts,
      );
    }),
  );
  const nodes: LayoutNode[] = [];
  const layoutParentEdges: LayoutEdge[] = [];
  for (const { layout, dx, dy } of placed) {
    for (const n of layout.nodes) nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
    for (const e of layout.parentEdges) {
      layoutParentEdges.push({
        ...e,
        points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      });
    }
  }

  // 入力順を保って返す (React Flow のノード配列順を安定させる)
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const orderedNodes = graph.nodes.map((n) => nodeById.get(n.task.id)!);

  // ブロック辺は配置後の座標からノード境界同士をベジェで結ぶ (dagre の段付けには関与しない)
  const layoutEdges: LayoutEdge[] = blockEdges.map((e) => ({
    from: e.from,
    to: e.to,
    shape: "cubic",
    points: blockEdgePath(nodeById.get(e.from)!, nodeById.get(e.to)!, opts.rankdir),
  }));

  let maxX = 0;
  let maxY = 0;
  for (const n of orderedNodes) {
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  for (const e of [...layoutEdges, ...layoutParentEdges]) {
    for (const p of e.points) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }

  return {
    nodes: orderedNodes,
    edges: layoutEdges,
    parentEdges: layoutParentEdges,
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

/**
 * 1 つの連結成分を親子エッジだけで dagre に段付けし、原点基準の座標で返す。
 * 親子エッジは 1 段しか跨がないため、dagre の経路点は使わず親の右辺中央と子の左辺中央を直線で結ぶ。
 */
function layoutComponent(
  ids: readonly string[],
  parentEdges: readonly { from: string; to: string }[],
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
  for (const edge of parentEdges) g.setEdge(edge.from, edge.to);
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
  const layoutParentEdges: LayoutEdge[] = parentEdges.map((edge) => {
    const { start, end } = edgeAnchors(
      nodeById.get(edge.from)!,
      nodeById.get(edge.to)!,
      opts.rankdir,
    );
    return { from: edge.from, to: edge.to, shape: "polyline", points: [start, end] };
  });

  let width = 0;
  let height = 0;
  for (const n of nodes) {
    width = Math.max(width, n.x + n.width);
    height = Math.max(height, n.y + n.height);
  }
  return { nodes, edges: [], parentEdges: layoutParentEdges, width, height };
}

type Point = { x: number; y: number };

/**
 * 親子エッジの始点 / 終点をノード境界に固定する。LR では親の右辺中央から子の左辺中央へ、
 * TB では親の下辺中央から子の上辺中央へ結ぶ。
 * 親子の循環で子が親より上流側に置かれた逆向きエッジは反対側の辺 (LR なら親の左辺 → 子の右辺)
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
 * ブロック辺の 3 次ベジェ経路 [始点, 制御点 1, 制御点 2, 終点] を返す。
 * LR では常に from の右辺中央から出て to の左辺中央へ入り、制御点は始点の右・終点の左に
 * 水平距離 (両端の x 差の半分、最低 {@link MIN_BEND}) だけ離して置く。
 * to が from より左にある逆向きの辺 (同じ段の兄弟や循環) でも同じ規則で、始点から右へ出て
 * 大きく回り込み終点へ左から入る S 字になるため、向きが読めて経路が破綻しない。
 * TB では下辺中央 → 上辺中央に読み替える。
 */
function blockEdgePath(from: LayoutNode, to: LayoutNode, rankdir: RankDirection): Point[] {
  if (rankdir === "LR") {
    const start = { x: from.x + from.width, y: from.y + from.height / 2 };
    const end = { x: to.x, y: to.y + to.height / 2 };
    const bend = Math.max(Math.abs(end.x - start.x) / 2, MIN_BEND);
    return [start, { x: start.x + bend, y: start.y }, { x: end.x - bend, y: end.y }, end];
  }
  const start = { x: from.x + from.width / 2, y: from.y + from.height };
  const end = { x: to.x + to.width / 2, y: to.y };
  const bend = Math.max(Math.abs(end.y - start.y) / 2, MIN_BEND);
  return [start, { x: start.x, y: start.y + bend }, { x: end.x, y: end.y - bend }, end];
}

/** 3 次ベジェ上の媒介変数 t の点。ラベル位置 (t = 0.5) の算出に使う。 */
export function cubicPoint(points: readonly Point[], t: number): Point {
  const [p0, p1, p2, p3] = points;
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
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
