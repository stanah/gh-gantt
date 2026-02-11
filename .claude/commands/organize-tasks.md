# タスク整理ワークフロー

## 絶対ルール

**`.gantt-sync/tasks.json` を直接編集してはならない。** 常に CLI コマンドを使用すること。

直接編集が禁止される理由:
- Zod バリデーションをバイパスする
- sync-state のスナップショットと不整合が生じる
- push 時に意図しない差分が発生する

## ワークフローパターン

```bash
# 1. 最新状態を取得
./gh-gantt pull

# 2. 現状確認
./gh-gantt task list
./gh-gantt task list --state open
./gh-gantt milestone list

# 3. タスク操作（例）
./gh-gantt task update 6 --milestone v1.0
./gh-gantt task update --filter-state open --filter-type task --milestone v1.0
./gh-gantt task update 6 --label priority
./gh-gantt task update 6 --remove-label wontfix
./gh-gantt task update 6 --start-date 2026-03-01 --end-date 2026-03-15
./gh-gantt task link 7 --blocked-by 6
./gh-gantt task link 6 --set-parent draft-1

# 4. 変更を GitHub に同期
./gh-gantt push
```

## CLI コマンドリファレンス

### タスク作成
```bash
./gh-gantt create --title "タスク名" --type task [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--parent ID]
```

### タスク更新（単体）
```bash
./gh-gantt task update <id> [options]
  --title <title>           タイトル変更
  --type <type>             タイプ変更
  --state <open|closed>     状態変更
  --start-date <YYYY-MM-DD|none>  開始日設定/クリア
  --end-date <YYYY-MM-DD|none>    終了日設定/クリア
  --assignee <login>        担当者追加
  --remove-assignee <login> 担当者削除
  --milestone <name|none>   マイルストーン設定/クリア
  --label <name>            ラベル追加
  --remove-label <name>     ラベル削除
```

### タスク更新（バルク）
```bash
./gh-gantt task update --filter-state open --milestone v1.0
./gh-gantt task update --filter-type task --filter-label bug --state closed

フィルタオプション:
  --filter-state <state>       状態でフィルタ
  --filter-type <type>         タイプでフィルタ
  --filter-milestone <name|none>  マイルストーンでフィルタ
  --filter-label <name>        ラベルでフィルタ
```

### 依存関係・親子関係
```bash
./gh-gantt task link <id> --blocked-by <id>
./gh-gantt task link <id> --remove-blocked-by <id>
./gh-gantt task link <id> --set-parent <id>
./gh-gantt task link <id> --remove-parent
```

### マイルストーン
```bash
./gh-gantt milestone list [--json]
./gh-gantt milestone create "名前" [--due-date YYYY-MM-DD] [--description "説明"]

# マイルストーンを GitHub に反映（push で自動作成）
./gh-gantt milestone create "v2.0" --due-date 2026-12-01
./gh-gantt push --dry-run  # "1 milestone(s) to create" が表示される
./gh-gantt push            # GitHub Milestone が自動作成される
```

## タスク ID のショートハンド

| 入力形式 | 展開結果 |
|---------|---------|
| `6` | `owner/repo#6` |
| `#6` | `owner/repo#6` |
| `draft-1` | `owner/repo#draft-1` |
| `owner/repo#6` | そのまま |
