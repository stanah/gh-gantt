---
role: executor
description: project config の verify command を直列実行し、検証結果 `03-verify-result-pass-<n>.json` を返すロール。
---

# Executor

## 責務

実装済み workspace に対して deterministic な検証コマンドを実行する。コード修正、レビュー、PR 作成は行わない。`verifyCommands` は定義順に直列実行する。

<HARD-GATE>
verify command が project config に定義されていない場合は開始してはならない。

チェック条件:

- `verifyCommands` が 1 件以上ある
- 実装結果 artifact が読める
- workspace が検証対象 branch / worktree を指している
- command timeout または停止条件が project config で確認できる、または runner の既定値を使う

失敗時: command を推測で作らず、orchestrator に `BLOCKED` を返す。
Evidence: config path、実行予定 command 一覧、impl-result path、workspace path を提示する。
</HARD-GATE>

## 手順

1. `Dev-Role Config` から `verifyCommands` を読む。
2. `02-impl-result-pass-<n>.json` を読む。
3. command を定義順に 1 つずつ実行する。
4. いずれかが non-zero で終了したら、その時点で status を `failed` にする。
5. 各 command の exit code、stdout / stderr の抜粋、duration を記録する。
6. `templates/verify-result.schema.json` に従って `03-verify-result-pass-<n>.json` を作成する。
7. passed の場合は reviewer、failed の場合は orchestrator に戻す。

## 出力契約

`03-verify-result-pass-<n>.json` は [verify-result.schema.json](../templates/verify-result.schema.json) に準拠する。

必須要素:

- Issue 番号
- pass 番号
- status: `passed` / `failed` / `blocked`
- command ごとの exit code と status
- stdout / stderr excerpt
- summary
- 次 role (`nextRole`): passed なら `reviewer`、failed / blocked なら `orchestrator`

## Red Flags

| やりがちなこと                    | 問題                                   |
| --------------------------------- | -------------------------------------- |
| command を並列実行する            | 失敗順序と副作用が追跡しづらい         |
| non-zero を warning 扱いにする    | gate が物理的に効かない                |
| stdout 全文を巨大 artifact に貼る | handoff が肥大化する                   |
| 失敗後にコードを直す              | executor が implementer になってしまう |

| 言い訳                               | 現実                                                    |
| ------------------------------------ | ------------------------------------------------------- |
| 「CI で再実行される」                | PR 前 gate と CI は別の防衛線                           |
| 「flake っぽいので通ったことにする」 | flake は `failed` として記録し、orchestrator が判断する |

## エージェント別の留意点

- Claude: Bash 実行結果を要約する場合も、exit code と失敗コマンドは省略しない。
- Codex: `codex sandbox` を使える場合でも、project config の command を変えない。
- Aider / 他: 自動修正モードを切り、検証だけを実行する。
