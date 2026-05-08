# gh-gantt 側の未解決論点決定

> 作成日: 2026-05-08
> 対象: `gh-gantt-dev-role` Phase alpha scaffold
> 前提: `100-handoff-to-gh-gantt.md` の 11 論点を、設計詳細と実装に入る前に順番に決定する。

## 1. skill 名

**決定**: `gh-gantt-dev-role` とする。

`gh-gantt-role` は将来の非開発ロールにも読めるため、今回の責務である「開発フロー上のロール分離」を名前に残す。既存の `gh-gantt-workflow` / `gh-gantt-pr` と並べたときも、PR 作成や同期ではなく development role の補助であることが明確になる。

## 2. agent 別の指示の書き方

**決定**: reference 本文はエージェント非依存を正本にし、Claude / Codex / Aider などの差分は各 reference の「エージェント別の留意点」に限定する。

特定 agent の CLI や tool は「利用可能な場合の選択肢」として書き、role の合格条件にはしない。Project 側の `Dev-Role Config` が特定コマンドを指定した場合だけ、その project の必須手順として扱う。

## 3. 改善ループの実装位置

**決定**: `improver` 専任 role は作らず、`orchestrator` が reviewer findings を統合して `implementer` を再呼び出す。

artifact は pass 番号で区別する。例: `02-impl-result-pass-1.json`, `04-review-pass-1.json`, `05-impl-result-pass-2.json`。これにより 5 role 方針を崩さず、ChatDev / Reflexion 型の改善ループだけを取り込む。

## 4. Termination Judge の責任

**決定**: `orchestrator` が Termination Judge を兼務する。

終了条件は deterministic rule を優先する。既定値は `maxImprovementIterations: 3`、`maxExecutorRetries: 2`、executor pass、reviewer verdict、critical finding の有無で判定する。別 role 化は Phase alpha では行わない。

## 5. investigator ロール

**決定**: 常設 role には含めない。

調査は `planner` の責務に含める。並列調査が必要な場合は `orchestrator` が read-only の一時調査 agent を起動してもよいが、その結果は `01-plan.json` または `99-orchestrator-decision.md` に要約してから次 role に渡す。

## 6. コスト予算管理

**決定**: 予算は project config で任意指定し、`orchestrator` が上限を解釈する。

Phase alpha の標準キーは `maxImprovementIterations`, `maxExecutorRetries`, `maxWallClockMinutes`, `tokenBudget` とする。未指定時は iteration 上限だけを既定値として扱い、token や時間の強制は project 側の agent / runner が対応できる場合に限る。

## 7. 失敗 Issue のリトライ戦略

**決定**: `orchestrator` の最終出力に `BLOCKED` / `ESCALATED` を明示する。

executor が連続失敗した、plan に必要情報がない、reviewer が critical finding を残した、または予算を超過した場合は PR 化せず `99-orchestrator-decision.md` に原因・再開条件・次アクションを書く。Issue ラベルや status 更新は project workflow の責務とし、この skill は無断で GitHub 状態を書き換えない。

## 8. `.dev-flow/<issue#>/` の扱い

**決定**: runtime artifact は既定で gitignore する。

`.dev-flow/` はセッション間 handoff の scratchpad であり、PR diff の正本にはしない。必要な project は `.dev-flow/.gitkeep` だけを例外的に commit してもよい。skill 側で commit するのは schema / reference / rubric template までに留める。

## 9. `Dev-Role Config` 仕様

**決定**: 正本は `.gantt-sync/workflow.md` 内の `## Dev-Role Config` セクションに置く。gh-gantt を使わない project だけ `.dev-flow/config.json` を fallback として使える。

`.gantt-sync/` の同期データ (`tasks.json`, `sync-state.json`) は読まない。`workflow.md` は project 固有の設定ファイルとして既存 skill と同じ扱いにする。設定例は fenced YAML とし、JSON Schema は `templates/dev-role-config.schema.json` に置く。

## 10. rubric の標準テンプレ

**決定**: gh-gantt 側に default rubric template を提供し、project config の `reviewerRubricPath` で上書きできるようにする。

project 固有のセキュリティ、ドメイン、UI 品質観点は project rubric を優先する。未指定時は `skills/gh-gantt-dev-role/templates/review-rubric.md` を使う。

## 11. 複数 verify command の並列実行

**決定**: Phase alpha は直列固定にする。

executor は `verifyCommands` を定義順に実行し、最初の失敗で fail として記録する。並列化は command の副作用やログ順序が不透明になりやすいため、将来の config 拡張までは扱わない。
