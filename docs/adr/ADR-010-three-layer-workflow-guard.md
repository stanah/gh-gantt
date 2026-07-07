---
id: ADR-010
title: lefthook + Claude Code hooks による三層ワークフローガード
date: 2026-04-12
status: accepted
---

## Context

PR のたびに CI 失敗やレビュー指摘が繰り返し発生していた。具体的には:

- lefthook と CI の間にチェックのギャップがあり、ローカルで通っても CI で落ちる
  (req:trace 未実行、docs:gen 未実行等)
- CLAUDE.md に記載されたレビュー規律がテキストのみで強制力がなく、
  エージェントがスキップしてもフィードバックがない
- マージ済みブランチへのコミットや PR 状態未確認での作業開始など、
  状態確認漏れによるミスが発生

これらの問題に共通する根本原因は「個人の注意力やメモリに依存している」こと。
CLAUDE.md のテキスト規律は「読んだエージェントが従う」前提であり、構造的に脆い。
同じ問題は人間の開発者にも、異なる AI エージェントにも等しく発生する。

## Decision

問題を 3 つのレイヤーに分類し、各レイヤーを最適なツールで強制する
「三層ワークフローガード」を導入する。

- L1 (git 操作ゲート): lefthook の pre-commit / pre-push で CI と同等の
  チェックを自動実行する。ブランチ状態チェック (main 直接コミット防止、
  マージ済みブランチ検出) も pre-commit に含める。
  test:json / build / req:trace / req:validate / docs:gen の全ステップを
  pre-push で実行し、CI との差分をゼロにする。

- L2 (エージェント行動ゲート): Claude Code の hooks 機能
  (.claude/settings.json) を使い、git commit / git push / gh pr create の
  ツール呼び出し前にチェックを挟む。
  機械検査可能なもの (ブランチ状態) は command + exit 2 でブロックし、
  機械検査不可能なもの (レビュー実施済みか) は prompt でリマインドを注入する。
  L1 の lefthook は人間向け、L2 の hooks はエージェント向けの二重防御となる。

- L3 (コード品質ルール): CLAUDE.md のテスト名規約を実態に合わせて修正する。
  全テストにプレフィックスを要求する記述を改め、要件トレーサビリティテスト
  ([FR-*]/[NFR-*]) とリグレッションテスト ([Issue #N]) にのみプレフィックスを
  要求する。ユニットテストにはプレフィックス不要。
  カスタム lint スクリプトは作成しない (req:trace + req:validate で既に
  機械検証されているため)。

### 2026-05-02 追補: PR 後フィードバックループ

三層ガードは commit / push / PR 作成前の事故を減らすが、PR 作成後に非同期で届く
レビューコメントを検出・対応・投稿するサイクルは別のガードとして扱う。
これは gh-gantt の製品 CLI ではなく、GitHub PR に対する agent workflow である。

この追補は問題領域の識別に留め、手順と責務境界の正本は
[ADR-013: PR 後レビューサイクルを agent workflow として扱う](ADR-013-pr-review-cycle-as-agent-workflow.md)
に委譲する。以後、PR 後レビューサイクルの待機条件、オープン PR 全件確認、返信、resolve
手順を変更する場合は ADR-013 と `skills/gh-gantt-workflow` を更新する。

### 2026-07-08 追補: PR 後レビューサイクルの L2 強制 (#307)

PR #304 で「PR 作成 = 完了」と誤認したまま完了報告する事象が実際に発生した。
ADR-013 の手順は skill の散文にしか存在せず、長いセッションでは指示の顕著性が
低下してスキップされる — 本 ADR の Context が挙げた「テキスト規律の構造的な
脆さ」の再演である。そこで L2 を PreToolUse 以外へ拡張する。

- **PostToolUse (.claude/hooks/post-pr-create-reminder.sh)**: PR 作成直後に
  「PR 作成は完了ではなくレビュー監視の開始である」リマインダー
  (pr-review-cycle-wait.sh の実行、同一 PR への追加コミット対応、完了報告前の
  --all-open) を stderr + exit 2 でエージェントに注入する。
  **Claude Code の matcher はツール名にしかマッチしない**ため、matcher は
  `"Bash"` とし、`gh pr create` の判定は hook スクリプトが stdin の
  `tool_input.command` に対して行う（コマンド先頭または `;` `&` `|` 直後のみ
  対象。コマンド文字列の引数内に `&& gh pr create` を含む稀なケースでは
  誤発火するが、無害なリマインダーであるため許容する）。
- **Stop hook (.claude/hooks/stop-pr-review-cycle.sh)**: セッション終了時に
  現在ブランチのオープン PR を確認し、CHANGES_REQUESTED または未解決
  review thread が残っていれば停止をブロックして対応手順を提示する。
  `stop_hook_active` による再入時は即座に許可し無限ループを防ぐ。
  gh / git 不在・main ブランチ・PR なし・API 失敗時は静かに許可する
  (fail-open)。ここで fail-open を選ぶのは、hook はリマインドの層であり、
  環境非依存の強制は [ADR-019: loop complete の PR evidence ゲート](ADR-019-loop-complete-pr-evidence-gate.md)
  が担うという二層分担のためである。

この層の既知の限界: (1) hooks は Claude Code 固有であり、hook を実行できない
環境 (Codex 等) では効かない。(2) Stop hook は「PR 作成直後でレビューがまだ
届いていない window」では未対応項目が存在しないため素通しする — この window
の防御は PostToolUse リマインダーと ADR-019 の CLI 側ゲートが担う。
(3) 両 hook のコマンド判定・再入判定は python3 に依存し、python3 不在の
環境では静かに無効化される (fail-open)。
いずれの環境・タイミングでも効く防衛線は ADR-019 である。

なお本追補の実装時に、既存の PreToolUse 3 エントリの matcher
(`"Bash(git commit*)"` 等) がツール名にマッチせず一度も発火していなかった
ことが判明した (#310)。

### 2026-07-08 追補: 既存 PreToolUse エントリの修正 (#310)

上記 3 エントリを matcher `"Bash"` + `.claude/hooks/pre-bash-guard.sh`
(stdin の `tool_input.command` による判定) に集約し、実際に発火する形へ修正した。

- **機械検査可能なチェックは維持**: main ブランチへの直接コミット防止、
  マージ済みブランチへの誤コミット・誤 push 検出 (fork 由来の同名ブランチを
  誤検出しないよう headRepositoryOwner で絞り込む)。
- **prompt 型の advisory チェックリスト (コミット前・PR 作成前) は廃止**:
  prompt 型はコマンドで発火条件を絞れないため、matcher を `"Bash"` にすると
  全 Bash 呼び出しでチェックリストが注入されてしまう。これらの advisory は
  もともと workflow.md の `before_commit` フック・gh-gantt-workflow /
  dev-role の手順・L1 (lefthook pre-push が CI 同等チェックを強制) と重複して
  おり、L2 で二重化する必然性がない。本 ADR の「機械検査不可能なものは
  prompt でリマインド」という設計前提は、prompt 型が per-command で
  発火できないという実仕様の制約により、この用途では成立しなかったと記録する。

## Alternatives

### Claude Code hooks のみで全レイヤーをカバーする

hooks の command タイプは「状態を検査してブロック」は可能だが、
「レビューを実施したか」のようなエージェントの行動履歴は検査できない。
結果として prompt 注入に頼る部分が多くなり、CLAUDE.md テキストと
同じ弱さが残る。また hooks は Claude Code 固有のため、人間の開発者には
効かない。lefthook との二層分離が必要。

### ワークフロースクリプト統合型 (scripts/ に共通スクリプトを切り出す)

lefthook と hooks の両方から共通スクリプトを呼ぶ方式。ロジックが一箇所に
集約される利点があるが、prompt タイプ (リマインド注入) はスクリプトに
切り出せないため settings.json にも書く必要があり、管理箇所が増える。
hooks の数が少ない現時点ではオーバーエンジニアリング。

### テスト名プレフィックスのカスタム lint を作成する

全テストにプレフィックスを強制するのは不適切。プレフィックスが必要な
テスト (要件トレーサビリティ・リグレッション) は req:trace + req:validate
で既に機械検証されている。ユニットテストにプレフィックスを強制する
lint ルールは保守コストに見合わない。

## Consequences

- lefthook pre-push の実行時間が約 13 秒 (従来 12 秒から +1 秒)
- .claude/settings.json がリポジトリにコミットされるため、Claude Code を
  使わない開発者にとっては不要なファイルが増える (.gitignore 対象外)
- prompt タイプの hooks はエージェントへのリマインドであり完全な強制ではない。
  エージェントが無視する可能性はゼロではないが、CLAUDE.md テキストと比べ
  ツール呼び出しの直前に毎回注入される点で実効性は大幅に向上する
- L1 と L2 でブランチ状態チェックが二重実行されるが、実行時間は無視できる程度
  であり、防御の冗長性として許容する
