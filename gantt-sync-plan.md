# gh-gantt: GitHub Projects 拡張ガントチャート

> **変更履歴**: 2026-02-09 ブレインストーミングにより機能要件を再設計。
> 詳細は `docs/plans/2026-02-09-gh-gantt-v0.1-design.md` を参照。

## 概要

GitHub ProjectsのIssueをローカルJSONと双方向同期し、**ツリー＋ガント一体型UI**で**階層的な進捗の全体像**を掴むためのOSSツール。

gh CLI extension (`gh gantt`) として提供する。

GitHub Projects単体では実現できない**階層的進捗率の自動集約、ブロック関係管理、カスタムステータス可視化、カスタムタスクtype階層、ドラッグ&ドロップ編集**を提供する。

### 差別化ポイント

- **完全ローカル + OSS**: SaaS依存なし。データ主権がユーザーの手元にある
- **深い双方向同期**: Issue body、Sub Issues、カスタムフィールドまで含む本格的な同期

### 設計方針

- **UIファースト**: ローカルJSONは中間ファイル。人が直接編集する前提を置かない
- **GitHubが正（source of truth）**: ローカルはキャッシュ + GitHub側にない拡張情報の保持
- **CLIは裏方**: 同期エンジンとして機能し、`gh gantt serve` でUIを起動するのがメインの使い方
- **ライセンス制約**: GPL不可。全依存ライブラリはMIT/Apache-2.0/BSD系であること

## 技術スタック

| レイヤー | 技術 | 理由 |
|---|---|---|
| 言語 | TypeScript | 型安全、`@octokit`との親和性 |
| CLIフレームワーク | Commander.js | サブコマンド管理 |
| GitHub API | `@octokit/graphql` | ProjectV2 GraphQL API対応 |
| 認証 | `gh auth token` 流用 | gh CLIとの統合 |
| 配布 | gh extension | `gh extension install stanah/gh-gantt` |
| ローカルストア | JSON (中間ファイル) | マシン効率優先、アプリ管理 |
| バリデーション | zod | アプリ層でのスキーマ検証 |
| UI | React + D3.js | フル制御可能、MIT |
| UI⇔CLI通信 | REST API (v0.1) | pull/push手動トリガー |
| ビルド | Vite (UI) / tsup (CLI) | 高速ビルド |

---

## ファイル構成

```
my-project/
├── .gantt-sync/
│   ├── tasks.json          # タスク・Issue全データ（中間ファイル、アプリ管理）
│   ├── sync-state.json     # 同期状態・IDマッピング
│   └── gantt.config.json   # 接続設定・type定義・ステータス定義（人が触る可能性あり）
└── .gitignore
```

- `tasks.json`: 全タスクデータ。UIとCLI同期エンジンが読み書きする中間ファイル。gitコミットすればチーム共有可能
- `sync-state.json`: 同期の内部状態。last_synced_at、GitHub NodeID↔ローカルIDのマッピング等
- `gantt.config.json`: プロジェクト設定。初期セットアップ時に人が触る可能性があるため唯一の可読性考慮対象

---

## データモデル

### gantt.config.json

```json
{
  "version": "1",
  "project": {
    "name": "my-project",
    "github": {
      "owner": "stanah",
      "repo": "my-repo",
      "project_number": 1
    }
  },
  "sync": {
    "conflict_strategy": "remote-wins",
    "auto_create_issues": false,
    "field_mapping": {
      "start_date": "Start Date",
      "end_date": "End Date",
      "status": "Status"
    }
  },
  "task_types": {
    "epic": {
      "label": "Epic",
      "display": "summary",
      "color": "#8E44AD",
      "default_collapsed": true,
      "github_label": "epic"
    },
    "feature": {
      "label": "Feature",
      "display": "summary",
      "color": "#2980B9",
      "github_label": "feature"
    },
    "task": {
      "label": "Task",
      "display": "bar",
      "color": "#27AE60",
      "github_label": null
    },
    "bug": {
      "label": "Bug",
      "display": "bar",
      "color": "#E74C3C",
      "github_label": "bug"
    },
    "milestone": {
      "label": "Milestone",
      "display": "milestone",
      "color": "#F39C12",
      "github_label": null
    }
  },
  "type_hierarchy": {
    "epic": ["feature", "task", "bug"],
    "feature": ["task", "bug"],
    "task": [],
    "bug": [],
    "milestone": []
  },
  "statuses": {
    "field_name": "Status",
    "values": {
      "Backlog":     { "color": "#95A5A6", "done": false },
      "Todo":        { "color": "#3498DB", "done": false },
      "In Progress": { "color": "#F39C12", "done": false },
      "Done":        { "color": "#2ECC71", "done": true }
    }
  },
  "gantt": {
    "default_view": "month",
    "working_days": [1, 2, 3, 4, 5],
    "colors": {
      "critical_path": "#E74C3C",
      "on_track": "#2ECC71",
      "at_risk": "#F39C12",
      "overdue": "#E74C3C"
    }
  }
}
```

- `task_types`: プロジェクトが自由に定義。`display` で表示スタイル（summary / bar / milestone）だけ制約
- `type_hierarchy`: バリデーション用。epicの下にepicは置けない等のルール（オプショナル）
- `github_label`: このラベルがついたIssueを該当typeとして自動判別
- `statuses`: ProjectV2のStatusフィールドに対応。`init`時に自動取得して初期生成。`done: true` のステータスは進捗率算出で完了扱い

### tasks.json

```json
{
  "tasks": [
    {
      "id": "e1",
      "type": "epic",
      "github_issue": 10,
      "github_repo": "stanah/my-repo",
      "parent": null,
      "sub_tasks": ["f1", "f2"],

      "title": "認証基盤",
      "body": "## 概要\nアプリケーション全体の認証基盤を構築する。\n\n## スコープ\n- OAuth2対応\n- Passkey対応\n- セッション管理",
      "state": "open",
      "state_reason": null,
      "assignees": ["stanah"],
      "labels": ["epic", "auth"],
      "milestone": "v1.0",
      "linked_prs": [],
      "created_at": "2026-02-01T09:00:00Z",
      "updated_at": "2026-02-08T15:30:00Z",
      "closed_at": null,

      "custom_fields": {
        "Status": "In Progress",
        "Sprint": "Sprint 3"
      },

      "start_date": null,
      "end_date": null,
      "date": null,
      "blocked_by": []
    },
    {
      "id": "f1",
      "type": "feature",
      "github_issue": 42,
      "github_repo": "stanah/my-repo",
      "parent": "e1",
      "sub_tasks": ["t1", "t2"],

      "title": "OAuth2対応",
      "body": "## 要件\n- Google, GitHub, Microsoft の3プロバイダ対応\n- Authorization Code Flow (PKCE)\n- トークンリフレッシュ\n\n## 技術メモ\nnext-auth v5 を使用。カスタムプロバイダアダプタが必要。",
      "state": "open",
      "state_reason": null,
      "assignees": ["stanah"],
      "labels": ["feature", "auth"],
      "milestone": "v1.0",
      "linked_prs": [101, 105],
      "created_at": "2026-02-03T09:00:00Z",
      "updated_at": "2026-02-08T12:00:00Z",
      "closed_at": null,

      "custom_fields": {
        "Status": "In Progress",
        "Sprint": "Sprint 3",
        "Estimate": 8
      },

      "start_date": null,
      "end_date": null,
      "date": null,
      "blocked_by": []
    },
    {
      "id": "t1",
      "type": "task",
      "github_issue": 55,
      "github_repo": "stanah/my-repo",
      "parent": "f1",
      "sub_tasks": [],

      "title": "OAuth2プロバイダ実装",
      "body": "next-auth v5のカスタムプロバイダアダプタを実装する。\n\n- Google: openid, email, profile scope\n- GitHub: read:user scope\n- Microsoft: User.Read scope",
      "state": "open",
      "state_reason": null,
      "assignees": ["stanah"],
      "labels": ["feature", "auth"],
      "milestone": "v1.0",
      "linked_prs": [101],
      "created_at": "2026-02-05T09:00:00Z",
      "updated_at": "2026-02-08T15:30:00Z",
      "closed_at": null,

      "custom_fields": {
        "Status": "In Progress",
        "Sprint": "Sprint 3",
        "Estimate": 5
      },

      "start_date": "2026-02-10",
      "end_date": "2026-02-18",
      "date": null,
      "blocked_by": []
    },
    {
      "id": "t2",
      "type": "bug",
      "github_issue": 60,
      "github_repo": "stanah/my-repo",
      "parent": "f1",
      "sub_tasks": [],

      "title": "トークンリフレッシュ失敗時のエラーハンドリング",
      "body": "リフレッシュトークンが期限切れの場合に500エラーが返る。\n\n## 再現手順\n1. ログイン\n2. 24時間放置\n3. API呼び出し\n\n## 期待動作\n再認証フローにリダイレクト",
      "state": "open",
      "state_reason": null,
      "assignees": ["stanah"],
      "labels": ["bug", "auth"],
      "milestone": "v1.0",
      "linked_prs": [],
      "created_at": "2026-02-07T14:00:00Z",
      "updated_at": "2026-02-07T14:00:00Z",
      "closed_at": null,

      "custom_fields": {
        "Status": "Todo",
        "Sprint": "Sprint 3",
        "Estimate": 2
      },

      "start_date": "2026-02-19",
      "end_date": "2026-02-20",
      "date": null,
      "blocked_by": [
        {
          "task": "t1",
          "type": "finish-to-start",
          "lag": 0
        }
      ]
    },
    {
      "id": "m1",
      "type": "milestone",
      "github_issue": null,
      "github_repo": "stanah/my-repo",
      "parent": null,
      "sub_tasks": [],

      "title": "v1.0 Release",
      "body": null,
      "state": "open",
      "state_reason": null,
      "assignees": [],
      "labels": [],
      "milestone": "v1.0",
      "linked_prs": [],
      "created_at": "2026-02-01T09:00:00Z",
      "updated_at": "2026-02-01T09:00:00Z",
      "closed_at": null,

      "custom_fields": {},

      "start_date": null,
      "end_date": null,
      "date": "2026-04-01",
      "blocked_by": [
        {
          "task": "f2",
          "type": "finish-to-start",
          "lag": 0
        }
      ]
    }
  ],
  "cache": {
    "comments": {
      "55": [
        {
          "author": "reviewer1",
          "body": "PKCEのフロー図あるといいかも",
          "created_at": "2026-02-06T10:00:00Z"
        }
      ]
    },
    "reactions": {
      "55": { "+1": 2, "rocket": 1 }
    }
  }
}
```

**元設計からの変更点:**
- `progress` フィールド削除 → state + Status の `done` フラグで自動算出（ランタイム計算）
- `github_repo` フィールド追加 → 複数リポジトリ横断対応

### 進捗率の算出

手動入力なし。Issueのstateおよびカスタムステータスの `done` フラグに基づく自動算出。

- **末端タスク**: Issue が closed、または Status が `done: true` なら 100%。それ以外は 0%
- **親タスク**: 完了子数 / 全子数 × 100%（再帰的に算出）
- 進捗率は保存せず、表示時にランタイム算出する

### タスクフィールドの同期区分

| フィールド | 同期方向 | 備考 |
|---|---|---|
| title | 双方向 | |
| body | 双方向 | Issue本文まるごと |
| state, state_reason | 双方向 | |
| assignees | 双方向 | |
| labels | 双方向 | type判別にも利用 |
| milestone | 双方向 | |
| custom_fields | 双方向 | ProjectV2フィールド（Status含む） |
| parent, sub_tasks | 双方向 | Sub Issues APIと同期 |
| start_date, end_date | ローカルのみ※ | ※ProjectV2にDateフィールドがあれば双方向 |
| linked_prs | GitHub → ローカル | 自動検出 |
| created_at, updated_at, closed_at | GitHub → ローカル | 読み取り専用 |
| blocked_by | ローカルのみ | ブロック関係 |
| type | ローカル管理 | github_labelで自動判別可 |
| cache (comments, reactions) | GitHub → ローカル | 読み取りキャッシュ |

### タスクtypeと表示

| display | 表示 | 日付 | 備考 |
|---|---|---|---|
| `summary` | 括弧型バー / 太バー | sub_tasksから自動算出 | epic, feature等の親タスク |
| `bar` | 通常バー | start_date / end_date | task, bug等の実作業 |
| `milestone` | ◆ダイヤモンド | `date`（単一日付） | リリース日等 |

### blocked_by のtype

| type | 意味 |
|---|---|
| `finish-to-start` | Aが完了しないとBを開始できない (FS) |
| `finish-to-finish` | Aが完了しないとBを完了できない (FF) |
| `start-to-start` | Aが開始しないとBを開始できない (SS) |
| `start-to-finish` | Aが開始しないとBを完了できない (SF) |

### sync-state.json（内部状態）

```json
{
  "last_synced_at": "2026-02-09T10:00:00Z",
  "project_node_id": "PVT_xxx",
  "id_map": {
    "e1": { "issue_number": 10, "issue_node_id": "I_aaa", "project_item_id": "PVTI_aaa" },
    "f1": { "issue_number": 42, "issue_node_id": "I_bbb", "project_item_id": "PVTI_bbb" },
    "t1": { "issue_number": 55, "issue_node_id": "I_ccc", "project_item_id": "PVTI_ccc" },
    "t2": { "issue_number": 60, "issue_node_id": "I_ddd", "project_item_id": "PVTI_ddd" }
  },
  "field_ids": {
    "Start Date": "PVTF_xxx",
    "End Date": "PVTF_yyy",
    "Status": "PVTSSF_zzz",
    "Sprint": "PVTIF_www",
    "Estimate": "PVTNF_vvv"
  },
  "snapshots": {
    "e1": { "hash": "abc123", "synced_at": "2026-02-09T10:00:00Z" },
    "f1": { "hash": "def456", "synced_at": "2026-02-09T10:00:00Z" },
    "t1": { "hash": "ghi789", "synced_at": "2026-02-09T10:00:00Z" }
  }
}
```

---

## プロジェクト構成

```
gh-gantt/
├── packages/
│   ├── cli/                         # CLIツール（同期エンジン + サーバー）
│   │   ├── src/
│   │   │   ├── index.ts             # エントリポイント
│   │   │   ├── commands/
│   │   │   │   ├── init.ts          # プロジェクト初期化
│   │   │   │   ├── pull.ts          # GitHub → Local
│   │   │   │   ├── push.ts          # Local → GitHub
│   │   │   │   ├── serve.ts         # UI起動（メインの使い方）
│   │   │   │   └── status.ts        # 差分プレビュー
│   │   │   ├── github/
│   │   │   │   ├── client.ts        # GraphQLクライアント
│   │   │   │   ├── auth.ts          # gh auth token 取得
│   │   │   │   ├── queries.ts       # GraphQLクエリ定義
│   │   │   │   ├── mutations.ts     # GraphQLミューテーション定義
│   │   │   │   ├── issues.ts        # Issue操作（body含む）
│   │   │   │   ├── projects.ts      # ProjectV2操作
│   │   │   │   └── sub-issues.ts    # Sub Issues API（parent/sub_tasks同期）
│   │   │   ├── sync/
│   │   │   │   ├── diff.ts          # 差分計算
│   │   │   │   ├── conflict.ts      # コンフリクト検出
│   │   │   │   ├── mapper.ts        # GitHub ↔ Local フィールドマッピング
│   │   │   │   ├── type-resolver.ts # github_label → task type 解決
│   │   │   │   └── hash.ts          # スナップショットハッシュ生成
│   │   │   ├── store/
│   │   │   │   ├── tasks.ts         # tasks.json 読み書き
│   │   │   │   ├── state.ts         # sync-state.json 管理
│   │   │   │   └── config.ts        # gantt.config.json 管理
│   │   │   └── server/
│   │   │       └── api.ts           # REST API（UI用: tasks CRUD, sync trigger）
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── ui/                          # ツリー＋ガント一体型UI（メインインターフェース）
│       ├── src/
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── Layout.tsx               # リサイズ可能な2ペインレイアウト
│       │   │   ├── TaskTree.tsx             # 左ペイン: タスクツリー
│       │   │   ├── TaskRow.tsx              # ツリー行（タイトル、進捗率、ステータスバッジ）
│       │   │   ├── StatusBadge.tsx          # 色付きステータスバッジ
│       │   │   ├── ProgressBar.tsx          # 進捗率バー（自動算出値を表示）
│       │   │   ├── TypeFilter.tsx           # typeフィルタ（epicだけ表示等）
│       │   │   ├── GanttChart.tsx           # 右ペイン: ガントメインコンテナ
│       │   │   ├── GanttTimeline.tsx        # 時間軸ヘッダー（日/週/月切替）
│       │   │   ├── GanttGrid.tsx            # 背景グリッド線（非稼働日グレーアウト）
│       │   │   ├── GanttBar.tsx             # タスクバー（ドラッグ&リサイズ対応）
│       │   │   ├── GanttSummaryBar.tsx      # summaryタスクの括弧型バー
│       │   │   ├── GanttMilestone.tsx       # milestone(◆)表示
│       │   │   ├── GanttBlockLines.tsx      # blocked_byの接続矢印(SVG path)
│       │   │   ├── Toolbar.tsx              # ズーム、typeフィルタ、表示切替、pull/push
│       │   │   ├── TaskDetailPanel.tsx      # タスク詳細サイドパネル
│       │   │   └── MarkdownEditor.tsx       # Markdown編集（textarea + プレビュー）
│       │   ├── hooks/
│       │   │   ├── useApi.ts                # REST API通信
│       │   │   ├── useGanttScale.ts         # D3 scaleTime / scaleBand管理
│       │   │   ├── useDragResize.ts         # d3-drag でバー移動・リサイズ
│       │   │   ├── useTypeFilter.ts         # typeフィルタ状態管理
│       │   │   └── useTaskTree.ts           # parent/sub_tasks階層のツリー構築
│       │   ├── lib/
│       │   │   ├── progress.ts              # 進捗率算出（state + Status done フラグ）
│       │   │   ├── dependency-graph.ts      # DAGベースのブロック関係グラフ
│       │   │   ├── summary-calc.ts          # summaryタスクの期間自動算出
│       │   │   └── date-utils.ts            # 営業日計算、日付ヘルパー
│       │   └── types/
│       │       └── index.ts
│       ├── package.json
│       └── vite.config.ts
│
├── packages/shared/                  # CLI/UI共有
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts                  # Task, Config等の型
│   │   ├── schema.ts                 # zodスキーマ
│   │   └── constants.ts
│   └── package.json
│
├── gh-gantt                          # gh extension エントリポイント（シェルスクリプト）
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── LICENSE                           # MIT
└── README.md
```

**元設計からの変更点:**
- `commands/sync.ts` 削除（v0.1スコープ外）
- `sync/engine.ts` 削除（v0.1では pull/push 分離で対応）
- `server/ws.ts` 削除（WebSocketはv0.1スコープ外、REST APIのみ）
- `store/schema.ts` → `shared/schema.ts` に統合
- UI コンポーネントを再編成（ツリー＋ガント一体型に対応）
- `GanttProgressBar.tsx` 削除（進捗率はツリー側の ProgressBar で表示）
- `CriticalPath.tsx`, `useCriticalPath.ts` 削除（v0.1スコープ外）
- `ResourceView.tsx`, `MiniMap.tsx` 削除（v0.1スコープ外）
- `useVirtualScroll.ts`, `useAutoSchedule.ts`, `useWebSocket.ts`, `useUndoRedo.ts` 削除（v0.1スコープ外）
- `scheduler.ts`, `layout.ts`, `export.ts` 削除（v0.1スコープ外）
- `StatusBadge.tsx`, `ProgressBar.tsx`, `MarkdownEditor.tsx`, `Layout.tsx` 追加
- `github/auth.ts` 追加
- `gh-gantt` シェルスクリプト（extension エントリポイント）追加

---

## CLIコマンド仕様

### `gh gantt init`

```bash
gh gantt init --owner stanah --repo my-repo --project 1
```

処理:
1. `gh auth token` でトークン取得
2. ProjectV2 GraphQL APIでProject情報・全アイテム・全Issue詳細(body含む)取得
3. Sub Issues APIで親子関係取得
4. ラベルからtype自動判別
5. Statusフィールドの選択肢を自動取得 → `statuses` 設定を初期生成
6. `.gantt-sync/gantt.config.json`, `tasks.json`, `sync-state.json` を生成
7. カスタムフィールドのマッピングを自動検出

### `gh gantt serve`（メインコマンド）

```bash
gh gantt serve                   # localhost:3000 でUI起動
gh gantt serve --port 8080
gh gantt serve --sync-on-start   # 起動時に自動pull
```

処理:
1. ViteでReact UIを起動
2. REST APIサーバー(port+1): tasks CRUD, sync trigger, config取得
3. UI上の全編集 → REST API → tasks.json書き込み
4. pull/pushはUIのボタンまたはCLIで手動トリガー

### `gh gantt pull`

```bash
gh gantt pull                    # GitHub → Local
gh gantt pull --force            # GitHub側で上書き
```

### `gh gantt push`

```bash
gh gantt push                    # Local → GitHub
gh gantt push --dry-run          # 変更プレビュー
gh gantt push --create-issues    # ローカル専用タスクをIssue化
```

### `gh gantt status`

```bash
gh gantt status
```

出力例:
```
Remote changes (since last sync):
  M  t1 "OAuth2プロバイダ実装" — state: open → closed, body updated
  +  #70 "セッション管理" — new issue (not in local)

Local changes:
  M  t2 "トークンリフレッシュ" — end_date: 2/20 → 2/22
  +  t5 "デプロイ準備" — new local task (no issue)

Conflicts: none
```

---

## ツリー＋ガント一体型UI 機能仕様

### レイアウト

左ペインにタスクツリー、右ペインにガントタイムライン。中央の境界はドラッグでリサイズ可能。

### 左ペイン（タスクツリー）

- parent/sub_tasks に基づく階層ツリー表示
- 各行に: タスクタイトル、type アイコン/色、進捗率バー、色付きステータスバッジ
- 折りたたみ/展開トグル
- typeフィルタ（Epicだけ表示、Task+Bugだけ表示 等）

### 右ペイン（ガントタイムライン）

- **タイムラインヘッダー**: 日/週/月切替。上段に月名、下段に日付or週番号
- **タスクバー**: type.displayに応じた描画
  - `bar`: 水平バー（task_typesの色で塗り）
  - `summary`: 括弧型バー（sub_tasksの期間を自動算出）
  - `milestone`: ◆ダイヤモンド
- **色**: ガントバーはtask_typesで定義した色。ステータスはツリーのバッジで表示（混在しない）
- **今日線**: 赤い縦線
- **背景グリッド**: working_days設定に基づき非稼働日グレーアウト

### ステータス表示

- gantt.config.json の `statuses` でカスタム定義（名前、色、doneフラグ）
- ツリーの各タスク行にステータスバッジとして色付き表示
- `init` 時にProjectV2のStatus選択肢を自動取得して初期生成

### typeフィルタ

- task_typesの全typeをON/OFFトグル
- epicだけ表示 → 全体俯瞰
- task + bugだけ表示 → 実作業ビュー
- summaryタスクの期間はフィルタ後の可視子タスクから再算出

### ブロック関係（blocked_by）

- SVG `<path>` で FS/FF/SS/SF の4種を描画
- 接続先に三角矢印
- lag > 0 は点線区間
- 循環検出時は赤色警告

### 親子関係（parent / sub_tasks）

- Sub Issues APIと双方向同期
- summaryタスクのバーは子の最早開始〜最遅終了を自動算出
- ツリー折りたたみ/展開

### インタラクション（v0.1）

- **バードラッグ**: 期間を前後にスライド
- **バーリサイズ**: 開始日/終了日を個別調整
- **ダブルクリック**: TaskDetailPanel を開く
- **ズーム**: マウスホイール or ツールバー

### TaskDetailPanel（サイドパネル）

- タイトル編集
- body（Markdownレンダリング + 編集）
- state / Status（ドロップダウン） / assignees / labels / milestone
- type選択
- 日付ピッカー
- blocked_by / blocking 一覧
- parent / sub_tasks 一覧（編集可能）
- linked PRs（ステータス付き、読み取り専用）
- コメント一覧（キャッシュ、読み取り専用）
- GitHub Issueへの直リンク

### UIからの編集フロー

1. UIで編集 → REST API → tasks.json に即時書き込み
2. ユーザーが明示的に `push`（UIのボタン or CLI）で GitHub に反映
3. push 前に `status` 相当の差分プレビューを表示

---

## 同期エンジン詳細

### 方針（v0.1）

- `pull` と `push` は別コマンド。`sync`（双方向自動同期）はv0.1では提供しない
- コンフリクト（同一フィールドに双方変更あり）は検出して警告表示。自動解決はしない
- serve中の同期は手動トリガー（UIのボタンまたはCLI）

### 差分検出

```
1. ローカルの各タスク:
   sync-state.jsonのスナップショットハッシュと現在値を比較
   （ハッシュ対象: 双方向同期フィールドのみ。blocked_by等は対象外）

2. リモートの各アイテム:
   GraphQL APIで最新取得 → スナップショットハッシュと比較

3. 同一タスク・同一フィールドに双方変更 → conflict（警告表示）
4. 片方のみ変更 → 変更側を採用
5. リモートのみに存在 → new_remote（tasks.jsonに追加、github_labelでtype判別）
6. ローカルのみに存在(github_issue != null) → deleted_remote（要確認）
```

### コンフリクト検出

CLI / UI ともに警告表示し、ユーザーに手動解決を委ねる:
```
⚠️  Conflict: t1 "OAuth2プロバイダ実装"

  title:
    Local:  "OAuth2プロバイダ実装（PKCE対応）"
    Remote: "OAuth2プロバイダ実装"

  body:
    Local:  [3 lines changed]
    Remote: [5 lines changed]
```

---

## D3.js利用方針

ReactにDOM管理を委ね、D3はスケール計算・パス生成に限定。

```tsx
// D3はスケール計算のみ、ReactがDOM描画
const xScale = useMemo(
  () => d3.scaleTime().domain([startDate, endDate]).range([0, width]),
  [startDate, endDate, width]
);
return tasks.map(t => (
  <rect
    x={xScale(t.start_date)}
    width={xScale(t.end_date) - xScale(t.start_date)}
    fill={config.task_types[t.type].color}
  />
));
```

個別インポート: `d3-scale`, `d3-time`, `d3-shape`, `d3-drag`

### パフォーマンス（将来対応）

- 1000タスク超 → 仮想スクロール
- SVG描画は表示範囲のみ（viewport culling）
- ブロック線再計算はdebounce
- summaryタスク期間算出はメモ化

---

## 実装フェーズ

### v0.1: ツリー＋ガント一体型 + Pull/Push

**ゴール**: GitHub Projectから全データを同期し、ツリー＋ガント一体型UIで階層的進捗を表示・編集

詳細な実装計画: `docs/plans/2026-02-09-gh-gantt-v0.1-implementation.md`

**v0.1 に含めるもの:**
- CLI: `gh gantt init`, `pull`, `push`, `serve`, `status`
- 同期: pull(GitHub→Local), push(Local→GitHub), コンフリクト検出＋警告
- メイン画面: ツリー＋ガント一体型ビュー
- ツリー（左）: 階層表示、折りたたみ、進捗率バー、ステータスバッジ（色付き）、typeフィルタ
- ガント（右）: タイムライン（日/週/月）、bar/summary/milestone描画、blocked_by矢印、今日線、非稼働日グレーアウト、ズーム
- 編集: state, Status, title, body, assignees, labels, 親子関係, バードラッグ（日付変更）、バーリサイズ
- サイドパネル: タスク詳細表示＋編集（body Markdown対応）
- 設定: task_types/type_hierarchy カスタム定義、statuses カスタム定義（init時自動生成）
- データ: 複数リポジトリ横断を想定したデータモデル

### v0.2以降（将来フェーズ）

| 機能 | 備考 |
|---|---|
| `gh gantt sync`（双方向自動同期） | コンフリクト自動解決含む |
| クリティカルパス計算 | CPM forward/backward pass |
| WebSocketリアルタイム通信 | serve中の即時反映 |
| TUI | ターミナルでのツリー＋進捗表示 |
| サマリーダッシュボード | Epic一覧＋進捗率バー |
| ResourceView | アサイニーごとの負荷ビュー |
| MiniMap | 全体俯瞰ミニマップ |
| 仮想スクロール | 1000タスク超対応 |
| SVG/PNGエクスポート | |
| Undo/Redo | Ctrl+Z / Ctrl+Shift+Z |
| ブロック線インタラクティブ追加 | タスクバー端からドラッグ接続 |
| 自動スケジューリング | blocked_byに基づく日程自動調整 |

---

## gh CLI 統合

```typescript
async function getToken(): Promise<string> {
  const { stdout } = await execFile("gh", ["auth", "token"]);
  return stdout.trim();
}
```

インストール:
```bash
gh extension install stanah/gh-gantt
```

---

## 参考リソース

- [GitHub ProjectV2 GraphQL API](https://docs.github.com/en/graphql/reference/objects#projectv2)
- [GitHub Sub Issues API](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)
- [GitHub CLI Extensions](https://docs.github.com/en/github-cli/github-cli/creating-github-cli-extensions)
- [D3.js](https://d3js.org/) — MIT License
- [zod](https://zod.dev/) — MIT License
- [Commander.js](https://github.com/tj/commander.js) — MIT License
- [@octokit/graphql](https://github.com/octokit/graphql.js) — MIT License
