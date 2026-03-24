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
- [list](#list)
- [show](#show)
- [update](#update)
- [link](#link)

---

## init

GitHub Project に対して gh-gantt を初期化する。

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

---

## pull

GitHub Project から最新の変更を取得し、ローカルとマージする。

```bash
gh-gantt pull [--dry-run] [--with-comments] [--force-comments]
```

**オプション:**

- `--dry-run` — 変更をプレビューのみ（適用しない）
- `--with-comments` — Issue コメントも差分取得
- `--force-comments` — Issue コメントを全件再取得

**出力:** `Pull summary: +N ~N !N -N`（追加、更新、コンフリクト、削除）

**注意:**

- 未 push のローカル変更があっても安全に実行できる
- 未解決コンフリクトがある場合は先に `resolve` が必要

---

## push

ローカルの変更を GitHub に反映する。

```bash
gh-gantt push [--force] [--dry-run] [--yes]
```

**オプション:**

- `--force` — リモートが更新されていても push を実行
- `--dry-run` — 変更をプレビューのみ（適用しない）
- `--yes` — 確認プロンプトをスキップ

**出力:** `Push complete: N created, N updated, N skipped.`

**注意:**

- 未解決コンフリクトがあれば中断（`--force` でもスキップ不可）
- リモートが更新されていれば中断（`--force` でスキップ可能）

---

## status

同期状態の概要を表示する。

```bash
gh-gantt status
```

---

## conflicts

未解決の同期コンフリクトを表示する。

```bash
gh-gantt conflicts [issue]
```

**引数:**

- `[issue]` — Issue 番号で絞り込み（省略時は全タスク）

---

## resolve

同期コンフリクトを解決する。

```bash
gh-gantt resolve [issue] [--ours] [--theirs] [--field <field>]
```

**オプション:**

- `--ours` — ローカル側の値を採用
- `--theirs` — リモート側の値を採用
- `--field <field>` — 特定フィールドのみ解決

引数なしで実行するとインタラクティブモード。

---

## create

ドラフトタスクをローカルに作成する（まだ GitHub Issue ではない）。`push` で Issue として作成される。

```bash
gh-gantt create --title <title> [--type <type>] [--body <body>] \
  [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--parent <id>]
```

---

## serve

ガントチャート UI と REST API サーバーを起動する。

```bash
gh-gantt serve [-p <port>] [--api-only]
```

**オプション:**

- `-p, --port <port>` — サーバーポート（デフォルト: 3000）
- `--api-only` — API サーバーのみ（UI なし）

---

## list

タスク一覧を表示する。

```bash
gh-gantt list [options]
```

**オプション:**

- `--backlog` — バックログタスクのみ（日付未設定）
- `--scheduled` — スケジュール済みタスクのみ（日付あり）
- `--type <type>` — タスクタイプで絞り込み
- `--state <state>` — 状態で絞り込み（open/closed）
- `--unblocked` — ブロッカーが解消済みのタスクのみ
- `--assignee <login>` — 担当者で絞り込み
- `--unassigned` — 未アサインタスクのみ
- `--status <status>` — Status カスタムフィールド値で絞り込み
- `--label <label>` — ラベルで絞り込み
- `--search <query>` — タイトルと body で検索
- `--sort <fields>` — ソート（カンマ区切り: priority, end_date, start_date, type, title）
- `--json` — JSON 出力

---

## show

タスクの詳細を表示する。body、parent、blocked_by、sub_tasks 等の情報は `list` のデフォルト表示には含まれないが、このコマンドや `list --json` で確認できる。

```bash
gh-gantt show <id> [--json]
```

---

## update

タスクのフィールドを更新する。

```bash
gh-gantt update <id> [options]
```

**オプション:**

- `--title <title>` — タイトル
- `--type <type>` — タスクタイプ
- `--state <state>` — 状態（open/closed）
- `--start-date <date>` — 開始日（YYYY-MM-DD、`none` でクリア）
- `--end-date <date>` — 終了日（YYYY-MM-DD、`none` でクリア）
- `--assignee <login>` — 担当者追加
- `--remove-assignee <login>` — 担当者削除
- `--milestone <name>` — マイルストーン設定（`none` でクリア）
- `--label <name>` — ラベル追加
- `--remove-label <name>` — ラベル削除
- `--json` — 更新後のタスクを JSON 出力

**バルク更新（フィルタ指定で複数タスクを一括更新）:**

```bash
gh-gantt update --filter-state open --milestone v1.0
gh-gantt update --filter-type task --filter-label bug --state closed
```

フィルタオプション: `--filter-state`, `--filter-type`, `--filter-milestone`, `--filter-label`

---

## link

タスクの依存関係と親子関係を管理する。

```bash
gh-gantt link <id> [--blocked-by <id>] [--unblock <id>] \
  [--set-parent <id>] [--remove-parent] [--json]
```

---

## タスクタイプ（task_types）

gh-gantt はタスクの種類（epic, task, feature 等）を `gantt.config.json` の `task_types` で管理する。

### GitHub の機能との対応

| GitHub の機能                      | 利用条件                                    | gh-gantt での扱い                           |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------- |
| **Issue Types**                    | Organization のみ（個人リポジトリは未対応） | 未サポート                                  |
| **Labels**                         | どこでも使える                              | `github_label` フィールドでマッピング       |
| **Projects V2 カスタムフィールド** | どこでも使える                              | `github_field_value` フィールドでマッピング |

個人リポジトリでは Issue Types が使えないため、gh-gantt はラベルとカスタムフィールドでタスクの種類を管理する。

### config の構造

```json
"task_types": {
  "epic": {
    "label": "Epic",
    "display": "summary",
    "color": "#8E44AD",
    "github_label": "epic",
    "github_field_value": "Epic"
  }
}
```

- `display` — ガントチャートでの描画形式（`bar`, `summary`, `milestone`）
- `github_label` — GitHub Issue ラベルとの対応（pull 時のタイプ解決、create / update --type 時のラベル自動同期に使用）
- `github_field_value` — Projects V2 カスタムフィールド値との対応（`github_label` より優先）

### pull 時のタイプ解決（優先度順）

1. Projects V2 カスタムフィールド値 → `github_field_value` でマッチ
2. GitHub Issue ラベル → `github_label` でマッチ
3. どちらにもマッチしない → `"task"` にフォールバック

### 使用可能なタイプ

`create` や `update --type` で指定できるタイプは config に定義されたもののみ。
新しいタイプが必要な場合は `gantt.config.json` の `task_types` に追加する。

---

## タスク ID

| 入力形式        | 展開結果                                    |
| --------------- | ------------------------------------------- |
| `6` または `#6` | `owner/repo#6`（config のリポジトリを使用） |
| `draft-1`       | `draft-owner/repo-1`                        |
| `owner/repo#6`  | そのまま                                    |
