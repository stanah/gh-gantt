---
id: ADR-028
title: Dependency Map の描画を React Flow、レイアウトを dagre に置き換える
date: 2026-09-08
status: accepted
related_requirements:
  - FR-VIS-024
  - FR-VIS-027
---

## Context

Project Map の Dependency Map（#251 で導入）は、上流 / 選択 / 下流の depth を段に割り当て、各段でノードを配列順に等間隔で並べ、中央同士を直線で結ぶだけの自前実装だった。
交差削減や親子の整列がなく、全依存表示では全ノードが 1 段に横並びになり、依存構造を読み取れなかった。
パン・ズームもなく、大きなグラフはパネルのスクロールでしか閲覧できなかった。

描画層とレイアウト層を汎用ライブラリに置き換え、後続のインタラクション拡張（ノード要約のポップアップ、GitHub Issue への移動、依存タイプ別のエッジ表現。#360）の土台にする。
入力は shared の `buildDependencySubgraph` が返す nodes / edges のままとし、ViewModel は変更しない。

## Decision

- 描画層に React Flow（`@xyflow/react`、MIT）を採用する。ノードは既存の `role="button"` / `aria-pressed` を持つ独自コンポーネント、エッジは dagre の経路点をそのまま描く独自コンポーネントとし、React Flow の既定ノード / エッジは使わない。
- レイアウト層に dagre（`@dagrejs/dagre`、MIT）を採用する。`rankdir: TB` でエッジの向き（ブロッカー → ブロックされる側）をそのまま階層にし、上流を上、下流を下に置く。
- dagre は座標だけを返す純粋関数として `dependency-map-layout.ts` に閉じ込め、React Flow には座標を渡すだけにする。交差数の比較（`countEdgeCrossings`）と初期ビューポートの決定（`computeInitialViewport`）も同じモジュールの純粋関数とし、jsdom を使わずにテストする。
- ノードはドラッグ・接続・React Flow 内部の選択を無効にし、閲覧専用にする。選択は既存の `onSelectTask` に委ねる。
- React Flow の CSS は `base.css` だけを読み込み、`--xy-*` 変数を既存の `--color-*` トークンへ束ねてライト / ダーク両テーマに追従させる。

## Alternatives

### ELK（elkjs）

階層レイアウトの品質は最も高いが、EPL-2.0 で gzip 約 430 KB と大きい（dagre は約 16 KB）。
epic #358 で実データ（本リポジトリの依存グラフ）の現行 / dagre / ELK 比較を行い、ライセンスとサイズを理由に見送った。
dagre で不足が判明した場合に別 Issue で再検討する。

### d3-dag

MIT で既存の d3 系依存と相性がよいが、sugiyama レイアウトの API が dagre より低水準で、エッジ経路の取り出しと設定項目が多い。
現時点で dagre に不足がないため採用せず、乗り換え候補として残す。

### 自前実装の改善（交差削減だけを追加する）

段の割り当てはすでに持っていたため、バリセンタ法による並べ替えを足すだけでも交差は減らせる。
しかしパン・ズーム、ノードの計測、ビューポート管理、アクセシビリティを自前で維持し続けることになり、後続のインタラクション拡張のたびに描画基盤へ手を入れる必要がある。
React Flow に寄せることで、これらをライブラリ側に委ねられる。

### React Flow の組み込みエッジ（smoothstep / bezier）を使う

ハンドル位置から React Flow が経路を計算するため実装は簡単だが、dagre が交差を避けて算出した経路点を捨てることになり、多段のグラフでノードを横切るエッジが出る。
dagre の経路点を描く独自エッジにした。

## Consequences

- Dependency Map のノード座標とエッジ経路が dagre から得られ、同一の依存サブグラフに対する交差数が段組み等間隔配置と同数以下になることをテストで担保する（FR-VIS-027）。
- `@xyflow/react` と `@dagrejs/dagre` が UI の依存に加わる。いずれも MIT。UI バンドルは gzip で 146 KB から 218 KB に増える（2026-09-08 に `packages/ui` で移行前後の `DependencyMapPanel.tsx` をそれぞれ `pnpm build` し、`dist/assets/index-*.js` の gzip 表示を比較）。
- jsdom で React Flow を描画するため、テストの setup に `ResizeObserver` / `DOMMatrixReadOnly` / 要素寸法の最小限の polyfill を置く。ノードには `handles` と幅・高さを明示し、計測を待たずにエッジが描けるようにする。
- React Flow のノード wrapper は selectable / draggable / onNodeClick のいずれかがないと `pointer-events: none` になる。クリックは `onNodeClick` で受け、ノード内部ではキーボード操作だけを扱う。
- Dependency Map 上での依存関係の編集は引き続き対象外（epic #358 の「やらないこと」）。
