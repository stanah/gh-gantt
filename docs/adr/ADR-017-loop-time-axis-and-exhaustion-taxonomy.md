---
id: ADR-017
title: 外側ループを時間軸と結線し ready 枯渇を分類する
date: 2026-07-04
status: accepted
related_requirements:
  - FR-VIS-014
  - FR-VIS-018
  - FR-VIS-024
---

## Context

ADR-016 は外側ループ（タスクを選ぶ → 完了させる → 次を選ぶ）を第一級・コード駆動の
ハーネスとして gh-gantt に組み込むことを決定した。しかし ADR-016 の `decide` は
project-map の readiness（ready / blocked / needs_review）のみを参照しており、
gh-gantt の存在理由である**時間軸**（クリティカルパス: FR-VIS-014、
at-risk 検出: FR-VIS-018、start/end date）がループ設計のどこにも登場しない。

このままでは外側ループは「任意のタスクトラッカーで作れる汎用ループ」となり、
「プロジェクトは予定通りか」「ボトルネックはどこか」という gh-gantt の中心的な問いに
ループが寄与しない。また逆方向のフィードバック — 各イテレーションの実績を
見積り・日付と突き合わせる予実管理 — も未定義である。

さらに ADR-016 の停止条件 `no_ready_tasks`（ready が尽きた → 正常終了）は
3 つの異なる状態を混同している。

1. **全タスク完了** — 真の正常終了
2. **全タスクがブロック中** — デッドロックまたは人間・依存待ち。警報であり正常終了ではない
3. **バックログが粗い** — epic / feature レベルの open タスクだけが残り、
   着手可能な粒度のタスクがない。`gh-gantt-decompose` による補充が必要

なお、調査の結果 Project Map の Next Actions（FR-VIS-024）が既に
「ready / 優先度 / 下流解除数 / クリティカルパス / リスクを加味したスコア順・
同点時は安定ソート」という決定論的なタスク推薦を実装していることが分かった。
`decide` に必要なスコアリングは新規発明ではなく既存資産の再利用で足りる。

## Decision

ADR-016 の外側ループ設計に以下の 3 点を追加する。案A（`gh-gantt loop next` /
`loop complete`）の contract は本 ADR に従って確定する。

### 1. decide は ready に限定した上で Next Actions スコアリングを再利用する

`gh-gantt loop next` の decide ステップは、候補集合を **`ready_now`
（readiness が ready なタスク）に限定した上で**、Project Map の Next Actions
（FR-VIS-024）のスコアリング（優先度 / 下流解除数 / クリティカルパス / リスク、
安定ソート）を再利用し、最上位のタスクを選定する。

Next Actions は UI の推薦リストとして blocked タスクも候補に含み、readiness は
スコア成分（+20）に過ぎない。そのため top-1 をそのまま採用すると、優先度・
下流解除数・クリティカル度の高い **blocked タスクが ready タスクを上回り、
着手不能なイテレーションが始まり得る**。decide が再利用するのはスコアリング
関数であって候補集合ではない。ready フィルタ後の候補が空の場合に初めて
枯渇分類（Decision 3）へ進む。

iteration plan には選定理由
（`why: critical_path | at_risk | unblocks_most | priority | fallback_order` と
スコア内訳）を含め、LLM と人間が選定根拠を検証できるようにする。

### 2. complete は予実を記録し、スリップを検出する

`gh-gantt loop complete` はイテレーションの実績
（`completedAt`、所要時間、`verifyResults` の再試行回数）をジャーナルに記録し、
対象タスクの `start_date` / `end_date` / `estimate_hours` と突き合わせる。
`gh-gantt loop status` は予実差とスリップ（完了済みタスクの期日超過、
および残タスクの予測完了が期日を超える見込み）を警告として表示する。

**ループはタスクの日付を自動更新しない。** スリップ検出時は再計画の提案を
提示するに留め、日付の変更は明示的な `gh-gantt update` に委ねる。
これは 3-way merge のコンフリクト源を増やさないため、および
エージェントの暴走による計画の書き換えを防ぐためである。

### 3. ready 枯渇を 3 状態に分類する

`Config.loop.stopWhen` の `no_ready_tasks` を廃止し、以下に分割する。

```yaml
loop:
  stopWhen:
    - all_done # open タスク 0 → 正常終了
    - all_blocked # open はあるが ready 0 かつ全て依存・レビュー待ち → ブロッカー一覧を提示
    - backlog_needs_decomposition # 分解可能な type（type_hierarchy 上の非 leaf）の open のみ残存
    - conflicts_present
    - human_gate_required
    - budget_exhausted
```

判定は CLI 側で決定論的に行う。`backlog_needs_decomposition` の場合、
iteration plan は `gh-gantt-decompose` への導線（分解候補の epic / feature 一覧）を
含める。これにより decompose が外側ループの補充ステップとして組み込まれる。

## Alternatives

### readiness のみで選定し続ける（ADR-016 のまま）

汎用ループとしては成立するが、時間軸への寄与がなく gh-gantt 上に構築する意味が薄い。
Next Actions という実装済み資産があるため、再利用コストは小さい。却下。

### ループがタスクの日付を自動更新する

予実差を検出したら `end_date` を自動でずらす案。一見便利だが、
(1) 3-way merge のコンフリクト源になる、(2) エージェントの誤判断が
計画そのものを黙って書き換える、(3) 「予定通りか」の基準線が動いてしまい
スリップが観測できなくなる。検出と提案に留め、更新は人間または明示操作に委ねる。

### 枯渇分類を LLM の判断に任せる

「ready が無い理由を LLM が status 出力から推測する」案。ADR-016 が排除した
散文・記憶依存への回帰であり、決定論的に分類可能な情報（open 数、blocked_by、
type_hierarchy）で判定できるため CLI 側に置く。

### ADR-016 への追補として書く

decide の contract・stopWhen の列挙・ジャーナルのスキーマという実質的な設計変更を
含むため、独立 ADR として記録し ADR-016 とは相互参照で繋ぐ
（ADR-010 → ADR-013 の委譲と同じ運用）。

## Consequences

- 案A（#277）の `gh-gantt loop next` / `loop complete` は本 ADR の contract に従う。
  実装順序として本 ADR の反映が案A の前提となる。
- LoopState のイテレーションレコードに実績フィールド
  （`completedAt`、所要、予実差）が追加される。#279 のスキーマ設計に反映する。
- `Config.loop.stopWhen` の列挙が変わる（`no_ready_tasks` →
  `all_done` / `all_blocked` / `backlog_needs_decomposition`）。#280 に反映する。
- decide は `@gh-gantt/shared` の project-map / dependency-graph
  （CPM 計算・Next Actions スコアリング）を再利用する。UI と CLI で
  推薦ロジックが単一実装に保たれる。
- `gh-gantt-decompose` skill に「外側ループからの補充導線」の記述を追加する
  （skill 更新は案A 実装時に行う）。
- スリップ警告の閾値は既存の `gantt.at_risk_threshold_days`（FR-VIS-018）を
  再利用し、新たな設定項目を増やさない。
