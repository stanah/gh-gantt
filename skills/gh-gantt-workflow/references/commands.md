# gh-gantt コマンドリファレンス

## 目次

- [init](#init)
- [pull](#pull)
- [push](#push)
- [status](#status)
- [conflicts](#conflicts)
- [resolve](#resolve)
- [create](#create)
- [serve](#serve)
- [task list](#task-list)
- [task show](#task-show)
- [task update](#task-update)
- [task link](#task-link)

---

## init

GitHub Project に対して gh-gantt を初期化する。`.gantt-sync/` ディレクトリに config、タスク、同期状態を作成。

```bash
gh-gantt init --owner <owner> --repo <repo> --project <number>
```

**必須オプション:**
- `--owner <owner>` — GitHub ユーザーまたは org
- `--repo <repo>` — リポジトリ名
- `--project <number>` — GitHub Project 番号

**任意オプション:**
- `--start-date-field <name>` — 開始日フィールド名（デフォルト: "Start Date"）
- `--end-date-field <name>` — 終了日フィールド名（デフォルト: "End Date"）
- `--status-field <name>` — ステータスフィールド名（デフォルト: "Status"）

**動作:**
1. GitHub Project (V2) の全アイテムとフィールドを取得
2. ラベルからタスクタイプを自動検出（epic, milestone, feature, bug）
3. sub-issue 階層を解決
4. `.gantt-sync/` に `gantt.config.json`、`tasks.json`、`sync-state.json` を生成

---

## pull

GitHub Project から最新の変更を取得し、ローカルタスクとマージする。

```bash
gh-gantt pull [--dry-run] [--with-comments] [--force-comments]
```

**オプション:**
- `--dry-run` — 変更をプレビューのみ（適用しない）
- `--with-comments` — Issue コメントも差分取得
- `--force-comments` — Issue コメントを全件再取得

**出力:** `Pull summary: +N ~N !N -N`（追加、更新、コンフリクト、削除）

**動作:**
- git と同じく、pull はいつでも実行可能。未 push のローカル変更があっても安全にマージされる
- 未解決コンフリクトがあれば中断（先に resolve が必要）
- ローカル変更は push 対象として保持される（snapshot が保護する）
- snapshot の syncFields を base としたフィールド単位 3-way merge
- 片方だけの変更は自動マージ
- 双方が同じフィールドを変更 → コンフリクトマーカー（`_current` / `_incoming`）を記録
- リモートで削除 + ローカルで変更 → 警告を出してローカルを保持（delete/modify コンフリクト）
- ドラフトタスクは pull の対象外（常に保持）
- read-only フィールド（`created_at`、`updated_at`、`closed_at`、`state_reason`、`linked_prs`）はリモートから常に上書き

---

## push

ローカルの変更を GitHub に反映する。ドラフトから Issue を作成し、既存 Issue を更新。

```bash
gh-gantt push [--force] [--dry-run] [--yes]
```

**オプション:**
- `--force` — リモートが更新されていても push を実行
- `--dry-run` — 変更をプレビューのみ（適用しない）
- `--yes` — 確認プロンプトをスキップ

**出力:** `Push complete: N created, N updated, N skipped.`

**動作:**
- **ガード 1:** 未解決コンフリクトがあれば中断（`--force` でもスキップ不可）
- **ガード 2:** リモートが更新されていれば中断（`--force` でスキップ可能）
- ローカルタスクを snapshot と比較して差分を検出
- ドラフトタスク（`draft-` プレフィクス）から GitHub Issue を作成
- 既存 Issue のフィールド変更を更新

---

## status

同期状態の概要を表示する。

```bash
gh-gantt status
```

**出力内容:**
- 最終同期タイムスタンプ
- ローカル/リモートのタスク数
- ローカルの変更（追加/変更/削除）
- pull 待ちのリモート変更
- コンフリクト検出
- 未 push のドラフトタスク

---

## conflicts

未解決の同期コンフリクトを表示する。

```bash
gh-gantt conflicts [issue]
```

**引数:**
- `[issue]` — Issue 番号で絞り込み（省略時は全タスク）

**出力例:**
```
  #8: ツリー表示でのドラッグ&ドロップ
    state: current=open  incoming=closed  base=open
    start_date: current=2026-02-11  incoming=2026-03-01  base=2026-02-01

  1 task(s), 2 conflict(s)
```

- `current` — ローカル側の値
- `incoming` — リモート側の値
- `base` — 前回同期時点の値（snapshot）

コンフリクトがない場合: `No conflicts.`

---

## resolve

同期コンフリクトを解決する。

```bash
gh-gantt resolve [issue] [--ours] [--theirs] [--field <field>]
```

**引数:**
- `[issue]` — Issue 番号で絞り込み（省略時は全タスク）

**オプション:**
- `--ours` — ローカル側の値を採用
- `--theirs` — リモート側の値を採用
- `--field <field>` — 特定フィールドのみ解決

**使用例:**
```bash
# 特定フィールドを解決
gh-gantt resolve 8 --field state --theirs

# タスク全体を一括解決
gh-gantt resolve 8 --ours

# 全コンフリクトを一括解決
gh-gantt resolve --theirs

# インタラクティブモード（オプションなしで実行）
gh-gantt resolve
```

**解決後の動作:**
1. マーカーキー（`_current`、`_incoming`）を除去
2. 選択した値をフィールドに設定
3. `tasks.json` と `sync-state.json` を書き出し
4. 全解決後、`has_conflicts` フラグを `false` に設定

---

## create

ドラフトタスクをローカルに作成する（まだ GitHub Issue ではない）。

```bash
gh-gantt create --title <title> [--type <type>] [--body <body>] \
  [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--parent <id>]
```

**オプション:**
- `--title <title>` — タスクタイトル（必須）
- `--type <type>` — タスクタイプ（task, epic, feature, bug 等）
- `--body <body>` — 説明
- `--start-date <date>` — 開始日（YYYY-MM-DD）
- `--end-date <date>` — 終了日（YYYY-MM-DD）
- `--parent <id>` — 親タスク ID

ドラフトタスクの ID は `draft-owner/repo-N` 形式。`push` で GitHub Issue として作成される。

---

## serve

ガントチャート UI と REST API の Web サーバーを起動する。

```bash
gh-gantt serve [-p <port>] [--api-only]
```

**オプション:**
- `-p, --port <port>` — サーバーポート（デフォルト: 3000）
- `--api-only` — API サーバーのみ（UI なし）

**REST API エンドポイント:**

| メソッド | エンドポイント | 説明 |
|---------|--------------|------|
| GET | `/api/config` | プロジェクト設定 |
| GET | `/api/tasks` | 全タスク（進捗付き） |
| POST | `/api/tasks` | ドラフトタスク作成 |
| PATCH | `/api/tasks/:id` | タスクフィールド更新 |
| POST | `/api/sync/pull` | GitHub から pull |
| POST | `/api/sync/push` | GitHub へ push |
| GET | `/api/sync/status` | 同期ステータス |

---

## task list

タスク一覧を表示する（フィルタ付き）。

```bash
gh-gantt task list [--backlog] [--scheduled] [--type <type>] [--state <state>] [--json]
```

**オプション:**
- `--backlog` — バックログタスクのみ（日付未設定）
- `--scheduled` — スケジュール済みタスクのみ（日付あり）
- `--type <type>` — タスクタイプで絞り込み
- `--state <state>` — 状態で絞り込み（open/closed）
- `--json` — JSON 出力

---

## task show

タスクの詳細を表示する。

```bash
gh-gantt task show <id> [--json]
```

**引数:**
- `<id>` — タスク ID（短縮 ID 対応、下記参照）

**オプション:**
- `--json` — JSON 出力

---

## task update

タスクのフィールドを更新する。

```bash
gh-gantt task update <id> [--title <title>] [--type <type>] [--state <state>]
  [--start-date <date>] [--end-date <date>] [--assignee <login>]
  [--remove-assignee <login>] [--json]
```

**引数:**
- `<id>` — タスク ID（短縮 ID 対応、下記参照）

**オプション:**
- `--title <title>` — タイトル設定
- `--type <type>` — タスクタイプ設定
- `--state <state>` — 状態設定（open/closed）
- `--start-date <date>` — 開始日設定（YYYY-MM-DD、'none' でクリア）
- `--end-date <date>` — 終了日設定（YYYY-MM-DD、'none' でクリア）
- `--assignee <login>` — 担当者追加
- `--remove-assignee <login>` — 担当者削除
- `--json` — 更新後のタスクを JSON 出力

---

## task link

タスクの依存関係と親子関係を管理する。

```bash
gh-gantt task link <id> [--blocked-by <id>] [--unblock <id>]
  [--set-parent <id>] [--remove-parent] [--json]
```

**引数:**
- `<id>` — タスク ID（短縮 ID 対応、下記参照）

**オプション:**
- `--blocked-by <id>` — ブロック依存関係を追加（finish-to-start）
- `--unblock <id>` — ブロック依存関係を削除
- `--set-parent <id>` — 親タスクを設定
- `--remove-parent` — 親タスクを削除
- `--json` — 更新後のタスクを JSON 出力

---

## .gantt-sync/ ディレクトリ

ローカル状態は `.gantt-sync/` に保存される（gitignore 済み）:

| ファイル | 用途 |
|---------|------|
| `gantt.config.json` | プロジェクト設定（タイプ、ステータス、フィールドマッピング、表示） |
| `tasks.json` | 全タスク（メタデータ、コメントキャッシュ含む） |
| `sync-state.json` | 同期メタデータ（タイムスタンプ、ID マッピング、snapshot） |

**タスク ID 形式:**
- GitHub Issue: `owner/repo#123`
- ドラフトタスク: `draft-owner/repo-N`
- 合成マイルストーン: `milestone:owner/repo#N`

**短縮 ID:** タスク ID を受け付けるコマンドでは短縮形が使える:
- `6` または `#6` → `owner/repo#6`（config のリポジトリを使用）
- `owner/repo#6` → そのまま使用

**コンフリクトマーカー:**
pull 時にコンフリクトが発生すると、`tasks.json` 内のタスクに `{field}_current` / `{field}_incoming` キーが追加される。`has_conflicts: true` がファイルレベルに設定される。`resolve` コマンドで解決するまで `push` / `pull` はブロックされる。
