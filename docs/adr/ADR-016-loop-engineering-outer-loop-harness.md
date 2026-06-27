---
id: ADR-016
title: loop engineering を外側ループハーネスとして gh-gantt に組み込む
date: 2026-06-27
status: accepted
related_requirements:
  - NFR-STABILITY-005
  - NFR-STABILITY-010
---

## Context

gh-gantt は AI エージェントが人間と同じワークフローでタスクを管理するための
CLI ツールであり、セルフホスティングで自身の開発にも使っている。
近年 "loop engineering"（エージェントを act → observe → decide → repeat の
サイクルで自律走行させるハーネスを設計する営み）が、プロンプト工学・
コンテキスト工学に続く第三の層として整理されつつある。レバレッジが
「プロンプトを書く人」から「プロンプトする仕組みを設計する人」へ移る潮流である。

gh-gantt を loop engineering の観点で見直すと、ハーネスの構成要素の多くを
**既に暗黙的に**備えていることが分かる。

| ハーネス要素                | gh-gantt の既存実装                                           |
| --------------------------- | ------------------------------------------------------------- |
| ツール層                    | `gh-gantt` CLI（list/pull/push/update/link/...）              |
| 状態永続（セッション跨ぎ）  | `.gantt-sync/tasks.json` + `sync-state.json`（snapshot/hash） |
| ガードレール（feedforward） | 各スキルの HARD-GATE（pull 未完で進行停止 等）                |
| センサー（feedback）        | dev-role の `verifyCommands`、CI、reviewer rubric             |
| サブエージェント分離        | dev-role の 5 ロール（ADR-014）                               |
| 構造化ハンドオフ            | `.dev-flow/NN-*.json` artifact（ADR-014）                     |
| 内側ループ + 停止条件       | dev-role の `maxImprovementIterations`                        |

つまり「1 タスクを実装・検証・レビューする**内側ループ**」は ADR-013 / ADR-014 で
よく設計済みである。一方で、**プロジェクト全体を回す外側ループ**
（タスクを選ぶ → 完了させる → 次を選ぶ、を繰り返す act-observe-decide-repeat）は
`skills/gh-gantt-workflow` の**散文としてしか存在しない**。

この散文依存により以下の弱さが残る。

- **観測不能** — どのイテレーションで何を決め、何が起きたかの実行ジャーナルがない
- **レジューム不能** — 会話が切れると「どこまで進んだか」を毎回 status から推測し直す
- **停止条件が曖昧** — 「ready タスクが尽きた」「人間ゲートが必要」「予算切れ」を
  形式的に判定できない
- **記憶依存** — LLM が散文を読んで手順を再構成する。ADR-010 が指摘した
  「個人の注意力やメモリに依存する」構造的脆さが外側ループに残っている

## Decision

外側ループを**第一級・コード駆動・観測可能・レジューム可能なハーネス**として
gh-gantt に組み込む。中核思想は loop engineering の原則どおり
「決定論的な部分（次に何をするかの選択・状態更新・停止判定）は CLI に寄せ、
創造的な部分（設計・実装）だけを LLM に残す」分離である。

段階的に導入し、各段階を別 Issue として管理する。

### 案B+C（MVP・本 ADR の中核）: ループ状態の永続化と停止条件の形式化

- `.gantt-sync/loop-state.json` に実行ジャーナルを持つ。
  `iterations[]`（`{ id, selectedTask, decision, startedAt, outcome,
verifyResults, reviewOutcome, stopReason }`）。これが観測可能性・
  セッション跨ぎレジューム・メトリクス（改善反復回数、停滞箇所）の基盤となる。
- このファイルは `tasks.json` / `sync-state.json` と同様に**直接編集禁止**とし、
  `gh-gantt loop` コマンド経由でのみ読み書きする（CLAUDE.md の同期データ規約に従う）。
- `Config` に `loop` セクションを追加し停止条件を形式化する。

  ```yaml
  loop:
    maxIterations: <number>
    stopWhen:
      - no_ready_tasks # ready が尽きた → 正常終了
      - conflicts_present # → gh-gantt-conflict-resolution へ移行
      - human_gate_required # → 人間に委譲
      - budget_exhausted
    onVerifyFailure: retry # nudge 予算 = dev-role の maxImprovementIterations と統一
  ```

- `gh-gantt loop status` で現在地（直近イテレーション・停止条件・次の ready）を 1 コマンド表示する。

### 案A（拡張1）: 外側ループドライバの自律化

`gh-gantt loop next` / `gh-gantt loop complete <id>` を導入し、1 イテレーション分の
observe（pull + status + conflict 検査）と decide（project-map の readiness 判定を
再利用して次タスク選定）を CLI 側で決定論的に実行する。出力は構造化された
"iteration plan"（今ターンやること + 関連 artifact）とし、LLM はこれを受けて
dev-role 内側ループを回し `complete` で 1 周を閉じる。外側ループは Claude Code の
`/loop`（自律モード）で駆動できる。

### 案D（拡張2）: センサー結線の明文化とループメトリクス

`verifyCommands` / executor gate（ADR-014）と外側ループを接続し、検証失敗を
「新規 Issue 化」ではなく「同一イテレーション内で `onVerifyFailure: retry`」として
扱うことを明文化する。Living Documentation の `req:trace → req:validate`（ADR-012）も
各反復内で 1 回実行し陳腐化を防ぐ。ジャーナルから停滞検出・改善反復ヒストグラム等の
メトリクスを `gh-gantt loop status` で提示する。

## Alternatives

### 散文のまま `gh-gantt-workflow` を強化する

skill の記述を充実させる案。コストは低いが、外側ループの状態が依然として
LLM の記憶・推測に依存する。ADR-010 で否定した「テキスト規律の構造的脆さ」を
外側ループに残すことになるため採らない。

### 外側ループも Claude Code hooks だけで制御する

hooks は「状態を検査してブロック」はできるが、イテレーション間の状態永続・
ジャーナル化・レジュームには向かない。また Claude Code 固有であり、
agent 非依存・project 非依存という gh-gantt の設計方針（ADR-014）に反する。
ハーネスの中核は製品 CLI 側に置く。

### 一気に案A〜D を実装する

外側ループドライバ・自律化・メトリクスを同時に入れる案。設計が固まらないまま
コマンド contract を確定させるリスクが高い。まず案B+C（状態 + 停止条件）で
観測とレジュームの土台を作り、contract を検証してから案A の自律化へ進む
（ADR-007 の stability-first phased roadmap に沿う）。

### loop-state を `.dev-flow/` に置く

dev-role の runtime artifact と同じ場所に置く案。しかし `.dev-flow/` は
issue 単位の一時 scratchpad であり、外側ループはプロジェクト横断・永続。
同期規律（CLI 経由のみ）を効かせるため `.gantt-sync/` 配下に置く。

## Consequences

- 外側ループが第一級になり、観測（`loop status`）・レジューム・メトリクスが可能になる。
  ADR-010 の「三層ワークフローガード」に対し、本 ADR は外側ループの状態を
  ガードする第四の柱を加える位置づけ。
- `gh-gantt-workflow` の外側ループ散文は、段階的に `gh-gantt loop` コマンド呼び出しへ
  置換していく。dev-role（内側ループ）は変更せず、停止条件のみ
  `onVerifyFailure` で外側と統一する。
- `.gantt-sync/loop-state.json` が新たな直接編集禁止ファイルとなる。
  CLAUDE.md の同期データ規約にこのファイルを追記する。
- `Config` 型に `loop` セクションが増えるため、`packages/shared` の型・Zod スキーマと
  `gantt.config.json` の更新が必要。後方互換のため `loop` は optional とする。
- MVP（案B+C）時点ではループ駆動は手動（LLM が `loop status` を見て判断）。
  自律化は案A まで保留する。段階間の contract 変更は本 ADR と
  `skills/gh-gantt-workflow` を更新して追従する。
