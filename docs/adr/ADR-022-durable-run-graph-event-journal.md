---
id: ADR-022
title: durable Run Graph を command受付と immutable event journal で実装する
date: 2026-07-30
status: accepted
related_requirements:
  - NFR-STABILITY-014
---

## Context

ADR-021 は versioned Graph Contract、accepted Run Graph event、stable ID、独立 budget、authority、
human gate、checkpoint を製品 control plane の責務とした。既存 `loop-state.json` は outer loop の
iteration snapshot であり、dev-role 内の node / attempt lineage と event ordering を表せない。

外部 runner に raw event append や target state の指定を許すと、遷移規則と authority が interface の
外へ漏れる。一方、role ごとの多数の command を公開すると CLI と domain API の両方が shallow になり、
将来の node 追加ごとに surface が増える。

## Decision

Run Graph は `start`、`applyEvent`、`inspect` の3操作を持つ deep control-plane module として実装する。
外部 runner が送るものは versioned command/outcome envelope であり、module が Graph Contract、現在 state、
expected node / attempt、authority、artifact/evidence schema、budget を検証してから正準 event を生成する。
runner は event sequence、target state、edge、budget counter を指定できない。
CLI の汎用 `run event` は execution plane 用に限定し、`human_decision` と `pr_observed` を拒否する。
前者は human role を固定する `run decide`、後者は既存 GitHub GraphQL adapter から live state を取得する
read-only の `run observe-pr` だけが control plane へ渡す。
`run observe-pr` は PR の `closingIssuesReferences` を live 取得し、Run の Work Graph 対象と
owner / repository / Issue 番号が一致する positive proof を得た場合だけ遷移を許可する。
一致しないと確定するには cursor 終端まで取得し、pagination を完了できない場合は Run state を
変更せず拒否する。
旧 schema v1 の accepted segment に PR linkage フィールドがない場合、store は不変 segment を
書き換えず、読み取り時だけ未証明 linkage へ正規化する。未証明の過去 event は
`merged` / `closed` であっても Run を `completed` へ昇格させない。

Graph Contract と Run Graph event は `.gantt-sync/run-graph/` 配下の別 store に置く。Graph Contract は
plan ID/version/schema version で exact binding し、Run Graph は run ごとの immutable sequence segment を
正本とする。projection は event replay から導出し、初期実装では snapshot を正本にしない。command ごとに
一つ以上の segment を確定した後で receipt を返す。

ID と受理時刻は control plane が生成する。caller の event ID は重複検出に使い、既に受理済みの ID は
payload が同じでも `DUPLICATE_EVENT` として拒否する。domain rejection は Run Graph state を変更せず、
別の rejection evidence として記録する。壊れた JSON のように run/event identity 自体を信用できない入力は
永続化せず拒否する。

default view は Work Graph 対象、current node、wait reason、attempt、独立 budget、allowed next transitions、bounded な
artifact/evidence reference だけを返し、`total`、`limit`、`truncated` を含める。外部副作用と event append を
原子的にはできないため、再開時に running Attempt を盲目的に再配布しない。checkpoint と side-effect evidence が
不足する場合は state を変更せず paused のまま fail-closed にする。
resume command は `not_started` / `committed` / `reconciled` / `unknown` の side-effect state を必須にする。
`unknown` は自動再開せず、`committed` / `reconciled` は `side_effect_reconciliation` evidence を要求する。

Issue #328 は single writer の固定 dev-role profile だけを実装する。parallel claim / lease / join と
multi-process compare-and-append は #329、動的 plan version は #331 で追加する。

## Alternatives

### loop-state.json を Run Graph snapshot へ拡張する

outer loop の task 選定履歴と dev-role execution state の正本が混ざり、terminal Attempt の不変性と
accepted event lineage を復元できないため採用しない。旧 loop-state は変更せず読み取り互換を維持する。

### raw event append API を runner に公開する

拡張性は高いが、runner が edge、state、budget、human gate を組み立てられ、control plane の authority が
物理的に効かなくなるため採用しない。公開 envelope は意図と outcome に限定する。

### role ごとの start/finish/retry/review command を公開する

最頻呼び出しは短くなるが、固定 graph の詳細が CLI surface へ露出し、将来の Graph Contract version ごとに
command が増えるため採用しない。CLI は汎用 `run event` を deep module へ変換する adapter とする。

### mutable JSON snapshot だけを atomic replace する

実装は小さいが、checkpoint 以前の event、重複、stale Attempt、budget 消費の根拠を独立に監査できないため
採用しない。projection cache は将来追加できるが、accepted event を正本にする。

## Consequences

- Work Graph の GitHub task state と Run Graph state は暗黙に同期しない。
- PR live evidence の取得は read-only であり、PR reply / resolve / merge は行わない。
- process restart 後も event replay で同じ current node / attempt / human gate を復元できる。
- journal segment 数は実行回数に比例する。compaction は event lineage を保つ別 decision が必要になる。
- #329 は ready frontier、entity version、claim/lease event を既存 protocol に追加できるが、single-writer の
  安全性を multi-writer の証拠として扱わない。
