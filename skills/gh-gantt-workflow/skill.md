---
name: gh-gantt-workflow
description: gh-gantt CLI を使った開発ワークフロー。タスク確認・同期・ブランチ作成・PR 作成の一連の流れ。「タスクを確認して」「次に何をすべき？」「同期して」「作業を始めたい」などの指示で使用。
---

# gh-gantt 開発ワークフロー

gh-gantt CLI でタスクを管理しながら開発を進める。

## セットアップ

既存の GitHub Project に対して初期化:

```bash
gh-gantt init --owner <owner> --repo <repo> --project <number>
```

`.gantt-sync/` に config・タスク・同期状態が作成される。

## 開発サイクル

### 1. 同期 & タスク確認

```bash
gh-gantt pull                    # GitHub → ローカル同期
gh-gantt task list --state open  # 未完了タスク一覧
```

必要に応じて詳細を確認:

```bash
gh-gantt task show <number>      # タスク詳細
gh-gantt status                  # 同期状態（未 push の変更、コンフリクト有無）
```

### 2. タスク選択

一覧から着手するタスクを選ぶ。優先度の判断基準:

1. **期限が近い** — `End Date` が今日に近いタスク
2. **ブロックされていない** — `blocked_by` が空、または依存先が完了済み
3. **エピックの子タスク** — 親エピックの期限が迫っている場合、その子タスクを優先

ユーザーに確認せずタスクを勝手に選ばない。一覧を提示して選択を促す。

### 3. ブランチ作成

```bash
# 命名規則
feat/issue-<number>-<short-description>    # 機能追加
fix/issue-<number>-<short-description>     # バグ修正

git checkout -b feat/issue-<number>-<description> main
```

### 4. 開発 & 検証

```bash
pnpm typecheck
pnpm test
pnpm build
```

### 5. コミット & PR

conventional commit (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`)。

```bash
git push -u origin <branch-name>
gh pr create --title "<title>" --body "Closes #<number>"
```

### 6. タスク完了

コミット後、対応するタスクの状態を更新する。PR なしで main に直接コミットした場合も同様。

```bash
gh-gantt task update <number> --state closed
gh-gantt push                    # GitHub に反映
```

### 7. マージ後の同期

```bash
gh-gantt pull
```

## タスク操作

```bash
# 作成
gh-gantt create --title "タスク名" --type task --start-date 2026-03-01 --end-date 2026-03-15
gh-gantt push                    # GitHub に反映

# 更新
gh-gantt task update <number> --milestone v1.0
gh-gantt task update <number> --start-date 2026-03-01 --end-date 2026-03-15

# 依存関係・親子関係
gh-gantt task link <number> --blocked-by <number>
gh-gantt task link <number> --set-parent <id>

# マイルストーン
gh-gantt milestone list
gh-gantt milestone create "v1.0" --due-date 2026-06-01
```

## コンフリクト発生時

`conflict-resolution` スキルを使用する。

## リファレンス

- コマンドの詳細なオプション・動作: [references/commands.md](references/commands.md)
