---
id: ADR-013
title: PR 後レビューサイクルを agent workflow として扱う
date: 2026-05-02
status: accepted
related_requirements:
  - NFR-STABILITY-005
---

## Context

PR 作成後、CodeRabbit / Copilot / 人間 reviewer からのコメントや
`changes requested` review が非同期で届く。CI が通っていても、レビューが
まだ処理中だったり、push 後に追加 thread が発生したりするため、PR 作成や
push をもって作業完了と扱うと見落としが発生する。

当初はこのレビューサイクルを gh-gantt の CLI 機能として実装する案があった。
しかし、対象となる正本は gh-gantt の task / Project データではなく GitHub PR
そのものであり、操作も GitHub の review thread / checks / review decision に
対するものだった。gh-gantt 製品 CLI に薄い wrapper を追加しても、実質的には
`gh` コマンドの再実装になり、責務境界が曖昧になる。

一方で、単に AGENTS.md や hooks の注意書きに頼るだけでは、Codex など hook を
実行できない agent や、セッションをまたいだ再開時に同じ見落としが再発する。
PR 後レビューサイクルは、gh-gantt 製品の機能ではなく、gh-gantt を開発する
agent workflow として標準化する必要がある。

## Decision

PR 後レビューサイクルは gh-gantt 製品 CLI ではなく、
`skills/gh-gantt-workflow` の agent workflow として扱う。
ADR-010 の 2026-05-02 追補は、この ADR によって supersede される。
PR 後レビューサイクルの責務境界と手順の正本は本 ADR と
`skills/gh-gantt-workflow` である。

- 正本は GitHub PR とし、状態確認は `gh pr view`, `gh pr checks`,
  `gh api graphql` で行う。
- `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh` を workflow 付属の
  標準スクリプトとし、PR 作成後・push 後・セッション開始時に実行する。
- セッション開始時・完了報告前の `--all-open` は現在ユーザー / 現在ブランチではなく
  リポジトリのオープン PR 全件を対象にする。ユーザーが特定 PR だけを明示した場合を除き、
  オープン PR が残っているなら全て確認する。
- script は未解決 review thread、`changes requested` review、pending または
  blocking check、PR activity の quiet window を確認し、レビュー面が安定する
  まで待つ。
- 詳細手順は `skills/gh-gantt-workflow/references/pr-review-cycle.md` に置く。
- レビュー対応結果は GitHub GraphQL の `addPullRequestReview` と
  `addPullRequestReviewThreadReply` で pending review に積み、
  `submitPullRequestReview` で 1 回だけ通知する。
- 対応済み thread の resolve は `resolveReviewThread` を GraphQL alias mutation
  としてまとめて実行する。
- この契約は `NFR-STABILITY-005` と `tests/workflow/review-cycle.test.ts` で
  trace する。

### 2026-07-08 追補: 補助層としての hooks の契約 (#307)

Alternatives の「hooks は補助に留め、正本は workflow skill と script に置く」を
具体的な契約に落とす。PR #304 で「PR 作成 = 完了」と誤認した完了報告が実際に
発生したため、ADR-010 の L2 (Claude Code hooks) にリマインダーと停止ゲートを
追加した。hooks が満たすべき契約は以下のとおり。

- hooks は正本である `pr-review-cycle-wait.sh` への**参照**（実行の督促・
  未対応項目の検出による停止ブロック）に限る。待機ロジック（quiet window /
  stable samples / タイムアウト）を hooks 側に再実装してはならない。
- Stop hook は `stop_hook_active` 再入時に即座に許可し、gh / git 不在や
  API 失敗時は静かに許可する（fail-open）。hooks はリマインドの層であり、
  環境非依存の強制は ADR-019（loop complete の PR evidence ゲート）が担う。
- `tests/workflow/review-cycle.test.ts` の trace は「hooks が script に言及
  しない」ではなく「hooks が待機ロジックを再実装せず、再入・fail-open が
  保証されている」ことを検証する。

### 2026-07-21 追補: PR scope-selection の部分 supersede (#324)

Decision と Consequences にある、セッション開始時・完了報告前にリポジトリの
オープン PR 全件を `--all-open` で確認する記述は、当時の**歴史的な契約**であり、
現行契約ではない。[ADR-020](ADR-020-bounded-agent-workflow-scope.md) が本 ADR の
scope-selection 部分だけを supersede する。

現行の default は現在タスクの PR であり、`--pr <number>` または `--current-branch` で
確認する。repository-wide `--all-open` audit はユーザーが明示した場合だけの
明示的な opt-in とする。未解決 thread、checks、quiet window、stable samples、
GraphQL による返信・resolve、PR review 操作を製品 CLI に追加しない責務境界は、
本 ADR の決定を引き続き正本とする。

## Alternatives

### gh-gantt CLI に review-cycle コマンドを追加する

PR review thread / checks / review decision は GitHub PR の状態であり、
gh-gantt の Project 同期モデルの一部ではない。CLI に wrapper を追加すると
`gh pr view` / `gh pr checks` / `gh api graphql` の薄い再包装になり、製品 CLI の
責務が「GitHub Projects の AI 向け操作面」から PR workflow automation へ拡散する。
既存の `gh` が十分な API 面を持っているため採用しない。

### Claude hooks に閉じ込める

Claude Code hooks は特定の tool 呼び出し直前にリマインドやブロックを挟むには
有効だが、PR 作成後に非同期で届くレビューコメントを継続監視する保証にはならない。
Codex など hooks を実行できない agent もあるため、hooks を正本にすると運用が
特定 agent に依存する。hooks は補助に留め、正本は workflow skill と script に置く。

### Durable cron / 別 skill で自動監視する

セッションをまたいだ監視を自動化できる利点はあるが、まず必要なのは
gh-gantt 利用者が再現できる最小の標準手順である。durable automation は
実行基盤や通知方法に依存し、gh-gantt の汎用 skill として配布しにくい。
将来導入する場合も、この ADR の workflow contract を土台にした拡張として扱う。

### 手動で PR 画面を確認する

人間が PR 画面を見れば一時的には確認できるが、AI agent の作業では
「PR 作成で完了扱い」「push 後の追加コメント見落とし」「別セッションでの再開時に
未処理 PR を忘れる」という事故が再発する。レビューサイクルは手順化し、
quiet window と未解決 thread の検出を機械的に行う必要がある。

## Consequences

- gh-gantt 製品 CLI に PR review 専用コマンドを増やさず、CLI の責務境界を保てる。
- `gh` が利用可能で、GitHub token が有効であることが workflow の前提になる。
- GitHub GraphQL の review API 仕様に依存するため、script と reference の
  継続メンテナンスが必要になる。
- PR 作成後・push 後・セッション開始時の確認が明示的になり、レビューコメントの
  見落としを要件トレーサビリティ付きで検出できる。
- 完了報告前にリポジトリのオープン PR 全件を sweep するため、現在ブランチの PR だけを
  clean と見て別 PR の未解決 thread を残す事故を減らせる。
- CodeRabbit の rate limit や review processing のような非同期状態は完全には
  同期化できない。quiet window と timeout によって「十分に安定した状態」を
  workflow 上の完了条件として扱う。
