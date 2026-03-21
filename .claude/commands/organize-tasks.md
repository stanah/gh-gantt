# タスク整理ワークフロー

## 絶対ルール

**`.gantt-sync/` 配下のファイルを直接読み書きしてはならない。** 常に `gh-gantt` CLI コマンドを使用すること。

## ワークフロー

```bash
# 1. 最新状態を取得
gh-gantt pull

# 2. 現状確認
gh-gantt task list --state open
gh-gantt milestone list

# 3. タスク操作（例）
gh-gantt task update 6 --milestone v1.0
gh-gantt task update 6 --start-date 2026-03-01 --end-date 2026-03-15
gh-gantt task link 7 --blocked-by 6
gh-gantt task link 6 --set-parent draft-1

# 4. 変更を GitHub に同期
gh-gantt push
```

コマンドの詳細なオプションは `gh-gantt-workflow` スキルの [references/commands.md](../skills/gh-gantt-workflow/references/commands.md) を参照。
