---
name: gh-gantt-progress
description: Use when updating task states, finding tasks to close, checking implementation status, or asking about project progress. Triggers on progress checks, task updates, overdue tasks, forgotten-to-close, task hygiene, or what to work on next.
---

# gh-gantt Progress

プロジェクトの進捗確認とタスク状態の管理を行う。

## 共通ステップ

### Step 1: 同期

`gh-gantt-sync`（pull）を invoke する。

### Step 2: オープンタスク一覧の bounded evidence

```bash
gh-gantt list --state open --json \
  | node skills/gh-gantt-workflow/scripts/project-task-list-evidence.mjs
```

共通 helper で各 task を `id`, `github_issue`, `title`, `status`, `state` のみに射影し、
既定 50 件と `total`, `limit`, `truncated`, `tasks` を提示する。project の Status field 名が
異なる場合は `--status-field <name>` を指定する。`truncated: true` なら search/filter で候補を
絞り込み、task body は候補を絞り込んだ後に `gh-gantt show <id>` で取得する。
body を含む全件 export は、ユーザーが exhaustive audit を明示した場合だけ opt-in で行う。
context budget を指定する場合は helper に `--limit <n>` を渡す。limit の優先順位は
`project workflow の指定 > ユーザーの明示指定 > default 50` とする。

### Step 3: ユーザーの意図に応じた分岐

ユーザーの指示に応じて適切なフローに進む。不明確な場合は ABC 形式で選択肢を提示する。
ユーザーに質問するためのツール（AskUserQuestion 等）が利用可能な場合はそれを使う。

| 指示の例                                                       | フロー                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 「タスクを更新して」「閉じ忘れはある？」「実装状態を把握して」 | → [task-state-update.md](references/task-state-update.md) を読んで実行 |
| 「次に何をすべき？」「次のタスクは？」                         | → [next-task.md](references/next-task.md) を読んで実行                 |
| 「タスクを整理して」「バックログを整理」                       | → [task-hygiene.md](references/task-hygiene.md) を読んで実行           |
| 「エピック進捗は？」                                           | → エピック進捗（後述）                                                 |
| 「リスクは？」「遅れてるタスクは？」                           | → リスク評価（後述）                                                   |

## エピック進捗

`gh-gantt list --state open --type epic --json | node skills/gh-gantt-workflow/scripts/project-task-list-evidence.mjs` で bounded なエピック一覧を表示し、各エピックについて `gh-gantt show <id>` で子タスクの完了率を確認する。helper の `--limit <n>` / `--status-field <name>` と共通ステップの優先順位を維持する。

## リスク評価

Step 2 の一覧から期限が近いタスクを特定し、`gh-gantt show <id>` でブロッカーや進捗を確認する。

## リファレンス

- コマンド詳細: [commands.md](../gh-gantt-workflow/references/commands.md)
