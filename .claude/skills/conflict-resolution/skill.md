---
name: conflict-resolution
description: gh-gantt の同期コンフリクトを CLI で自動解決する。pull 後にコンフリクトが発生した場合、または「コンフリクトを解決して」と指示された場合にトリガー。
---

# gh-gantt Conflict Resolution

gh-gantt pull 後に発生した同期コンフリクトを CLI コマンドで解決する。

## Workflow

1. コンフリクト一覧を取得:
   ```bash
   gh-gantt conflicts
   ```

2. 各コンフリクトについて current / incoming / base を確認し、適切な値を判断

3. CLI で解決:
   ```bash
   # 特定フィールドを解決
   gh-gantt resolve <issue-number> --field <field> --ours
   gh-gantt resolve <issue-number> --field <field> --theirs

   # タスク全体を一括解決
   gh-gantt resolve <issue-number> --ours
   gh-gantt resolve <issue-number> --theirs
   ```

4. 全解決を確認:
   ```bash
   gh-gantt conflicts
   # → "No conflicts."
   ```

5. push を提案:
   ```bash
   gh-gantt push
   ```

## Decision Guidelines

| Field | Guideline |
|-------|-----------|
| `state` | ローカルで closed にしたなら実装完了の意図 → `--ours`。PR 未マージなら `--theirs` |
| `start_date` / `end_date` | リモートがスケジュール調整なら `--theirs`。ローカルが作業実績なら `--ours` |
| `milestone` | プロジェクト管理者の意図を尊重 → `--theirs` 優先 |
| `assignees` / `labels` | リモートを尊重 → `--theirs` 優先 |
| 判断がつかない場合 | ユーザーに確認する |

## Important

- `tasks.json` を直接編集しない。必ず `gh-gantt resolve` コマンドを使う
- 解決後は `gh-gantt conflicts` で残りがないことを確認する
- コンフリクトが残っている状態では `push` も `pull` もできない
