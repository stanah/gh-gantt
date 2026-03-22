---
name: gh-gantt-dependencies
description: タスク間の依存関係を設定・検証する。循環依存の検出、ブロッカー分析、クリティカルパスの特定を行う。「依存関係を設定して」「ブロッカーは？」「クリティカルパスは？」で使用。
---

# gh-gantt Dependencies

タスク間の依存関係（blocked_by）の設定・検証・問題検出を行う。

## 検査項目

- **循環依存** — A → B → A のようなループ
- **closed への依存** — 解消済みだが `blocked_by` に残っている
- **ブロッカー分析** — 何がブロックされているか、チェーンの深さ
- **クリティカルパス** — 最も長い依存チェーン

## プロセス

1. **REQUIRED:** `gh-gantt-sync`（pull）でタスクを最新状態に同期
2. `gh-gantt task list --json` で全タスクと依存関係を取得（`blocked_by` はデフォルト出力に含まれないため `--json` を使用）
3. 問題を検出・報告 — evidence として具体的なタスク ID と関係を提示
4. ユーザーに修正方針を確認
5. `gh-gantt task link` で設定・修正を実行
6. 修正後、`gh-gantt task show <number>` で結果を確認 — evidence として出力を提示

## リファレンス

- コマンド詳細: [commands.md](../gh-gantt-workflow/references/commands.md)
