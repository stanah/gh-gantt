# Living Documentation 設計仕様

## 概要

gh-gantt に Living Documentation (Cyrille Martraire) の原則を適用し、要件-コード-テストのトレーサビリティを確立する。手書きドキュメントを最小化し、コードが正典として機能する体系を構築する。

## 前提

- **読み手**: 開発者本人 + AI エージェント
- **参考文献**: Cyrille Martraire, _Living Documentation: Continuous Knowledge Sharing by Design_ (Addison-Wesley, 2019)
  - ソース: https://github.com/cyriux/livingdocumentation-thebook

## 4層ドキュメント体系

| Layer                    | 内容                | Accuracy Mechanism           | 更新頻度     |
| ------------------------ | ------------------- | ---------------------------- | ------------ |
| 1. Evergreen             | 構造化要件 (YAML)   | めったに変わらない           | 低           |
| 2. ADR                   | 意思決定記録 (YAML) | 過去の記録で不変             | イベント駆動 |
| 3. Auto-Generated        | OpenAPI, TypeDoc    | Single Sourcing + Publishing | 自動         |
| 4. Tests as Requirements | テスト名に要件ID    | Reconciliation Mechanism     | 自動         |

**原則**: Layer 1 と 2 だけが人間が手で書く。Layer 1 はめったに変わらず、Layer 2 は書いた時点の記録で不変。Layer 3 と 4 はコードが正典。

## Layer 1: 構造化要件ドキュメント

### ファイル

`docs/requirements.yaml`

### スキーマ

```yaml
version: "1.0"
vision: |
  (プロダクトビジョン)

areas:
  - id: SYNC # 機能領域コード
    name: Sync Engine
    description: GitHub Projects (V2) との双方向同期
    requirements:
      - id: FR-SYNC-001 # FR=機能要件 / NFR=非機能要件
        summary: 3-way mergeによるコンフリクト検出
        acceptance_criteria:
          - id: FR-SYNC-001-AC1
            description: ローカル・リモート両方が変更した場合にコンフリクトを検出する
            status: covered # covered / uncovered / failing (自動更新)
            tests: # 自動更新
              - packages/cli/src/__tests__/three-way-merge.test.ts
```

### ID体系

```
FR-{AREA}-{NNN}              → 機能要件 (Functional Requirement)
NFR-{AREA}-{NNN}             → 非機能要件 (Non-Functional Requirement)
{prefix}-{AREA}-{NNN}-AC{N}  → 受入基準 (Acceptance Criteria)
```

機能領域コード: `SYNC`, `HIER`, `VIS`, `CLI`, `API`, `STORE`

### 振る舞い詳細の扱い

要件ドキュメントには「何を満たすか」を書き、「どう実現するか」は書かない。振る舞いの詳細はテスト (Layer 4) に委ねる。

## Layer 2: ADR (Architectural Decision Records)

### ファイル

`docs/adr/ADR-{NNN}-{slug}.yaml`

### スキーマ

```yaml
id: ADR-001
title: 同期エンジンに3-way mergeを採用
date: 2026-03-20
status: accepted # accepted / superseded / deprecated
context: |
  (意思決定の背景)
decision: |
  (採用した方針)
alternatives:
  - name: Last Write Wins
    reason_rejected: データ消失のリスクが高い
consequences:
  - (この決定がもたらす影響)
related_requirements:
  - FR-SYNC-001
```

### 設計判断

- `alternatives` に却下理由を必須とする。「rationale は却下された選択肢にこそある」(Martraire)
- `status` が superseded の場合、`superseded_by` フィールドに後続 ADR の ID を記載する
- `related_requirements` で要件への逆参照を持つ

### 既存スペックからの移行

`docs/superpowers/specs/` の 7 件から Why・却下された選択肢を ADR として抽出し、元ファイルは削除する。

## Layer 3: Auto-Generated Documents

### 3a: OpenAPI (Zod → OpenAPI)

**ツール**: `@asteasolutions/zod-to-openapi`

```
packages/shared/src/schema.ts  (正典: Zodスキーマ)
        ↓ 自動生成
docs/generated/openapi.yaml    (Published Snapshot)
```

`packages/cli/src/server/api.ts` のルート定義に Zod スキーマを適用し、リクエスト/レスポンスの型をスキーマから導出。API の契約が Zod スキーマに Single Sourcing される。

### 3b: TypeDoc

**対象**:

- `@gh-gantt/shared` — 型・スキーマのリファレンス
- `@gh-gantt/cli` — コマンド・同期エンジン・GitHub クライアントの公開 API

**対象外**: `@gh-gantt/ui` — React コンポーネントの内部 API はコードを直接読む方が有用。

```
packages/shared/src/**/*.ts    (正典)
packages/cli/src/**/*.ts
        ↓ TypeDoc
docs/generated/api/            (Published Snapshot)
```

### 生成ルール

- `docs/generated/` は `.gitignore` に追加。生成物はコミットしない
- `pnpm docs` で OpenAPI + TypeDoc を一括生成
- CI で生成スクリプトを実行し、エラーなく完了することを検証

## Layer 4: Tests as Requirements

### テスト名への要件IDタグ付け

```typescript
describe("[FR-SYNC-001-AC1] ローカル・リモート両方が変更した場合にコンフリクトを検出する", () => {
  it("同一フィールドの変更でコンフリクトを検出する", () => {
    // ...
  });
});
```

テスト名は日本語で記述する。AC の `description` がそのままテスト名の `describe` になる。

### テスト結果がそのまま要件充足レポート

```
 ✓ [FR-SYNC-001-AC1] ローカル・リモート両方が変更した場合にコンフリクトを検出する
 ✓ [FR-SYNC-001-AC2] コンフリクトマーカーを生成し、ユーザーに解決を促す
 ✗ [NFR-SYNC-001-AC1] push中にAPIエラーが発生してもsnapshotが不整合にならない
```

### 段階的導入

既存テストを全面的に書き直すのではなく、段階的に `[ID]` プレフィックスを追加する。新規テスト作成時はタグを必須とする。

## トレーサビリティの参照方向

| From          | To                                       | 手段                      | 維持方法 |
| ------------- | ---------------------------------------- | ------------------------- | -------- |
| 要件 → テスト | `requirements.yaml` の `tests`, `status` | スクリプト自動更新        |
| ADR → 要件    | ADR の `related_requirements`            | 手書き (作成時、以後不変) |
| テスト → 要件 | テスト名の `[ID]` プレフィックス         | 手書き (テスト作成時)     |

## 自動化スクリプト

### `scripts/req-trace.ts` (Reconciliation)

1. `vitest --reporter=json` の出力をパース
2. テスト名から `[ID]` を抽出
3. `requirements.yaml` の各 AC の `status` と `tests` を更新
4. 更新後の YAML を書き出し

### `scripts/req-validate.ts` (CI 検証)

以下を検出してエラーにする:

- **Orphaned AC**: `requirements.yaml` にあるがテストから参照されない AC
- **Orphaned Tag**: テスト名に ID があるが `requirements.yaml` に存在しない
- **Stale ADR Ref**: ADR の `related_requirements` が `requirements.yaml` に存在しない
- **Status Drift**: `requirements.yaml` の `status` が実際のテスト結果と不一致

### `scripts/docs-gen.ts` (Publishing)

1. Zod スキーマ → OpenAPI YAML 生成
2. TypeDoc 実行
3. `docs/generated/` に出力

### pnpm スクリプト統合

```json
{
  "req:trace": "vp exec scripts/req-trace.ts",
  "req:validate": "vp exec scripts/req-validate.ts",
  "docs": "vp exec scripts/docs-gen.ts"
}
```

### CI 統合

```yaml
- pnpm test -- --reporter=json --outputFile=test-results.json
- pnpm req:trace
- pnpm req:validate
- pnpm docs
```

## 既存ドキュメントの整理

| ファイル                        | 処分             | 理由                                                |
| ------------------------------- | ---------------- | --------------------------------------------------- |
| `PURPOSE.md`                    | 削除             | `requirements.yaml` の `vision` に統合              |
| `README.md`                     | 維持             | ユーザー向け Evergreen                              |
| `CLAUDE.md`                     | 維持             | 開発ガイド Evergreen                                |
| `docs/plans/` (3件)             | 削除             | 実装済み。ADR に抽出すべき Why があれば抽出後に削除 |
| `docs/superpowers/specs/` (7件) | ADR 抽出後に削除 | Why と却下された選択肢を ADR 化                     |
| `docs/superpowers/plans/` (9件) | 削除             | 実装済みの作業計画                                  |
| `skills/` (6件)                 | 維持             | gh-gantt の使い方ガイド (Evergreen)                 |

## ディレクトリ構成

```
docs/
  requirements.yaml            # Layer 1
  adr/                         # Layer 2
    ADR-001-*.yaml
    ADR-002-*.yaml
  generated/                   # Layer 3 (.gitignore)
    openapi.yaml
    api/
scripts/
  req-trace.ts                 # Reconciliation
  req-validate.ts              # CI 検証
  docs-gen.ts                  # Publishing
```
