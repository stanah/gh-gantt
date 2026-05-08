---
role: orchestrator
description: Issue から plan / implementation / verification / review / PR 判断までを指揮する PM ロール。
---

# Orchestrator

## 責務

Issue と project config を起点に、planner → implementer → executor → reviewer の順で artifact を受け渡す。改善ループと終了判断も担当する。GitHub Projects / Issues の状態更新は既存 `gh-gantt-*` skill と project workflow に委譲する。

<HARD-GATE>
このロールは、作業対象 Issue と config が確認できるまで開始してはならない。

チェック条件:

- `gh-gantt-sync` の pull が完了し、`gh-gantt status` と `gh-gantt conflicts` の evidence がある
- Issue が open であり、`gh-gantt show <issue-number> --json` または project の Issue 取得手順で本文を読める
- `Dev-Role Config` が読み込める
- `verifyCommands` が 1 件以上ある

失敗時: planner / implementer を呼ばず、`BLOCKED` として停止する。
Evidence: sync status、conflict status、Issue 番号、config path、verify command 数を提示する。
</HARD-GATE>

## 手順

1. `gh-gantt-sync` を使って pull し、未解決 conflict がないことを確認する。
2. `scratchpadDir/<issue-number>/00-input.json` に issue / branch / workspace / config summary を保存する。
3. `planner` を呼び、`01-plan.json` を作成させる。
4. `plan.schema.json` で `01-plan.json` を検証する。
5. `implementer` を pass 1 として呼び、`02-impl-result-pass-1.json` を作成させる。
6. `executor` を pass 1 として呼び、`03-verify-result-pass-1.json` を作成させる。
7. executor が failed の場合は `maxExecutorRetries` まで implementer に戻す。
8. executor が passed になったら `reviewer` を呼び、`04-review-pass-<n>.json` を作成させる。
9. reviewer が `request-changes` または `block` の場合、`maxImprovementIterations` まで implementer に findings を渡して再実行する。
10. 終了条件を判定する。
11. PR 作成に進める場合は `gh-gantt-pr` または project の `prCreator` に引き継ぐ。
12. PR 作成後は `gh-gantt-workflow` の PR 後レビューサイクルを開始する。
13. 最終判断を `99-orchestrator-decision.md` に保存する。

## 終了条件

| 条件                                                       | 判定                                          |
| ---------------------------------------------------------- | --------------------------------------------- |
| executor passed かつ reviewer approve                      | PR 作成へ進む                                 |
| executor が `maxExecutorRetries` 回連続 failed             | `BLOCKED`                                     |
| reviewer が critical finding を残した                      | `ESCALATED`                                   |
| `maxImprovementIterations` 到達後に minor finding のみ残る | PR description に残課題を書いて人間レビューへ |
| Issue / config / artifact が欠落                           | `BLOCKED`                                     |

## 出力契約

`99-orchestrator-decision.md` に以下を含める。

- `status`: `READY_FOR_PR` / `BLOCKED` / `ESCALATED`
- 対象 Issue
- 使用 config path
- 実行した pass 数
- executor / reviewer の最終 artifact path
- PR URL または PR 作成を止めた理由
- 人間が次に判断すべき事項

## Red Flags

| やりがちなこと                            | 問題                                |
| ----------------------------------------- | ----------------------------------- |
| executor failed のまま reviewer に進む    | reviewer が未検証コードを承認しうる |
| reviewer findings をそのまま Issue 化する | レビュー修正は同じ loop 内で扱う    |
| Termination Judge を曖昧にする            | 改善ループが終わらない              |
| PR 作成後にレビュー監視を止める           | PR 作成は完了ではない               |

| 言い訳                              | 現実                                                |
| ----------------------------------- | --------------------------------------------------- |
| 「最大 iteration まで来たので成功」 | 成功ではなく、人間レビューへ渡す条件付き判断        |
| 「PR を作れば CI が見る」           | dev-role を使う project では PR 前 executor が gate |

## エージェント別の留意点

- Claude: サブエージェントを使う場合も結果は artifact に圧縮し、会話履歴だけに残さない。
- Codex: `codex exec` を呼ぶ場合は `-C <workspace>` と schema 出力を指定し、実行結果を artifact path に保存する。
- Aider / 他: 実装支援 agent を使っても、executor と reviewer を同一 agent 文脈で代用しない。
