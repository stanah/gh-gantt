# Project Map / Task Landscape

Project Map は既存のガントビューを置き換えず、**構造探索・依存探索・次アクション判断**を補助する第 2 ビューである。GitHub Projects V2 と `.gantt-sync/` の既存データから派生表示を組み立て、新規の必須フィールドは追加しない。

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
│ (下左)                    │ (下右)                      │
└───────────────────────────┴─────────────────────────────┘
```

| パネル         | 責務                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| System Tree    | 全体構造を階層表示し、選択した Epic / Feature / Task を他パネルへ伝播する |
| Project Board  | 選択サブツリーのタスクを実行状態の列で表示する (`Ready Now` 列が要)       |
| Dependency Map | 選択サブツリーの上流 / 下流依存・クリティカルパスをグラフ表示する         |
| Next Actions   | 次に着手すべきタスクをスコア順で理由付きに推薦する                        |
| Compact Gantt  | 選択サブツリーのスケジュールをミニタイムラインで読み取り専用表示する      |

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
3. Project Map ツールバーの検索ボックスと readiness チップ（Ready / In Progress / Review / Blocked / Done）で Tree / Board / Next Actions / Compact Gantt を一貫して絞り込める（Dependency Map は選択タスク中心のため選択スコープを優先する）。
4. 各カード / ノードはクリックまたは Enter / Space で選択でき、選択タスクは詳細パネルで編集できる。編集内容は ViewModel に即時反映される。
5. ツールバー右に同期状態（最終同期時刻・未反映数・総タスク数）を表示する。Pull / Push 後に自動で更新される。

## 8. 循環依存の扱い

`blocked_by` に循環がある場合、`calculateCriticalPath()` は timing を計算できない。Project Map は ViewModel の `warnings` に循環を記録し、Dependency Map で警告表示する。循環があっても他パネルはクラッシュしない。
