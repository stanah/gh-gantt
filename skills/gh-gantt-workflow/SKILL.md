---
name: gh-gantt-workflow
description: gh-gantt を使った GitHub Issue 駆動開発ワークフロー。タスク同期、ガントチャート可視化、コンフリクト解決を含む。(1) GitHub Issue の作業開始、(2) gh-gantt のセットアップ、(3) ローカルと GitHub Projects 間のタスク同期、(4) Issue に紐づくブランチ作成、(5) ガントチャートでの進捗管理、(6) ドラフトタスクの作成・push、(7) 同期コンフリクトの解決 に使用。
---

# gh-gantt ワークフロー

GitHub Projects (V2) とローカルタスクファイルの双方向同期による Issue 駆動開発。フィールド単位の 3-way merge でコンフリクトを安全に解決する。

## セットアップ

既存の GitHub Project に対して初期化:

```bash
gh-gantt init --owner <owner> --repo <repo> --project <number>
```

`.gantt-sync/` にconfig、タスク、同期状態が作成される。`.gitignore` に追加済み。

コマンド詳細: [references/commands.md](references/commands.md)

## 開発サイクル

### 1. 同期 & 選択

最新のプロジェクト状態を取得し、Issue を選ぶ:

```bash
gh-gantt pull
gh issue list
gh issue view <number>
```

`gh-gantt serve` でガントチャートを可視化（http://localhost:3000）。

### 2. ブランチ作成

Issue に紐づくブランチを作成:

```bash
# 命名規則
feat/issue-<number>-<short-description>    # 機能追加
fix/issue-<number>-<short-description>     # バグ修正

git checkout -b feat/issue-<number>-<description> main
```

### 3. 開発 & 検証

変更を実装し、コミット前に確認:

- 型チェック: `pnpm typecheck`
- テスト: `pnpm test`
- ビルド: `pnpm build`

### 4. コミット & PR

conventional commit メッセージでコミット (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`)。

Issue を参照する PR を作成:

```bash
git push -u origin <branch-name>
gh pr create --title "<title>" --body "Closes #<number>"
```

### 5. 同期

マージ後、更新された状態を同期:

```bash
gh-gantt pull
```

## 同期の仕組み

### pull (GitHub → ローカル)

```bash
gh-gantt pull
```

git と同じく、pull はいつでも実行可能。未 push のローカル変更があっても安全にマージされる。

- フィールド単位の 3-way merge（snapshot を base として比較）
- 片方だけの変更は自動マージ
- 双方が同じフィールドを変更 → コンフリクトマーカーを `tasks.json` に記録
- ローカル変更は push 対象として保持される（snapshot が保護する）
- 未解決コンフリクトがあると pull をブロック（先に resolve が必要）

### push (ローカル → GitHub)

```bash
gh-gantt push          # 通常の push（リモート変更があればブロック）
gh-gantt push --force  # リモート変更があっても push 実行
```

- 未解決コンフリクトがあると push をブロック（`--force` でもスキップ不可）
- リモートが更新されていると push をブロック（`--force` でスキップ可能）

## コンフリクト解決

pull 時にローカルとリモートが同じフィールドを変更していた場合、コンフリクトが発生する。

### 1. コンフリクト確認

```bash
gh-gantt conflicts
#   #8: ツリー表示でのドラッグ&ドロップ
#     state: current=open  incoming=closed  base=open
#   1 task(s), 1 conflict(s)

# 特定タスクのみ
gh-gantt conflicts 8
```

### 2. コンフリクト解決

```bash
# 特定フィールドを解決
gh-gantt resolve 8 --field state --ours      # ローカル側を採用
gh-gantt resolve 8 --field state --theirs    # リモート側を採用

# タスク全体を一括解決
gh-gantt resolve 8 --ours
gh-gantt resolve 8 --theirs

# 全コンフリクトを一括解決
gh-gantt resolve --ours
gh-gantt resolve --theirs

# インタラクティブモード（1フィールドずつ選択）
gh-gantt resolve
```

### 3. 解決確認 & push

```bash
gh-gantt conflicts       # "No conflicts." を確認
gh-gantt push            # GitHub に反映
```

### 判断基準

| フィールド | 方針 |
|-----------|------|
| `state` | ローカルで closed → 実装完了の意図 → `--ours`。PR 未マージなら `--theirs` |
| `start_date` / `end_date` | リモートがスケジュール調整 → `--theirs`。作業実績 → `--ours` |
| `milestone` | プロジェクト管理者の意図を尊重 → `--theirs` |
| `assignees` / `labels` | リモートを尊重 → `--theirs` |

## タスク作成

ドラフトタスクをローカルで作成し GitHub に push:

```bash
gh-gantt create --title "新機能" --type feature --start-date 2026-03-01 --end-date 2026-03-15
gh-gantt push
```

ガント UI からも作成可能（`gh-gantt serve`）。

## ステータス確認

同期状態と未反映の変更を確認:

```bash
gh-gantt status
```

## クイックリファレンス

| フェーズ | コマンド |
|---------|---------|
| 作業開始 | `gh-gantt pull` → `gh issue view <n>` → `git checkout -b feat/issue-<n>-...` |
| 作業中 | `gh-gantt serve` で可視化 |
| 作業完了 | commit → PR (`Closes #<n>`) → merge → `gh-gantt pull` |
| 新規タスク | `gh-gantt create` → `gh-gantt push` |
| 状態確認 | `gh-gantt status` |
| コンフリクト | `gh-gantt conflicts` → `gh-gantt resolve` → `gh-gantt push` |

コマンド詳細: [references/commands.md](references/commands.md)
