---
name: gh-gantt-conflict-resolution
description: gh-gantt の同期コンフリクトを CLI で自動解決する。pull 後にコンフリクトが発生した場合、または「コンフリクトを解決して」と指示された場合にトリガー。
---

# gh-gantt Conflict Resolution

gh-gantt pull 後に発生した同期コンフリクトを CLI コマンドで解決する。

## Workflow

1. コンフリクト一覧を取得:

   ```bash
   gh-gantt conflicts
   ```

2. 設定済みポリシーを先に適用:

   ```bash
   gh-gantt resolve --auto
   gh-gantt conflicts
   ```

   `resolve --auto <issue-number> --field <field>` ではなく、構文は
   `resolve <issue-number> --auto --field <field>`。Issue と field で安全に絞り込める。

3. 残った `manual` / 未定義フィールドだけ current / incoming / base を確認し、適切な値を判断

4. CLI で解決:

   ```bash
   # 特定フィールドを解決
   gh-gantt resolve <issue-number> --field <field> --ours
   gh-gantt resolve <issue-number> --field <field> --theirs

   # タスク全体を一括解決
   gh-gantt resolve <issue-number> --ours
   gh-gantt resolve <issue-number> --theirs
   ```

5. 全解決を確認:

   ```bash
   gh-gantt conflicts
   # → "No conflicts."
   ```

6. push を提案:
   ```bash
   gh-gantt push
   ```

## Decision Guidelines

| Field                     | Guideline                                                                         |
| ------------------------- | --------------------------------------------------------------------------------- |
| `state`                   | ローカルで closed にしたなら実装完了の意図 → `--ours`。PR 未マージなら `--theirs` |
| `start_date` / `end_date` | リモートがスケジュール調整なら `--theirs`。ローカルが作業実績なら `--ours`        |
| `milestone`               | プロジェクト管理者の意図を尊重 → `--theirs` 優先                                  |
| `assignees` / `labels`    | リモートを尊重 → `--theirs` 優先                                                  |
| 判断がつかない場合        | ユーザーに確認する                                                                |

init が生成する既定 `sync.conflict_policy` は次のとおり。未記載フィールドは
`manual` と同じく自動解決されない。

```json
{
  "state": "ours",
  "start_date": "theirs",
  "end_date": "theirs",
  "milestone": "theirs",
  "assignees": "theirs",
  "labels": "theirs"
}
```

legacy `sync.conflict_strategy` は読み込みだけを維持し、`resolve --auto` では警告して
無視する。値を全フィールドの fallback として扱ってはならない。

## Important

- `.gantt-sync/` の同期キャッシュを直接編集しない。必ず `gh-gantt resolve` コマンドを使う
- 解決後は `gh-gantt conflicts` で残りがないことを確認する
- コンフリクトが残っている状態では `push` も `pull` もできない
