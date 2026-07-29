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
9. review artifactをSafety preflight precedenceで検証する。critical findingが1件でもあればdeclared verdictに
   関係なく`ESCALATED`とする。
10. criticalがない場合も、required evidence missing、verify-result inconsistency、またはverdict/finding semantic
    contract mismatchがあれば、通常verdict edgeより先に`BLOCKED`とする。
11. preflight通過後だけReviewer verdict operationを適用する。schema-valid `comment`はminor / nitだけ、
    `approve`はfindings empty、`request-changes`はmajorまたはplan/implementation mismatchを要求する。
12. 改善budget超過時に`request-changes`が残ればseverityだけで`comment`へ降格せず`BLOCKED`とし、
    `block`はblocking reason/evidenceを保持して`BLOCKED`とする。
13. 終了条件を判定する。
14. PR 作成に進める場合は `gh-gantt-pr` または project の `prCreator` に引き継ぐ。
15. PR 作成後は `gh-gantt-workflow` の PR 後レビューサイクルを開始する。
16. 最終判断を `99-orchestrator-decision.md` に保存する。

## Project Contract Discovery

`.gantt-sync/workflow.md`にproject-owned Graph Contractセクションや設計文書への参照がある場合は、
そのrole transitionとbudget規則を正典として各artifactとevidenceを検証してからedgeを選ぶ。
project contractがない場合も必須human gateと独立executor/reviewerをbypassしない。終了結果は
`BLOCKED`、`ESCALATED`、`READY_FOR_PR`、`CONDITIONAL_HANDOFF`、`COMPLETED`のいずれかとする。

### Safety preflight precedence

| priority | condition                                  | declared verdict       | result                    | evidence                            |
| -------- | ------------------------------------------ | ---------------------- | ------------------------- | ----------------------------------- |
| 1        | critical finding present                   | approve                | ESCALATED                 | critical finding evidence           |
| 1        | critical finding present                   | comment                | ESCALATED                 | critical finding evidence           |
| 1        | critical finding present                   | request-changes        | ESCALATED                 | critical finding evidence           |
| 1        | critical finding present                   | block                  | ESCALATED                 | critical finding evidence           |
| 2        | required evidence missing                  | any                    | BLOCKED                   | missing evidence list               |
| 2        | verify-result inconsistency                | any                    | BLOCKED                   | verification inconsistency evidence |
| 2        | verdict/finding semantic contract mismatch | any                    | BLOCKED                   | semantic validation evidence        |
| 3        | all safety guards passed                   | contract-valid verdict | apply normal verdict edge | validated review artifact           |

### Reviewer verdict operation

| verdict         | guard                                                                                   | action                               | status              |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------ | ------------------- |
| approve         | contract-valid + findings empty                                                         | human / PR                           | READY_FOR_PR        |
| comment         | contract-valid + minor/nit only                                                         | preserve remaining findings evidence | CONDITIONAL_HANDOFF |
| request-changes | contract-valid + (major or plan/implementation mismatch) + improvement budget available | implementer improvement              | IMPROVE             |
| request-changes | contract-valid + (major or plan/implementation mismatch) + improvement budget exhausted | waiting_human                        | BLOCKED             |
| block           | contract-valid + blocking reason/evidence + no critical                                 | waiting_human                        | BLOCKED             |

## 出力契約

`99-orchestrator-decision.md` に以下を含める。

- `status`: `READY_FOR_PR` / `CONDITIONAL_HANDOFF` / `BLOCKED` / `ESCALATED` / `COMPLETED`
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
