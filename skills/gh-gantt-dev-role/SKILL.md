---
name: gh-gantt-dev-role
description: 開発フローを orchestrator / planner / implementer / executor / reviewer の5ロールに分離し、構造化artifactと独立検証ゲートで PR 前品質を管理する。
---

# gh-gantt Dev Role

`gh-gantt-workflow` の「設計・実装・検証」部分を、エージェント非依存の role reference に分けて実行する二次スキル。既存の `gh-gantt-sync`, `gh-gantt-decompose`, `gh-gantt-pr`, `gh-gantt-workflow` は置き換えず、必要な場面でチェーンする。

## 入力

- `role`: `orchestrator` / `planner` / `implementer` / `executor` / `reviewer` のいずれか
- `issue`: Issue 番号。`orchestrator` と `planner` では必須
- `workspace`: 作業ディレクトリ。未指定なら現在の repository root
- `input`: role に渡す artifact path。例: `01-plan.json`, `03-verify-result.json`
- `pass`: improvement loop の pass 番号。未指定なら `1`

例:

```text
gh-gantt-dev-role role=executor issue=123 workspace=/path/to/repo input=.dev-flow/123/02-impl-result-pass-1.json
```

## Config Discovery

次の順に project config を探す。

1. `.gantt-sync/workflow.md` の `## Dev-Role Config` セクション
2. `.dev-flow/config.json`

`.gantt-sync/tasks.json` と `.gantt-sync/sync-state.json` は読んではならない。同期データは常に `gh-gantt` CLI 経由で扱う。

`Dev-Role Config` の最小形:

```yaml
verifyCommands:
  - "pnpm check"
  - "pnpm test"
reviewerRubricPath: "docs/orchestration/review-rubric.md"
scratchpadDir: ".dev-flow"
maxImprovementIterations: 3
maxExecutorRetries: 2
branchNaming: "codex/issue-{number}-{slug}"
prCreator: "gh pr create"
```

設定の詳細は [dev-role-config.schema.json](templates/dev-role-config.schema.json) を参照する。

<HARD-GATE>
このスキルを実行する前に、role と project config と入力 artifact を検証する。

チェック条件:

- `role` が `orchestrator` / `planner` / `implementer` / `executor` / `reviewer` のいずれかである
- `.gantt-sync/workflow.md` の `## Dev-Role Config` または `.dev-flow/config.json` が存在する
- `input` が指定された場合、対応する `templates/*.schema.json` に合う artifact である
- `executor` と `reviewer` は `verifyCommands` が 1 件以上定義されている

失敗時: 実装や PR 作成に進まず、欠落している config / artifact / role 名を明示して停止する。
Evidence: 読み込んだ config path、role 名、検証した artifact path、参照 schema を提示する。
</HARD-GATE>

## Role Dispatch

1. `role` を検証する。
2. Config Discovery を実行する。
3. 対応する reference を読む。
   - `orchestrator` → [orchestrator.md](references/orchestrator.md)
   - `planner` → [planner.md](references/planner.md)
   - `implementer` → [implementer.md](references/implementer.md)
   - `executor` → [executor.md](references/executor.md)
   - `reviewer` → [reviewer.md](references/reviewer.md)
4. reference の HARD-GATE を満たしてから role を実行する。
5. 出力を `scratchpadDir/<issue-number>/` に schema 準拠で保存する。

## 共通 Artifact

| ファイル                         | 作成 role    | schema                                                                                             |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `00-input.json`                  | orchestrator | [dev-role-config.schema.json](templates/dev-role-config.schema.json) の project 情報を含む任意入力 |
| `01-plan.json`                   | planner      | [plan.schema.json](templates/plan.schema.json)                                                     |
| `02-impl-result-pass-<n>.json`   | implementer  | [impl-result.schema.json](templates/impl-result.schema.json)                                       |
| `03-verify-result-pass-<n>.json` | executor     | [verify-result.schema.json](templates/verify-result.schema.json)                                   |
| `04-review-pass-<n>.json`        | reviewer     | [review.schema.json](templates/review.schema.json)                                                 |
| `99-orchestrator-decision.md`    | orchestrator | Markdown                                                                                           |

## Red Flags

| やりがちなこと                                 | 問題                                   |
| ---------------------------------------------- | -------------------------------------- |
| executor を通さず reviewer / PR 作成へ進む     | 「動作確認なしマージ」の再発になる     |
| implementer が自分の判断で verifier を省略する | ロール分離の意味がなくなる             |
| `.gantt-sync/tasks.json` を直接読む            | gh-gantt の同期状態を壊す可能性がある  |
| runtime artifact を無条件に commit する        | セッション固有ログが PR の正本に混ざる |
| reviewer が rubric なしで承認する              | Yes-Man reviewer になりやすい          |

| 言い訳                               | 現実                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- |
| 「テストは実装者が見たはず」         | executor の独立した実行結果がない限り gate 未通過                     |
| 「小さい変更だから role 分離は不要」 | config で dev-role を選んだ project では最小でも executor gate が必要 |
| 「rubric がないので雰囲気で見る」    | default rubric を使う。project 固有観点が必要なら config で上書きする |
