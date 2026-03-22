---
name: gh-gantt-progress
description: プロジェクトの進捗を評価しアクションを提案する。エピック進捗、遅延検出、リスク評価、次タスクの提案。「進捗は？」「プロジェクトの状態は？」「遅れてるタスクは？」「次に何をすべき？」で使用。
---

# gh-gantt Progress

プロジェクト全体の進捗を評価し、アクションを提案する。

## 分析項目

- **エピック進捗率** — 子タスクの完了数 / 全体数
- **遅延タスク** — `end_date` が過去なのに open
- **リスク評価** — 期限が近いが未着手のタスク
- **ブロッカー停滞** — `blocked_by` が open のまま放置されているタスク
- **次タスク提案** — 期限・依存関係・優先度を考慮して着手すべきタスクを提案

## プロセス

1. **REQUIRED:** `gh-gantt-sync`（pull）を invoke して最新データを取得
2. `gh-gantt task list --json` + `gh-gantt status` で全体像把握（`blocked_by`, `priority` 等のフィールドはデフォルト出力に含まれないため `--json` を使用）
3. 分析・レポート
4. アクションの提案（タスク着手、日程調整、ブロッカー解消等）

## リファレンス

- コマンド詳細: [commands.md](../gh-gantt-workflow/references/commands.md)
