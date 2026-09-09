# プロジェクトマップ / タスクランドスケープ (Project Map / Task Landscape)

プロジェクトマップ (Project Map) は既存のガントビューを置き換えず、**構造探索・依存探索・次アクション判断**を補助する第 2 ビューである。GitHub Projects V2 と `.gantt-sync/` の既存データから派生表示を組み立て、新規の必須フィールドは追加しない。

関連 Issue: Epic #251 (PM-00 〜 PM-09)

## 1. 目的

1 画面で以下を確認できるようにする。

1. **何を作る必要があるか** — System / Epic / Feature / Task の階層
2. **何が何をブロックしているか** — 依存関係と Ready / Blocked の判定
3. **今どのタスクを進めるべきか** — Next Actions の推薦
4. **選択した機能がスケジュール上どこにあるか** — Compact Gantt

## 2. 画面構成

```text
┌────────────────────────────────────────────────────────┐
│ Toolbar: view 切替 / フィルタ / sync status            │
├───────────────┬───────────────────────┬────────────────┤
│ System Tree   │ Project Board         │ Dependency Map │
│ (左)          │ (中央)                │ (右)           │
├───────────────┴───────────┬───────────┴────────────────┤
│ Next Actions              │ Compact Gantt / Timeline    │
│ (中左)                    │ (中右)                      │
├───────────────────────────┴─────────────────────────────┤
│ Planned vs Actual Run Graph                             │
└────────────────────────────────────────────────────────┘
```

UI 上の各パネル見出しは英語表記（括弧内）で表示される。
上図は既定構成である。パネルの表示 / 非表示・並び順・サイズは利用者がカスタマイズでき、設定はブラウザの localStorage に保存される（7 章）。

| パネル                             | 責務                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| システムツリー (System Tree)       | 全体構造を階層表示し、選択した Epic / Feature / Task を他パネルへ伝播する  |
| プロジェクトボード (Project Board) | 選択サブツリーのタスクを実行状態の列で表示する (`Ready Now` 列が要)        |
| 依存関係マップ (Dependency Map)    | 選択サブツリーの上流 / 下流依存・クリティカルパスを階層グラフで表示する    |
| 次のアクション (Next Actions)      | 次に着手すべきタスクをスコア順で理由付きに推薦する                         |
| コンパクトガント (Compact Gantt)   | 選択サブツリーのスケジュールをミニタイムラインで読み取り専用表示する       |
| 実行グラフ (Planned vs Actual)     | Graph Contract の計画と durable Run Graph の実績・差分・待機理由を表示する |

## 3. MVP / P1 / P2 の境界

- **MVP (P0)**: System Tree / Project Board / Dependency Map / Next Actions の 4 パネルと view 切替、ViewModel、単体テスト。UI 側で `/api/config` と `/api/tasks` から ViewModel を組み立てる。
- **P1**: Compact Gantt (PM-07)、フィルタ・同期状態・詳細パネル連携 (PM-08)。
- **P2** (別 Issue 化済みの backlog): タスク不足検出、Project Map API、Board drag & drop、Dependency Map 編集、Export。

## 4. 状態判定

判定は設定の `statuses.values[*].category` / `done` / `starts_work` を優先し、無い場合のみフォールバックする。`blocked_by` は「このタスクが何にブロックされているか」を表す（依存エッジは `dep.task -> task.id`）。

### 4.1 readiness

```text
already_done            : state === "closed"、または status.done
needs_review            : status.category === "in_review"、または require_review かつ未承認
blocked_by_open_dependency : 未完了の blocked_by が 1 件以上
ready                   : open かつ done でなく、blocked_by がすべて完了
```

依存解除の判定: `blocked_by` のすべての上流タスクが done（`already_done`）なら依存解除済みとみなす。上流がタスク集合に存在しない場合は「未解決」として扱う。

### 4.2 Board column

| Column        | 判定 (上から評価し最初に一致したもの)                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| `done`        | `state === "closed"`、または status.done                                                  |
| `review`      | status.category === `in_review`、または `require_review` かつ未承認                       |
| `in_progress` | status.category === `in_progress`、または status.starts_work                              |
| `blocked`     | 未完了の `blocked_by` が存在、または status.category === `blocked`                        |
| `ready_now`   | open / done でない / blocked でない / 依存がすべて完了 / in_progress でも review でもない |
| `backlog`     | 上記以外                                                                                  |

### 4.3 その他のフラグ

- `critical`: `calculateCriticalPath()` の `criticalTaskIds` に含まれる
- `risky`: `labels` に `risk` / `spike` / `external` を含む

## 5. Next Actions スコアリング

```text
score =
    readyWeight            // ready なら +20
  + priorityWeight         // P0 +10 / P1 +6 / P2 +3 / P3 +1
  + downstreamUnlockCount * 3   // この完了で解除される下流の未完了タスク数
  + criticalPathWeight     // クリティカルパス上なら +8
  + riskWeight             // risk / spike / external ラベルがあれば +5
  - estimatePenalty        // estimate_hours / 8。未設定なら 0
```

- 候補は open かつ done でない、かつ子タスクを持たない（コンテナでない）タスク。
- スコア降順、同点時は priority → updated_at(新しい順) → title の安定ソート。
- 各候補に推薦理由（最も効いた要素）を 1 行で付与する。
  - カテゴリ: `unlocker`（下流解除）/ `critical`（クリティカル）/ `risk`（高リスク）/ `quick_win`（すぐ終わる）/ `review_waiting`（レビュー待ち）/ `ready`（着手可能）

`downstreamUnlockCount` は、対象タスクを起点に `blocked_by` の逆向き（このタスクをブロッカーに持つタスク）を辿り、未完了の下流タスク数を数える。

## 6. 既存 Gantt ビューとの責務分担

- Gantt ビュー: 時間軸・期間・ドラッグ編集・依存線。スケジュール調整の主画面。
- Project Map: 構造・状態・依存・次アクションの探索。読み取り中心（MVP では編集は詳細パネル経由のみ）。
- 両者は Toolbar の view 切替で往来し、選択中タスクは可能な範囲で維持する。

## 7. 操作方法

1. Toolbar 左の `Gantt` / `Project Map` トグルで Project Map ビューに切り替える。
2. 左の System Tree で Epic / Feature / Task を選択すると、Board / Dependency Map / Next Actions / Compact Gantt が選択サブツリーに追従する。
3. Project Map ツールバーの検索ボックス・readiness チップ・タイプ チップで Tree / Board / Next Actions / Compact Gantt / Dependency Map を一貫して絞り込める。フィルタ状態は Project Map 内で保持し、Gantt ビューの Type フィルタや hideClosed とは共有しない（URL / localStorage にも保存しない）。
   - **readiness チップ**（Ready / In Progress / Review / Blocked / Done）は複数選択で、選んだ列のいずれかに属するタスクが残る。`All` で選択と Done 除外をまとめて解除する。
   - **`Done を除外`** は 1 操作で Done 列のタスクを非表示にするトグル。readiness の選択とは独立に効き、有効にすると Done チップの選択は外れる（Done チップを選び直すと除外は解除される）。
   - **タイプ チップ**は `config.task_types` から並び、複数選択で絞り込める。
   - **マイルストーン チップ**はタスクに設定されたマイルストーン名（継承後の値）から並び、複数選択で絞り込める。判定は shared の `resolveInheritedMilestones` で親子関係（`parent` / `sub_tasks`）を辿って解決した値を使うため、自身に未設定でも祖先（Epic / Feature）にそのマイルストーンが設定された子孫タスクが含まれる。`blocked_by` は辿らない。自身にも祖先にも無いタスクは `(なし)` で絞り込める。
   - **`マイルストーン型を表示`** はマイルストーン型（`config.task_types[*].display: "milestone"`）のタスクを Dependency Map のノードとして表示するトグル（マイルストーン型が存在するときだけ出る）。既定では非表示で、経由する依存は途切れ（省略記号）として示す。表示時はひし形マークと破線枠で通常ノードと区別する。Tree / Board など他パネルにはこの除外を適用しない。
   - 一致件数は `matched / total` で表示し、各パネルに渡すタスク集合と一致する。
   - **Dependency Map への適用**: サブグラフは選択タスク中心の絞り込み（全タスクから組む）を先に行い、その結果からフィルタに一致しないノードを取り除く。両者は直交して同時に効く。除外ノードを経由する依存は、残ったノードの右端に破線囲みの省略記号（上流が除外なら `⋯→`、下流が除外なら `→⋯`）で途切れを示し、ツールチップに件数を出す。ヘッダーの hint にはフィルタで非表示になったノード数を併記する。
4. 各カード / ノードはクリックまたは Enter / Space で選択でき、選択タスクは詳細パネルで編集できる。編集内容は ViewModel に即時反映される。
5. ツールバー右に同期状態（最終同期時刻・未反映数・総タスク数）を表示する。Pull / Push 後に自動で更新される。
6. ツールバー右の `パネル設定` ボタンでパネル構成の設定領域を開閉する。設定領域では次の操作ができる。
   - **表示 / 非表示**: 各パネルのチェックボックスで切り替える。非表示にしたパネルの領域は残りのパネルに再配分される。
   - **並び順**: `↑` / `↓` ボタンで表示順を入れ替える。パネルは 3 カラムの grid に表示順で行ごとに詰め込まれ、行に収まらないパネルは次の行へ送られる。各行の末尾のパネルは残りの列まで広がるため、非表示にしたパネルの領域は同じ行の残りのパネルに再配分され、空きセルは残らない。
   - **サイズ**: `標準`（1 カラム）/ `広い`（2 カラム）/ `全幅`（3 カラム）を選ぶ。
   - **プリセット**: `標準`（6 パネル既定構成）/ `依存重視`（Dependency Map を広く表示し Board と Run Graph を隠す）/ `ボード重視`（Project Board を広く表示し Dependency Map と Run Graph を隠す）。手動で変更すると `カスタム` になる。
   - **既定に戻す**: 既定構成へ戻す。
     設定は `gh-gantt:project-map-layout` キーで localStorage に保存され、再訪時に Zod 検証を通した上で復元される（不正な保存データは既定構成にフォールバックする）。画面幅が 980px 以下のときはサイズ設定によらず 1 カラムに折り返す。パネル構成は選択連携・フィルタ・Group by・Run Graph の動作に影響しない。

## 8. Group by 軸と多ファセット分類

分類は単一の親子ツリーに固定せず、**Group by 軸セレクタ（1 度に 1 軸 + 切替）**で切り替える。設計判断は ADR-015 参照。

- 組み込み軸: `階層 (hierarchy) / タイプ / ステータス / 優先度 / 担当者 / マイルストーン`
- **名前空間ラベル facet 軸**: `label:<key>` 軸。機能 vs システムを両立する。
  - **自動検出（設定不要）**: タスクのラベルから `namespace:value` 規約（既定区切り `:`）を走査し、`system` / `feature` / `phase` / `area` 等の namespace を Group by 軸として自動的に並べる（`detectLabelFacets`）。`config.grouping` が空でも軸が出る。
  - **明示設定（任意）**: `config.grouping.facets` で `{ key, label, label_prefix }` を定義すると日本語ラベルや並び順をカスタムできる。同じ key は設定が自動検出より優先される。

```jsonc
"grouping": {
  "label_prefix": "area:",        // 既存（Gantt 用）はそのまま
  "facets": [                     // 任意。未設定でもラベルから自動検出される
    { "key": "system",  "label": "システム", "label_prefix": "system:" },
    { "key": "feature", "label": "機能",     "label_prefix": "feature:" }
  ]
}
```

1 タスクに `feature:project-map` と `system:ui` の両方を付与し、Group by を切り替えると同じデータを機能軸 / システム軸で見分けられる。

- 多対多軸（ラベル facet / 担当者）はタスクが複数グループに重複所属する。
- 単一値軸（type/milestone/status/priority）は 1 グループ。値が無いタスクは末尾の「(なし)」グループへ。マイルストーン軸は現状タスク自身の `milestone` のみを見る（ツールバーの絞り込みと同じ継承結果を使いたい場合は `resolveInheritedMilestones` を利用できる）。
- `hierarchy` 以外を選ぶと **Project Board はスイムレーン（グループ行 × 実行状態列）**で表示される。
- 操作: ツールバーの「Group by」ドロップダウンで軸を選ぶ。System Tree はグループ見出し + タスク行に切り替わる。

ラベル名前空間規約（`system:` / `feature:` / `area:` / `phase:`）は ADR-015 に定義。

## 9. 循環依存の扱い

`blocked_by` に循環がある場合、`calculateCriticalPath()` は timing を計算できない。Project Map は ViewModel の `warnings` に循環を記録し、Dependency Map で警告表示する。循環があっても他パネルはクラッシュしない。dagre は循環を含むグラフでも座標を返すため、Dependency Map 自体の描画も止まらない。

## 9.1. Dependency Map の描画

Dependency Map は shared の `buildDependencySubgraph` が返す nodes / edges を入力に、レイアウトを dagre、描画を React Flow で行う（ADR-028）。

- **階層配置**: `rankdir: LR` でブロッカーを左、ブロックされる側を右に置き、同じ段のノードは縦に積む。ノードは幅 170px の横長なので、段が浅く同じ段にノードが多い依存グラフでは縦向き (TB) だと極端に横長になるため、横向きにしている。同じ段のノードは dagre が交差を減らす順に並べ、エッジは dagre の経路点をそのまま描く。ノードのハンドルは左辺 (target) と右辺 (source) にあり、エッジの始点 / 終点はノードの左右の辺に固定する。循環で下流側が左に置かれた逆向きエッジは from の左辺から to の右辺へ結び、ノード本体を貫通させない。
- **連結成分の分割**: 互いに依存で繋がっていない連結成分は個別に dagre を実行し、ノード数の多い成分から順に縦に積んで左端 (最上流の段) を揃える。LR 配置では横軸が「左 = 上流、右 = 下流」を意味するため、無関係な成分を横に並べると左の成分の下流に続いているように読めてしまう。縦長になる分はパン・ズームで閲覧し、成分同士は段間隔より広い間隔で区切る。全依存モード (選択なし) では無関係な成分が多数あるため、1 つのグラフに渡すと巨大な単一段に潰れる。
- **ranker**: dagre の `ranker` は `network-simplex` (dagre の既定) を採用する。gh-gantt 自身の実データ (201 タスク、依存 38 件、親子と依存が混在) で比較した結果は次の通り。交差数は `countEdgeCrossings` (ノード境界中央を結ぶ直線同士の交差数)、縦横比は外接領域の幅 / 高さ。

  | 対象                               | 設定                                     | 交差数 | 幅 × 高さ (px) | 縦横比 |
  | ---------------------------------- | ---------------------------------------- | ------ | -------------- | ------ |
  | 全依存 (52 ノード / 51 エッジ)     | TB / network-simplex / 分割なし (移行前) | 10     | 3562 × 480     | 7.42   |
  | 〃                                 | LR / network-simplex / 分割なし          | 7      | 1284 × 1028    | 1.25   |
  | 〃                                 | LR / network-simplex / 分割あり          | 0      | 1284 × 1274    | 1.01   |
  | 〃                                 | LR / tight-tree / 分割あり               | 0      | 1284 × 1274    | 1.01   |
  | 〃                                 | LR / longest-path / 分割あり             | 0      | 1284 × 1312    | 0.98   |
  | 選択: #293 (19 ノード / 16 エッジ) | TB / network-simplex / 分割なし (移行前) | 0      | 2240 × 480     | 4.67   |
  | 〃                                 | LR / network-simplex / 分割あり          | 0      | 1284 × 452     | 2.84   |
  | 〃                                 | LR / tight-tree / 分割あり               | 0      | 1284 × 452     | 2.84   |
  | 〃                                 | LR / longest-path / 分割あり             | 0      | 1284 × 456     | 2.82   |
  | 選択: #28 (21 ノード / 1 エッジ)   | TB / network-simplex / 分割なし (移行前) | 0      | 3728 × 144     | 25.89  |
  | 〃                                 | LR / network-simplex / 分割あり          | 0      | 626 × 540      | 1.16   |

  この規模では ranker 間で段の割り当てにほぼ差が出ず、`network-simplex` と `tight-tree` は同一の結果、`longest-path` は段が偏る分わずかに高さが増えた。三者とも数 ms で完了するため計算量の差も無視できる。エッジ長の総和を最小化する `network-simplex` が理論上もっとも段が詰まり、dagre の既定でもあるため採用した。ELK / d3-dag への乗り換えは dagre で不足が判明した場合に別 Issue で扱う。

- **エッジの表現**: 関係の種類を色と線種の組み合わせで区別する。定義は `DependencyMapPanel.tsx` の `dependencyEdgeStyles` の 1 箇所にまとめ、描画と凡例で共用する。色だけに頼らず線種と線幅を併用するため、色覚特性があっても、また `gantt.colors.critical_path` が danger と同じ赤に設定されていても区別できる。基本線幅は 2px（クリティカルパスは 3.5px）で、ライト / ダーク両テーマの背景から浮く。

  | 種類                | 色                                               | 線種     | 線幅  |
  | ------------------- | ------------------------------------------------ | -------- | ----- |
  | ブロック (解決済み) | `--color-text-secondary`                         | 実線     | 2px   |
  | ブロック (未解決)   | `--color-danger`                                 | 破線     | 2px   |
  | クリティカルパス    | `gantt.colors.critical_path`                     | 太い実線 | 3.5px |
  | 親子                | `--color-highlight-parent-border` (Gantt と同じ) | 点線     | 1.5px |

  未解決かつクリティカルパス上のエッジは critical_path 色の太い破線になり、両方の情報を保つ。ノードの左バーと枠線は readiness 列の色に従う。

- **依存タイプと lag**: 線種は関係の種類に使うため、`blocked_by` の `type` と `lag` はエッジ経路の中点にラベルで示す。finish-to-start は既定なので略号を出さず、それ以外は `SS` / `FF` / `SF`、lag が 0 以外なら `+3d` のように添える（例: `FF -2d`）。
- **親子エッジ**: ヘッダの「親子」トグルで表示できる（既定は非表示）。shared の `buildDependencySubgraph` が両端ともサブグラフに含まれる親子だけを `parentEdges` として添え、ノード集合は変えない。レイアウトでは dagre に渡さず、配置確定後に親と子のノード境界（中心のずれが横方向に大きければ左右の辺、そうでなければ上下の辺）を直結するため、段付けには影響しない。
- **凡例**: キャンバス左下に関係種別ごとの線見本とラベル、依存タイプ / lag ラベルの読み方を表示する。親子エッジが非表示のときは凡例の親子行を薄くして「(非表示)」と示す。
- **ノードの構成**: ノードは幅 220px・高さ 44px で、タイトルにノード全体を使って最大 2 行表示する (超える分は省略)。アイコン類はノード内の行を占有せず、角や辺に重ねる: 右上に PR バッジ、右下に担当者アバター、左右の辺の中央に非表示隣接マーク。フォーカス操作 (◎) はホバー / フォーカス時だけ右上の内側に現れる。
- **担当者アバター**: ノードの右下に半分はみ出す形で担当者のアバターを最大 2 人まで重ねて表示し、超過分は「+N」で示す (ノード内の領域を奪わない)。画像は GitHub の決定的な URL `https://github.com/<login>.png?size=40` から取得するため、追加の API 呼び出しや同期フィールドは不要。取得に失敗した場合 (オフライン等) は同じ寸法のイニシャル (login の先頭 2 文字) に置き換え、レイアウトを崩さない。担当者がいないノードはアバター領域を作らない。各アバターと「+N」は title 属性に login を持ち、ホバーで担当者名が分かる。オフライン用の画像キャッシュが必要になった場合は pull 時に取得して保存する拡張を別 Issue で扱う。
- **関連 PR の状態**: ノードの右上にはみ出す丸いバッジとして、Issue を解決する PR の状態を Draft / Open / Merged / Closed の 4 種のアイコンで示す。Draft は破線、Merged は合流線、Closed は × で区別し、色は既存の success / danger / text-muted トークンに従う (Merged は GitHub と同じ紫)。複数の PR がある場合は最も進んだ状態 (merged > open > draft > closed、同順位なら番号の大きい方) を代表アイコンにし、件数を添える。アイコンは代表 PR の URL を新規タブで開くリンクで、クリックはノードの選択に伝播しない。データは `pull` が `closedByPullRequestsReferences` から取得する `linked_prs` (number / title / state / url / is_draft) で、Draft PR は GitHub 上では state が open のまま `isDraft` が true になるため `is_draft` で判別する。`is_draft` は #376 で追加した省略可の項目で、それ以前の cache もそのまま読める。状態を持たない legacy の number 参照だけのノードや、PR の無いノードにはアイコンを出さない。代表の選定は shared の `summarizeLinkedPullRequests` で行い、`gh-gantt show` の Linked PRs 表示も同じ状態判定 (`linkedPullRequestStatus`) を使う。
- **表示範囲**: ヘッダの「全依存 / 選択中心」トグルで切り替える。既定は「全依存」で、依存に関与する全タスクを表示し、選択はノードの強調にだけ使う。「選択中心」では `buildDependencySubgraph` により選択タスク (とその子孫) を中心に上流 / 下流 2 階層へ絞り込む (選択がなければ全体を表示する)。
- **選択連携**: ノードのクリック、または Enter / Space で既存の詳細パネルに選択が伝わる。表示範囲はこの操作では変わらないので、全体を眺めながら複数のタスクを順に確認できる。選択中のノードは `aria-pressed="true"` と selected トークンの枠で示す。「全依存」に戻しても選択は維持される。
- **フォーカス操作**: ノード右端のアイコン、またはノードのダブルクリックで、そのタスクを選択したうえで「選択中心」に切り替える。ダブルクリックをこの操作に使うため、React Flow のダブルクリックによる拡大は無効にしている。
- **フィルタ**: ツールバーのフィルタに一致しないタスクは shared の `pruneDependencySubgraph` でサブグラフから取り除く。除外ノードに接続していた依存は残ったノード側に上流 / 下流の件数として記録し、ノード上の省略記号で途切れを示す（7 章）。
- **マイルストーン型**: `display: "milestone"` のタスクは既定で同じ仕組みで取り除く。`マイルストーン型を表示` を有効にすると `data-milestone="true"` のノードとして描き、左バーの代わりにひし形マーク、枠線は破線にして通常ノードと区別する。
- **閲覧**: ドラッグでパン、ホイール / ピンチとパネル右下のコントロールでズームできる。初期表示はグラフ全体が読める倍率（0.5 倍以上）で収まるなら全体を、収まらなければ選択タスクを中心に 0.8 倍で表示する。判定は外接領域の幅と高さの両方で行うため、横向き配置でも同じ規則で動く。ビューポートを適用し直すのはレイアウトが変わったときだけで、「全依存」でノードを選択しただけでは動かさない。
- **テーマ**: React Flow の `--xy-*` 変数を既存の `--color-*` トークンに束ね、ライト / ダーク両テーマに追従する。
- **対象外**: ノードのドラッグや接続による依存関係の編集は行わない。

## 10. Graph Contractとの関係

Project MapはWork Graphの派生viewであり、graph contractの正典はADR-021とする。
本viewは実行履歴を生成せず、taskを暗黙に変更しない。#330 の planned-vs-actual 表示は
`#328` の immutable event store と control plane の bounded view だけを入力にし、runner log 本文を読まない。
後続拡張は、#329のclaim/lease/joinと#331のapproval proposal/new plan versionをADR-021で確認する。

## 11. Planned vs Actual Run Graph

選択 task に紐づく run を `GET /api/project-map/run-graph` から取得する。operator UI と agent 向け
JSON は shared の `ProjectMapRunGraphViewModel` を共用し、別々の状態判定を持たない。

### 11.1 bounded API

| query    | 意味                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| `taskId` | 必須の canonical task ID。draft task は Run Graph target を持たないため拒否する |
| `runId`  | opaque run ID。task と一致しない run は 404                                     |
| `nodeId` | opaque node ID。選択 run に存在しない場合は fail-closed で 404                  |
| `limit`  | run/node/attempt/artifact/evidence の上限。1〜50、既定20                        |

レスポンスは run と planned node/edge に `total / limit / truncated / items` を持つ。accepted event の
append 時に Zod 検証済みの task locator index を更新し、API request は task 単位の最大50件の summary と
選択 run の locator だけを読む。既存 journal の index 再構築は server 起動時に request path 外で行い、
journal 全文の replay は最大 `limit` 件に限定する。append は event 確定前に index を検証して pending
transaction を永続化し、event 確定後の中断は次の append / 一覧取得 / server 起動時に bounded 修復する。
locator writer は process 間 lease で直列化し、死亡 owner と死亡・期限切れ recovery claimant を再回収する。
一覧取得も同じ lease 内で pending 修復・complete state 検証・index 読み取りを行う。live writer が
100ms 以内に解放しない場合や complete state がない場合は、混在 snapshot を返さず 503 で fail-closed にする。
全 run history や log 本文は既定で返さない。
URL は `view=project-map&task=...&run=...&node=...` を使い、run 変更時は古い node 選択を除去する。

### 11.2 状態と差分

- run は `active / queued / waiting_human / failed / completed / cancelled`、node はこれに
  `running / retrying` を加えた表示状態へ正規化する。正準 state 自体は変更しない。
- actual transition を Graph Contract edge と stable ID で照合し、`unexpected_node`、
  `unexpected_edge`、`skip`、`retry`、`fallback`、`cancel` を差分として表示する。差分は最大200件に制限し、
  超過時は `deviationsTruncated` で一部表示であることを示す。
- attempt は node/attempt ID、actor、開始・終了時刻、duration、artifact/evidence の bounded 件数だけを表示する。
- accepted event timestamp から導出できる duration は既知値とする。現行 runner contract が保持しない
  token / cost / latency は `0` へ丸めず `unknown` とする。
- Run Graph が存在しない project では空状態を表示し、従来の5パネルと task 編集を維持する。

## 12. Graph Engineering の運用

Project Map の Planned vs Actual は bounded な観測 view であり、Graph Engineering の採用判定や
benchmark report の正本ではない。Run Graph が見えること自体を single-loop に対する改善証拠としない。

- 導入前: 同一受入基準の `single_loop` / `graph_orchestration` pairを
  [Graph Engineering運用reference](../skills/gh-gantt-workflow/references/graph-engineering.md)に従って測る。
- 運用中: wait reason、deviation、claim auditを確認し、raw runner logから状態を推測しない。
- 停止: unknown side effect、sync conflict、human gate、retry budget超過を検出したら新規dispatchを止める。
- 復旧: Work Graphをpullし、Run Graphのcheckpoint / claim lineageを再観測してからreclaim / resumeする。

benchmarkが`single_loop`を返したtask shapeではProject MapにRun Graphが存在しても並列dispatchへ昇格しない。
