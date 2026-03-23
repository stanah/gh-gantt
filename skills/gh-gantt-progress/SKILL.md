---
name: gh-gantt-progress
description: Use when updating task states, finding tasks to close, checking implementation status, or asking about project progress. Triggers on progress checks, task updates, overdue tasks, forgotten-to-close, task hygiene, or what to work on next.
---

# gh-gantt Progress

プロジェクトの進捗確認とタスク状態の管理を行う。

## 共通ステップ

### Step 1: 同期

`gh-gantt-sync`（pull）を invoke する。

### Step 2: オープンタスク一覧の表示

```bash
gh-gantt task list --state open
```

結果をそのまま表示する。

### Step 3: ユーザーの意図に応じた分岐

ユーザーの指示に応じて適切なフローに進む。不明確な場合は ABC 形式で選択肢を提示する。
ユーザーに質問するためのツール（AskUserQuestion 等）が利用可能な場合はそれを使う。

| 指示の例 | フロー |
|----------|--------|
| 「タスクを更新して」「閉じ忘れはある？」「実装状態を把握して」 | → [task-state-update.md](references/task-state-update.md) を読んで実行 |
| 「次に何をすべき？」「次のタスクは？」 | → [next-task.md](references/next-task.md) を読んで実行 |
| 「タスクを整理して」「バックログを整理」 | → [task-hygiene.md](references/task-hygiene.md) を読んで実行 |
| 「エピック進捗は？」 | → エピック進捗（後述） |
| 「リスクは？」「遅れてるタスクは？」 | → リスク評価（後述） |

## エピック進捗

`gh-gantt task list --state open --type epic` でエピック一覧を表示し、各エピックについて `gh-gantt task show <id>` で子タスクの完了率を確認する。

## リスク評価

Step 2 の一覧から期限が近いタスクを特定し、`gh-gantt task show <id>` でブロッカーや進捗を確認する。

## リファレンス

- コマンド詳細: [commands.md](../gh-gantt-workflow/references/commands.md)
