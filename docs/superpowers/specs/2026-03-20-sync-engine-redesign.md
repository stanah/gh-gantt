# Sync Engine Redesign: Git-Model 3-Way Merge

## Overview

gh-gantt の同期エンジンを再設計し、git の同期モデルに準拠したフィールド単位の 3-way merge を実現する。ローカル編集が pull で暗黙的に失われる問題を解消し、コンフリクト解決を明示的かつ安全なプロセスにする。

## Background

### 現状の問題

1. **`conflict_strategy` が未実装** — config に `"remote-wins"` と定義されているが、コードでは参照されず常に remote-wins 固定
2. **フィールド単位のマージがない** — コンフリクト時、タスク全体を「リモートで上書き」か「ローカル保持」の二択。例: ローカルで `state: closed` にしつつリモートで `start_date` が変わった場合、両方の反映ができない
3. **push 時にコンフリクト検出がない** — push → pull の順で操作すると、push した変更が次の pull で上書きされる
4. **ローカル編集の保護がない** — 未 push の変更がある状態で pull すると警告なしに上書きされる

### 設計原則

git のメンタルモデルに準拠する:

| git                            | gh-gantt sync                                            |
| ------------------------------ | -------------------------------------------------------- |
| merge base (共通祖先)          | snapshot (前回同期時点のデータ)                          |
| ローカルブランチ               | `tasks.json` のローカル状態                              |
| リモートブランチ               | GitHub Projects の状態                                   |
| `git pull` (fetch + merge)     | `gh-gantt pull` = fetch + フィールド単位 3-way merge     |
| `git push` (fast-forward のみ) | `gh-gantt push` = リモート未変更なら適用、変更あれば拒否 |
| merge conflict                 | 同一フィールドが双方で変更 → コンフリクトマーカー記録    |
| conflict resolution            | `gh-gantt resolve` で CLI 解決                           |
| `push --force`                 | リモート変更チェックをスキップして強制 push (警告付き)   |

## Architecture

### モジュール構成

```
packages/cli/src/sync/
├── hash.ts              # 流用 (変更なし)
├── three-way-merge.ts   # 新規: フィールド単位 3-way merge
├── conflict-marker.ts   # 新規: _incoming/_current キーの読み書き
├── diff.ts              # 流用 (変更なし)
├── pull-executor.ts     # 新規: pull フロー
├── push-executor.ts     # 改修: リモート変更チェック追加
├── mapper.ts            # 改修: mergeRemoteIntoLocal 削除
└── type-resolver.ts     # 流用 (変更なし)

packages/cli/src/commands/
├── pull.ts              # 改修: 未push変更ガード追加
├── push.ts              # 改修: リモート変更ガード追加
├── conflicts.ts         # 新規: gh-gantt conflicts コマンド
└── resolve.ts           # 新規: gh-gantt resolve コマンド
```

### 状態遷移

```
[clean]  ──push──>  [clean]
   │                   │
 local edit        remote edit
   │                   │
   v                   v
[dirty]            [behind]
   │                   │
   └──── pull ────>  [merging]
                       │
               ┌───────┴───────┐
          no conflict      conflict
               │               │
               v               v
           [clean]      [conflicted]
                               │
                          resolve
                               │
                               v
                           [clean]
```

## Components

### 1. three-way-merge.ts — フィールド単位 3-way merge

```typescript
interface MergeResult {
  merged: Task;
  conflicts: FieldConflict[];
}

interface FieldConflict {
  field: string; // "state", "start_date" etc.
  base: unknown; // snapshot の値
  current: unknown; // ローカルの値
  incoming: unknown; // リモートの値
}

function threeWayMerge(base: SyncFields, current: SyncFields, incoming: SyncFields): MergeResult;
```

マージロジック (各フィールドについて):

| base == current | base == incoming | current == incoming | 結果                                |
| --------------- | ---------------- | ------------------- | ----------------------------------- |
| true            | true             | true                | 変更なし (base 採用)                |
| true            | false            | -                   | リモートだけ変更 (incoming 採用)    |
| false           | true             | -                   | ローカルだけ変更 (current 採用)     |
| false           | false            | true                | 同じ値に変更 (current 採用)         |
| false           | false            | false               | コンフリクト (FieldConflict に記録) |

比較は JSON.stringify による deep equality。比較前に正規化を行う:

- `assignees`, `labels`, `sub_tasks`: `.sort()` でソート
- `blocked_by`: `.task` でソートし、同一 task の `type`/`lag` も比較対象
- `custom_fields`: キーをソートしてから stringify
  この正規化は既存の `extractSyncFields()` と同じロジックを使用する。

### 2. conflict-marker.ts — JSON コンフリクトマーカー

```typescript
// コンフリクトマーカーをタスクデータに書き込む
function applyConflictMarkers(task: Task, conflicts: FieldConflict[]): Record<string, unknown>;
// → { "state": "open", "state_current": "open", "state_incoming": "closed", ... }
// コンフリクトしたフィールドの値は current 側を本体に設定

// タスクデータからコンフリクトマーカーを検出
function detectMarkers(task: Record<string, unknown>): FieldConflict[];

// マーカーを解決して除去
function resolveMarker(
  task: Record<string, unknown>,
  field: string,
  choice: "ours" | "theirs",
): void;

// 未解決マーカーの有無
function hasUnresolvedMarkers(task: Record<string, unknown>): boolean;
```

マーカーの命名規則:

- `{field}_current` — ローカル側の値
- `{field}_incoming` — リモート側の値
- 本体の `{field}` には current の値を設定 (resolve するまでローカル値が見える)

### 3. pull フロー

```
gh-gantt pull
  │
  ├─ 1. 未解決コンフリクトマーカーが残っているか? (has_conflicts フラグ)
  │     ├─ あり → エラー終了
  │     │   "未解決のコンフリクトがあります。先に resolve してください"
  │     └─ なし → 続行
  │
  │  ※ 未 push のローカル変更があっても pull は常に実行可能。
  │    3-way merge により安全にマージされ、ローカル変更は保持される。
  │
  ├─ 2. リモート取得 (fetch items, milestones, sub-issues, blocked_by)
  │
  ├─ 3. 各タスクを処理
  │     ├─ snapshot なし (新規リモートタスク) → そのまま追加
  │     ├─ リモートに存在 + snapshot あり → 3-way merge
  │     │     ├─ マージ成功 (コンフリクトなし) → マージ結果を採用
  │     │     └─ コンフリクトあり → マーカーを書き込み
  │     ├─ リモートに不在 + snapshot あり + ローカル未変更 → 削除
  │     ├─ リモートに不在 + snapshot あり + ローカル変更あり → delete/modify コンフリクト
  │     │     → 警告表示し、タスクを保持 (ユーザーが手動で削除 or push で再作成)
  │     └─ draft タスク → 常に保持 (pull の対象外)
  │
  ├─ 4. tasks.json 書き出し (マーカー付きタスク含む)
  │
  ├─ 5. snapshot 更新
  │     ├─ コンフリクトなしタスク → hash, remoteHash, syncFields 更新
  │     ├─ コンフリクトありタスク → remoteHash のみ更新 (hash は据え置き)
  │     └─ 削除タスク → snapshot 削除
  │
  ├─ 6. read-only フィールドの更新
  │     コンフリクトの有無に関わらず、以下はリモートから常に上書き:
  │     created_at, updated_at, closed_at, state_reason, linked_prs, github_issue, github_repo
  │
  └─ 7. サマリー出力
        "+3 added  ~5 updated  !2 conflicts  -1 removed"
```

### 4. push フロー

```
gh-gantt push
  │
  ├─ 1. 未解決コンフリクトマーカーが残っているか?
  │     ├─ あり → エラー終了
  │     └─ なし → 続行
  │
  ├─ 2. リモート変更チェック (lightweight fetch)
  │     変更対象タスクの updated_at を GitHub API で取得し、
  │     snapshot の updated_at と比較する (全フィールド再取得は不要)
  │     ├─ リモートが変わっている → エラー終了
  │     │   "リモートが更新されています。先に pull してください"
  │     │   (--force で強制 push 可能)
  │     └─ 変わっていない → 続行
  │
  ├─ 3. push 実行 (既存ロジック: draft作成, 更新, 関係性同期)
  │
  └─ 4. snapshot 更新 (hash = remoteHash = pushed state)
```

### 5. --force の挙動

| コマンド       | `--force` の効果                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `pull`         | `--force` 不要。未 push のローカル変更があっても常に実行可能。未解決コンフリクトのみブロック         |
| `push --force` | ステップ2 (リモート変更チェック) をスキップ。ステップ1 (未解決コンフリクトチェック) はスキップしない |

未解決コンフリクトは `--force` でもスキップできない。必ず `resolve` が必要。

### 6. conflicts コマンド

```bash
# 一覧表示
gh-gantt conflicts
  #8:  ツリー表示でのドラッグ&ドロップによる依存関係付け替え
    state:      current=open     incoming=closed    base=open
    start_date: current=2026-02-11  incoming=2026-03-01  base=2026-02-01

  #11: Markdown表示対応
    milestone:  current=v1.0     incoming=v2.0      base=null

  2 tasks, 3 conflicts

# 特定タスク
gh-gantt conflicts 8

# コンフリクトなし
gh-gantt conflicts
  No conflicts.
```

実装: `tasks.json` を `WithConflicts` スキーマで読み、`detectMarkers()` で各タスクのマーカーを走査。`base` 値は snapshot の `syncFields` から取得。

### 7. resolve コマンド

```bash
# インタラクティブ (1フィールドずつ選択)
gh-gantt resolve

# タスク指定
gh-gantt resolve 8

# 一括解決
gh-gantt resolve --ours           # 全コンフリクトをローカル側で
gh-gantt resolve --theirs         # 全コンフリクトをリモート側で
gh-gantt resolve 8 --ours         # #8 をローカル側で
gh-gantt resolve 8 --theirs      # #8 をリモート側で

# フィールド指定
gh-gantt resolve 8 --field state --theirs
gh-gantt resolve 8 --field start_date --ours
```

解決後の処理:

1. マーカーキー (`_current`, `_incoming`) を除去
2. 選択した値を本来のフィールドに設定
3. `tasks.json` を書き出し
4. snapshot の `hash` を更新 (解決後の状態でハッシュ再計算)
5. 全タスクのコンフリクト解決後、`has_conflicts` を `false` に設定

## Data Model Changes

### TasksFile — has_conflicts フラグ追加

```typescript
interface TasksFile {
  tasks: Task[];
  cache?: TasksCache; // 既存フィールド (comments, reactions) — 変更なし
  has_conflicts?: boolean; // pull がコンフリクトを残した場合 true
}
```

`has_conflicts` により `tasks.json` 全体を走査せずにコンフリクト中かどうか即判定可能。既存の `cache` フィールドはそのまま保持。

### ConflictStrategy — 削除

```typescript
// 削除: "remote-wins" | "local-wins" | "manual"
// 3-way merge が常に動作し、衝突時のみ resolve で解決
```

config から `conflict_strategy` を除去。ただし既存 config との互換性のため、ConfigSchema は `.passthrough()` で未知キーを許容。

### Zod スキーマ — 2層構成

```typescript
// 通常読み込み (マーカーなし前提)
TasksFileSchema;

// コンフリクト状態の読み込み (マーカーキー許容)
TasksFileWithConflictsSchema; // tasks 配列内の各タスクに .passthrough()
```

- read: まず `WithConflicts` で読み、`has_conflicts` フラグを確認
- write: マーカー付きタスクはそのまま書き出し
- push 前チェック: `has_conflicts` フラグで即判定 → true なら拒否

マーカーのバリデーション (`detectMarkers` 内):

- `{field}_current` があるのに `{field}_incoming` がない場合 (またはその逆) → 警告を出しつつ、ペアが揃っているもののみコンフリクトとして扱う
- `SyncFields` に存在しないフィールドのマーカー → 無視
- マーカー値の型チェックは行わない (resolve 時に選択した値をそのまま設定するため)

## File Changes

### 削除

| ファイル           | 理由                                                   |
| ------------------ | ------------------------------------------------------ |
| `sync/conflict.ts` | `three-way-merge.ts` + `conflict-marker.ts` に置き換え |

### 改修

| ファイル                | 変更内容                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `sync/mapper.ts`        | `mergeRemoteIntoLocal` 削除。`mapRemoteItemToTask` は残す                           |
| `sync/push-executor.ts` | リモート変更チェック追加。マーカーチェック追加                                      |
| `commands/pull.ts`      | 未push変更ガード追加。マージロジックを three-way-merge + conflict-marker に差し替え |
| `commands/push.ts`      | マーカーチェック追加                                                                |
| `shared/types.ts`       | `ConflictStrategy` 削除。`TasksFile` に `has_conflicts` 追加                        |
| `shared/schema.ts`      | `TasksFileWithConflictsSchema` 追加。`ConflictStrategySchema` 削除                  |
| `store/tasks.ts`        | 読み込み時に `WithConflicts` スキーマを使い分け                                     |

### 新規

| ファイル                  | 役割                           |
| ------------------------- | ------------------------------ |
| `sync/three-way-merge.ts` | フィールド単位 3-way merge     |
| `sync/conflict-marker.ts` | マーカーの読み書き・検出・解決 |
| `commands/conflicts.ts`   | `gh-gantt conflicts` コマンド  |
| `commands/resolve.ts`     | `gh-gantt resolve` コマンド    |

## UI Behavior (gh-gantt serve)

コンフリクト状態での UI の振る舞い:

- **GET /api/tasks**: `has_conflicts` フラグとマーカー付きタスクをそのまま返す。UI 側は `_current` / `_incoming` キーを `.passthrough()` で受け入れる
- **バナー警告**: `has_conflicts === true` の場合、画面上部に「未解決のコンフリクトがあります。CLI で `gh-gantt resolve` を実行してください」と表示
- **コンフリクトタスクの表示**: タスク行に警告アイコンを表示。TaskDetailPanel でコンフリクトフィールドを強調表示
- **編集制限**: コンフリクト中のタスクのフィールド編集は無効化 (resolve してから編集)
- **push ボタン**: `has_conflicts === true` の場合、push ボタンを無効化

※ UI でのコンフリクト解決機能は将来的な拡張。初期実装は CLI のみ。

## Breaking Changes

- `gantt.config.json` から `conflict_strategy` が消える — ConfigSchema を `.passthrough()` にすることで既存 config は読み込み可能
- `pull` の挙動変更: 未解決コンフリクトがある場合のみ中断。未 push 変更があっても常に実行可能 (3-way merge で安全にマージ)
- `push` の挙動変更: リモート変更があると中断 — `--force` で従来動作

## Conflict Resolution Skill

### 配置

```
.claude/skills/conflict-resolution/SKILL.md
```

### トリガー

- `gh-gantt pull` 後にコンフリクトが発生した場合
- ユーザーが「コンフリクトを解決して」と指示した場合

### ワークフロー

```
1. gh-gantt conflicts でコンフリクト一覧を取得
2. 各コンフリクトについて:
   a. current / incoming / base の値を確認
   b. コンテキストから適切な値を判断
   c. gh-gantt resolve <issue> --field <field> --ours/--theirs で解決
3. gh-gantt conflicts で全解決を確認
4. 必要に応じて gh-gantt push を提案
```

### 判断基準

| フィールド                | 判断方針                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `state`                   | ローカルで closed にしたなら実装完了の意図 → ours 優先。PR 未マージなら theirs         |
| `start_date` / `end_date` | リモート側がプロジェクト全体のスケジュール調整なら theirs。ローカルが作業実績なら ours |
| `milestone`               | リモート側の変更を尊重 (プロジェクト管理者の意図) → theirs 優先                        |
| `assignees` / `labels`    | リモート側を尊重 → theirs 優先                                                         |
| 判断がつかない場合        | ユーザーに確認する                                                                     |

## Testing Strategy

- `three-way-merge.ts`: 全パターンの単体テスト (変更なし/片方変更/両方変更/同値変更/コンフリクト)
- `conflict-marker.ts`: マーカー書き込み・検出・解決の単体テスト
- pull フロー: 未push変更ガード、マーカーチェック、3-way merge 統合テスト
- push フロー: リモート変更チェック、マーカーチェックの統合テスト
- conflicts/resolve コマンド: CLI 出力の統合テスト
