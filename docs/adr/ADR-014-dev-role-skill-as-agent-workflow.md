---
id: ADR-014
title: 開発ロール分離を gh-gantt-dev-role skill として扱う
date: 2026-05-08
status: accepted
related_requirements:
  - NFR-STABILITY-010
---

## Context

単一の coding agent が計画、実装、検証、レビュー、PR 作成を一気通貫で行うと、動作確認の省略や自己評価バイアスが起きやすい。既存の `gh-gantt-workflow` は開発サイクル全体を扱い、`gh-gantt-pr` は PR 作成だけを標準化しているが、PR 前に独立した executor / reviewer を物理的に挟む汎用 contract はまだない。

iris からの委任調査では、Claude / Codex / Aider など特定 agent に閉じない形で、project ごとの verify command と rubric を読み込む dev role skill が求められた。

## Decision

`gh-gantt-dev-role` skill を追加し、`orchestrator` / `planner` / `implementer` / `executor` / `reviewer` の5ロールを1 skill + role別 reference で提供する。

この skill は `gh-gantt-workflow` を置き換えない。project の `.gantt-sync/workflow.md` に `## Dev-Role Config` がある場合、`gh-gantt-workflow` の設計・実装・検証ステップから `gh-gantt-dev-role role=orchestrator` へ引き継ぐ。

runtime artifact は `.dev-flow/<issue-number>/` を既定の scratchpad とし、schema 化された JSON で role 間 handoff を行う。`executor` は `verifyCommands` を直列実行し、`reviewer` は executor pass 後に rubric で差分を評価する。

## Alternatives

### role ごとに別 skill を作る

role の discoverability は上がるが、共通 HARD-GATE、config discovery、artifact schema の重複が増える。Phase alpha では1 skillに集約し、reference で肥大化を抑える。

### gh-gantt-workflow に直接すべて書く

既存 workflow がさらに大きくなり、dev-role を使わない project にも複雑さが流れ込む。`gh-gantt-workflow` は lifecycle hook の中核に留め、dev-role は二次スキルに分離する。

### project 固有 skill として iris にだけ置く

iris の問題には最短で効くが、agent 非依存・project 非依存の reusable contract にならない。gh-gantt の二次スキルとして配布し、project 差分は config と rubric に逃がす。

### executor と reviewer を CI だけに任せる

CI は最終防衛線として必要だが、PR 作成前に失敗を止められない。dev-role は PR 前 gate として executor artifact を必須にする。

## Consequences

- `gh-gantt-workflow` は `Dev-Role Config` を見つけた場合の引き継ぎ導線を持つ。
- `gh-gantt-pr` は PR 作成だけの責務を維持し、品質 gate は `gh-gantt-dev-role` が担う。
- project は `.gantt-sync/workflow.md` または `.dev-flow/config.json` に verify command と rubric を定義する必要がある。
- `.gantt-sync/tasks.json` / `.gantt-sync/sync-state.json` は引き続き直接読まない。同期状態は `gh-gantt` CLI が管理する。
- runtime artifact の扱いは project の `.gitignore` 方針に従う。既定では PR に含めない。
