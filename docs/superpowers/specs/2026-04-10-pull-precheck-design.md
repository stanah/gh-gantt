# pull の GraphQL pre-check モード設計

**Issue**: #157
**日付**: 2026-04-10

## 背景

`gh-gantt pull` は変化がない場合でも毎回 ProjectV2 の全 items を GraphQL で取得している（100件/page でページネーション）。quick-skip 判定は fetchProject の **後** で行われるため、変化なし時でも全 API コストが発生する。

## 目的

変化がない場合の API アクセスを削減し、pull の応答速度を改善する。

## 設計

### GraphQL pre-check クエリ

```graphql
query ($owner: String!, $repo: String!, $since: DateTime!) {
  repository(owner: $owner, name: $repo) {
    issues(filterBy: { since: $since }, first: 1) {
      totalCount
    }
  }
}
```

- `since` に `SyncState.last_synced_at` を渡す
- `totalCount > 0` → 変化あり → フル fetch へ
- `totalCount === 0` → 変化なし → skip

### 新規関数

`packages/cli/src/github/projects.ts` に追加:

```typescript
export async function checkRemoteChanges(
  gql: typeof graphql,
  owner: string,
  repo: string,
  since: string,
): Promise<boolean>;
```

- 戻り値: `true` = 変化あり、`false` = 変化なし

### PullOptions 拡張

```typescript
export interface PullOptions {
  force?: boolean;
  fullFetch?: boolean; // 追加
}
```

### pull-executor のフロー変更

```
[0] sync-state 検証（既存）
[1] pre-check 判定:
    - force=true → skip pre-check, フル fetch
    - fullFetch=true → skip pre-check, フル fetch
    - last_synced_at が空 → skip pre-check, フル fetch（初回同期）
    - それ以外 → checkRemoteChanges() 実行
      - false → skip（field_ids/option_ids は更新しない）
      - true → フル fetch へ
[2] fetchProject + fetchRepositoryMetadata（既存）
[3] quick-skip 判定（既存・そのまま残す）
[4] sub-issues fetch ...
```

pre-check skip 時の戻り値:

- `result.skipped = true`（既存の quick-skip と同じインターフェース）
- `syncState` はそのまま返す（field_ids/option_ids の更新なし）
- `syncStateFindings` は返す（検証は実行済み）

### 既存 quick-skip との関係

- pre-check は「issue の更新有無」のみ判定（粗いフィルタ）
- 既存 quick-skip は「全 items の updatedAt 一致」を厳密判定（細かいフィルタ）
- 両方残す。pre-check を通過しても quick-skip で止まるケースがある

### コマンドオプション

`pull.ts` に `--full-fetch` オプションを追加:

```typescript
.option("--full-fetch", "Skip pre-check and always fetch all project data")
```

各オプションの組み合わせ:

| オプション     | pre-check |   full fetch   | quick-skip |
| -------------- | :-------: | :------------: | :--------: |
| (なし)         |   実行    | 変化あり時のみ |    判定    |
| `--full-fetch` | スキップ  |      常に      |    判定    |
| `--force`      | スキップ  |      常に      |  スキップ  |

`--force` は `--full-fetch` を暗黙的に含む。

### 検知できないケース

GraphQL `issues(filterBy: { since })` では以下を検知できない:

- ProjectV2 カスタムフィールド（Status, Priority 等）の変更
- プロジェクトへの issue 追加/削除（issue body/title の変更なし）

これらは `--full-fetch` や定期的なフル同期で補完する。

## テスト計画

### pull-executor テスト

| #   | テスト                                     | 検証内容                                                                             |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | pre-check で変化なし → skip                | `checkRemoteChanges` が false → `fetchProject` が呼ばれない、`result.skipped = true` |
| 2   | pre-check で変化あり → フル fetch          | `checkRemoteChanges` が true → `fetchProject` が呼ばれる                             |
| 3   | `fullFetch=true` → pre-check スキップ      | `checkRemoteChanges` が呼ばれない、`fetchProject` が呼ばれる                         |
| 4   | `force=true` → pre-check スキップ          | 同上                                                                                 |
| 5   | `last_synced_at` が空 → pre-check スキップ | 初回同期時は必ずフル fetch                                                           |

### checkRemoteChanges 単体テスト

| #   | テスト                       | 検証内容                         |
| --- | ---------------------------- | -------------------------------- |
| 6   | `totalCount > 0` → `true`    | GraphQL レスポンスの正しいパース |
| 7   | `totalCount === 0` → `false` | 同上                             |

## 影響範囲

- `packages/cli/src/github/queries.ts` — pre-check クエリ定義追加
- `packages/cli/src/github/projects.ts` — `checkRemoteChanges()` 関数追加
- `packages/cli/src/sync/pull-executor.ts` — pre-check フロー挿入、`PullOptions.fullFetch` 追加
- `packages/cli/src/commands/pull.ts` — `--full-fetch` オプション追加
- テストファイル — 7件追加
