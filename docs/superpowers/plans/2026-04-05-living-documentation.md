# Living Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gh-gantt に Living Documentation 体系を導入し、構造化要件 (YAML) → ADR → 自動生成ドキュメント → テストによる Reconciliation の4層トレーサビリティを確立する。

**Architecture:** `docs/requirements.yaml` が要件の正典。テスト名に `[ID]` プレフィックスを付与し、Vitest JSON 出力から Reconciliation スクリプトが `requirements.yaml` の `status`/`tests` を自動更新する。Zod スキーマから OpenAPI を、TypeDoc からモジュール API リファレンスを自動生成する。ADR は YAML で意思決定の Why を記録する。

**Tech Stack:** Zod, `@asteasolutions/zod-to-openapi`, TypeDoc, Vitest JSON reporter, yaml (npm), Node.js scripts

**Design Spec:** `docs/superpowers/specs/2026-04-04-living-documentation-design.md`

---

## File Structure

### 新規作成

| File                                                | Responsibility                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `docs/requirements.yaml`                            | Layer 1: 構造化要件 (vision, areas, requirements, acceptance_criteria) |
| `docs/adr/ADR-001-sync-engine-three-way-merge.yaml` | Layer 2: 同期エンジン 3-way merge の意思決定                           |
| `docs/adr/ADR-002-zod-schema-validation.yaml`       | Layer 2: ファイル読み込み時の Zod バリデーション                       |
| `docs/adr/ADR-003-git-like-sync-model.yaml`         | Layer 2: git ライク pull/push/conflict モデル                          |
| `docs/adr/ADR-004-cli-first-design.yaml`            | Layer 2: CLI ファーストの設計原則                                      |
| `docs/adr/ADR-005-local-first-data.yaml`            | Layer 2: ローカルファーストのデータ管理                                |
| `docs/adr/ADR-006-cicd-pipeline.yaml`               | Layer 2: CI/CD パイプライン設計                                        |
| `scripts/req-trace.ts`                              | Reconciliation: テスト結果 → requirements.yaml 自動更新                |
| `scripts/req-validate.ts`                           | CI 検証: 整合性チェック                                                |
| `scripts/docs-gen.ts`                               | Publishing: OpenAPI + TypeDoc 一括生成                                 |
| `packages/cli/src/server/openapi.ts`                | Zod → OpenAPI レジストリ定義                                           |
| `typedoc.json`                                      | TypeDoc 設定                                                           |

### 変更

| File                                      | Change                                             |
| ----------------------------------------- | -------------------------------------------------- |
| `packages/shared/src/schema.ts`           | OpenAPI メタデータ追加 (extendApi)                 |
| `packages/cli/src/__tests__/*.test.ts`    | テスト名に `[ID]` プレフィックス追加               |
| `packages/shared/src/__tests__/*.test.ts` | 同上                                               |
| `packages/ui/src/__tests__/*.test.ts`     | 同上                                               |
| `package.json` (root)                     | `req:trace`, `req:validate`, `docs` スクリプト追加 |
| `.gitignore`                              | `docs/generated/` 追加                             |
| `.github/workflows/ci.yml`                | req:validate, docs ステップ追加                    |

### 削除

| File                                                                   | Reason                                      |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| `docs/PURPOSE.md`                                                      | `requirements.yaml` の `vision` に統合      |
| `docs/plans/` (3 files)                                                | 実装済みの計画。ADR 抽出済み                |
| `docs/superpowers/specs/2026-03-20-sync-engine-redesign.md`            | ADR-001 に抽出                              |
| `docs/superpowers/specs/2026-03-22-gh-gantt-skills-redesign.md`        | ADR 対象外 (skills は Evergreen として維持) |
| `docs/superpowers/specs/2026-03-23-toolbar-ux-design.md`               | UI 実装詳細。コードが正典                   |
| `docs/superpowers/specs/2026-03-23-cicd-pipeline-design.md`            | ADR-006 に抽出                              |
| `docs/superpowers/specs/2026-03-28-task-detail-panel-layout-design.md` | UI 実装詳細。コードが正典                   |
| `docs/superpowers/specs/2026-03-29-task-body-templates-design.md`      | 実装詳細。コードが正典                      |
| `docs/superpowers/specs/2026-03-29-task-list-density-design.md`        | UI 実装詳細。コードが正典                   |
| `docs/superpowers/specs/2026-03-29-workflow-template-redesign.md`      | skills 設計。Evergreen (skills/) が正典     |
| `docs/superpowers/specs/2026-03-30-timeline-header-redesign.md`        | UI 実装詳細。コードが正典                   |
| `docs/superpowers/plans/` (9 files)                                    | 実装済みの作業計画                          |

---

### Task 1: Layer 1 — 構造化要件ドキュメント作成

**Files:**

- Create: `docs/requirements.yaml`
- Delete: `docs/PURPOSE.md`

- [ ] **Step 1: requirements.yaml を作成**

既存のコードベース・テスト・PURPOSE.md から要件を抽出し、構造化する。

```yaml
# docs/requirements.yaml
version: "1.0"
vision: |
  GitHub Projects (V2) と双方向同期し、タスクの時間軸・依存関係・
  階層的進捗をガントチャートで可視化する CLI ツール。
  AI エージェントと人間が同じワークフローでプロジェクトを管理できる。

areas:
  - id: SYNC
    name: Sync Engine
    description: GitHub Projects (V2) との双方向同期
    requirements:
      - id: FR-SYNC-001
        summary: 3-way merge によるコンフリクト検出・解決
        acceptance_criteria:
          - id: FR-SYNC-001-AC1
            description: ローカル・リモート両方が変更した場合にコンフリクトを検出する
            status: uncovered
            tests: []
          - id: FR-SYNC-001-AC2
            description: コンフリクトマーカーを生成しユーザーに解決を促す
            status: uncovered
            tests: []
          - id: FR-SYNC-001-AC3
            description: コンフリクトの検出と解決操作を CLI で実行できる
            status: uncovered
            tests: []
      - id: FR-SYNC-002
        summary: pull による GitHub → ローカル同期
        acceptance_criteria:
          - id: FR-SYNC-002-AC1
            description: リモートの変更をローカルにマージできる
            status: uncovered
            tests: []
          - id: FR-SYNC-002-AC2
            description: 未解決コンフリクトがある場合は pull を拒否する
            status: uncovered
            tests: []
      - id: FR-SYNC-003
        summary: push によるローカル → GitHub 同期
        acceptance_criteria:
          - id: FR-SYNC-003-AC1
            description: ローカルの変更を GitHub に反映できる
            status: uncovered
            tests: []
          - id: FR-SYNC-003-AC2
            description: dry run で変更内容をプレビューできる
            status: uncovered
            tests: []
          - id: FR-SYNC-003-AC3
            description: 未解決コンフリクトがある場合は push を拒否する
            status: uncovered
            tests: []
      - id: FR-SYNC-004
        summary: リモートデータからローカルタスクへのマッピング
        acceptance_criteria:
          - id: FR-SYNC-004-AC1
            description: GitHub Project Item をローカル Task 形式に変換できる
            status: uncovered
            tests: []
      - id: FR-SYNC-005
        summary: タスクのハッシュによる変更検出
        acceptance_criteria:
          - id: FR-SYNC-005-AC1
            description: タスクの内容からハッシュを算出し変更を検出できる
            status: uncovered
            tests: []
      - id: FR-SYNC-006
        summary: syncFields のリベース
        acceptance_criteria:
          - id: FR-SYNC-006-AC1
            description: pull 時に syncFields を最新のスナップショットにリベースできる
            status: uncovered
            tests: []
      - id: NFR-SYNC-001
        summary: push 中の障害耐性
        acceptance_criteria:
          - id: NFR-SYNC-001-AC1
            description: push 中に API エラーが発生しても snapshot が不整合にならない
            status: uncovered
            tests: []
          - id: NFR-SYNC-001-AC2
            description: push 途中の進捗を保存し中断からの再開を可能にする
            status: uncovered
            tests: []
      - id: NFR-SYNC-002
        summary: 同期エンジンの API アクセス効率
        acceptance_criteria:
          - id: NFR-SYNC-002-AC1
            description: 変更のないタスクに対して不要な API コールを行わない
            status: uncovered
            tests: []

  - id: HIER
    name: Task Hierarchy
    description: タスクの親子関係と依存関係の管理
    requirements:
      - id: FR-HIER-001
        summary: タスクの親子関係管理
        acceptance_criteria:
          - id: FR-HIER-001-AC1
            description: タスクの親子関係を設定・変更・削除できる
            status: uncovered
            tests: []
          - id: FR-HIER-001-AC2
            description: 循環参照を検出し拒否する
            status: uncovered
            tests: []
          - id: FR-HIER-001-AC3
            description: type_hierarchy に基づき許可されない親子関係を拒否する
            status: uncovered
            tests: []
      - id: FR-HIER-002
        summary: 階層的な進捗集約
        acceptance_criteria:
          - id: FR-HIER-002-AC1
            description: 親タスクの進捗が子タスクの状態から自動算出される
            status: uncovered
            tests: []
      - id: FR-HIER-003
        summary: 依存関係管理
        acceptance_criteria:
          - id: FR-HIER-003-AC1
            description: タスク間の依存関係を追加・削除できる
            status: uncovered
            tests: []
          - id: FR-HIER-003-AC2
            description: 依存関係の循環を検出する
            status: uncovered
            tests: []
      - id: FR-HIER-004
        summary: タスクタイプの解決
        acceptance_criteria:
          - id: FR-HIER-004-AC1
            description: ラベルや Issue Type からタスクタイプを正しく解決できる
            status: uncovered
            tests: []

  - id: CLI
    name: CLI Interface
    description: AI エージェントと人間が同じワークフローで操作できる CLI
    requirements:
      - id: FR-CLI-001
        summary: タスク一覧表示とフィルタリング
        acceptance_criteria:
          - id: FR-CLI-001-AC1
            description: タスクを一覧表示しステータス・タイプ・アサインでフィルタできる
            status: uncovered
            tests: []
          - id: FR-CLI-001-AC2
            description: --type オプションで不正なタイプが指定された場合エラーを返す
            status: uncovered
            tests: []
      - id: FR-CLI-002
        summary: タスク詳細表示
        acceptance_criteria:
          - id: FR-CLI-002-AC1
            description: タスク ID を指定して詳細情報を表示できる
            status: uncovered
            tests: []
          - id: FR-CLI-002-AC2
            description: 存在しないタスク ID でエラーを返す
            status: uncovered
            tests: []
      - id: FR-CLI-003
        summary: タスク更新
        acceptance_criteria:
          - id: FR-CLI-003-AC1
            description: タスクのフィールドを更新できる
            status: uncovered
            tests: []
      - id: FR-CLI-004
        summary: ドラフトタスク作成
        acceptance_criteria:
          - id: FR-CLI-004-AC1
            description: GitHub Issue を作成せずローカルにドラフトタスクを作成できる
            status: uncovered
            tests: []
          - id: FR-CLI-004-AC2
            description: ドラフトタスク ID は一意に生成される
            status: uncovered
            tests: []
      - id: FR-CLI-005
        summary: マイルストーン管理
        acceptance_criteria:
          - id: FR-CLI-005-AC1
            description: マイルストーンをタスクとして同期・表示できる
            status: uncovered
            tests: []
      - id: FR-CLI-006
        summary: コマンド体系
        acceptance_criteria:
          - id: FR-CLI-006-AC1
            description: init/pull/push/status/create/list/show/update/link/serve/conflicts/resolve コマンドが定義されている
            status: uncovered
            tests: []
      - id: FR-CLI-007
        summary: タスク ID の柔軟な解決
        acceptance_criteria:
          - id: FR-CLI-007-AC1
            description: Issue 番号または内部 ID でタスクを一意に特定できる
            status: uncovered
            tests: []

  - id: API
    name: REST API
    description: UI と CLI の間のデータアクセス層
    requirements:
      - id: FR-API-001
        summary: タスク CRUD
        acceptance_criteria:
          - id: FR-API-001-AC1
            description: GET/POST/PATCH/DELETE でタスクを操作できる
            status: uncovered
            tests: []
      - id: FR-API-002
        summary: 同期操作 API
        acceptance_criteria:
          - id: FR-API-002-AC1
            description: pull/push/status の操作を API 経由で実行できる
            status: uncovered
            tests: []
      - id: FR-API-003
        summary: タスクの reparent
        acceptance_criteria:
          - id: FR-API-003-AC1
            description: API 経由でタスクの親子関係を変更できる
            status: uncovered
            tests: []
          - id: FR-API-003-AC2
            description: 自己参照・循環・階層違反を API レベルで拒否する
            status: uncovered
            tests: []

  - id: VIS
    name: Visualization
    description: ガントチャートによるプロジェクト可視化
    requirements:
      - id: FR-VIS-001
        summary: ガントチャート表示
        acceptance_criteria:
          - id: FR-VIS-001-AC1
            description: タスクをガントバーとして時間軸上に表示する
            status: uncovered
            tests: []
      - id: FR-VIS-002
        summary: タスクツリー表示
        acceptance_criteria:
          - id: FR-VIS-002-AC1
            description: タスクの階層構造をツリーとして表示できる
            status: uncovered
            tests: []
      - id: FR-VIS-003
        summary: フィルタリングとスケール切替
        acceptance_criteria:
          - id: FR-VIS-003-AC1
            description: ビュースケールを week/month/quarter/year で切替できる
            status: uncovered
            tests: []
      - id: FR-VIS-004
        summary: キーボードショートカット
        acceptance_criteria:
          - id: FR-VIS-004-AC1
            description: キーボードでタスク選択・展開・操作ができる
            status: uncovered
            tests: []
      - id: FR-VIS-005
        summary: ドラッグ&ドロップによるタスク移動
        acceptance_criteria:
          - id: FR-VIS-005-AC1
            description: ツリー上でタスクをドラッグして親子関係を変更できる
            status: uncovered
            tests: []
      - id: FR-VIS-006
        summary: タスク詳細パネル
        acceptance_criteria:
          - id: FR-VIS-006-AC1
            description: タスクの詳細情報をパネルに表示する
            status: uncovered
            tests: []
      - id: FR-VIS-007
        summary: 日付計算ユーティリティ
        acceptance_criteria:
          - id: FR-VIS-007-AC1
            description: 営業日計算・日付レンジ・スケジュールステータスを正しく算出する
            status: uncovered
            tests: []
      - id: FR-VIS-008
        summary: サマリーバーの日付算出
        acceptance_criteria:
          - id: FR-VIS-008-AC1
            description: 子タスクの日付範囲からサマリーバーの開始・終了を算出する
            status: uncovered
            tests: []
      - id: FR-VIS-009
        summary: Undo/Redo
        acceptance_criteria:
          - id: FR-VIS-009-AC1
            description: 操作の取り消しとやり直しができる
            status: uncovered
            tests: []

  - id: STORE
    name: Data Store
    description: ローカルデータの永続化とバリデーション
    requirements:
      - id: FR-STORE-001
        summary: 設定ファイルの読み書き
        acceptance_criteria:
          - id: FR-STORE-001-AC1
            description: gantt.config.json を Zod バリデーション付きで読み書きできる
            status: uncovered
            tests: []
      - id: FR-STORE-002
        summary: タスクファイルの読み書き
        acceptance_criteria:
          - id: FR-STORE-002-AC1
            description: tasks.json を Zod バリデーション付きで読み書きできる
            status: uncovered
            tests: []
      - id: NFR-STORE-001
        summary: スキーマバリデーション
        acceptance_criteria:
          - id: NFR-STORE-001-AC1
            description: 不正な形式のファイルを読み込んだ場合にバリデーションエラーを返す
            status: uncovered
            tests: []
```

- [ ] **Step 2: PURPOSE.md を削除**

```bash
git rm docs/PURPOSE.md
```

- [ ] **Step 3: コミット**

```bash
git add docs/requirements.yaml
git commit -m "docs: add structured requirements.yaml (Layer 1: Evergreen)

Living Documentation 体系の Layer 1 として構造化要件ドキュメントを追加。
PURPOSE.md の vision を統合し、全機能領域の要件と受入基準を ID 体系で定義。"
```

---

### Task 2: Layer 2 — ADR 作成と既存スペック整理

**Files:**

- Create: `docs/adr/ADR-001-sync-engine-three-way-merge.yaml`
- Create: `docs/adr/ADR-002-zod-schema-validation.yaml`
- Create: `docs/adr/ADR-003-git-like-sync-model.yaml`
- Create: `docs/adr/ADR-004-cli-first-design.yaml`
- Create: `docs/adr/ADR-005-local-first-data.yaml`
- Create: `docs/adr/ADR-006-cicd-pipeline.yaml`
- Read: `docs/superpowers/specs/2026-03-20-sync-engine-redesign.md`
- Read: `docs/superpowers/specs/2026-03-23-cicd-pipeline-design.md`
- Delete: `docs/superpowers/specs/` (7 design specs, excluding living-documentation-design.md)
- Delete: `docs/superpowers/plans/` (9 plan files)
- Delete: `docs/plans/` (3 files)

- [ ] **Step 1: ADR-001 を作成**

`docs/superpowers/specs/2026-03-20-sync-engine-redesign.md` を読み、Why と alternatives を抽出する。

```yaml
# docs/adr/ADR-001-sync-engine-three-way-merge.yaml
id: ADR-001
title: 同期エンジンに 3-way merge を採用
date: "2026-03-20"
status: accepted
context: |
  GitHub Projects (V2) との双方向同期において、ローカルとリモートの
  変更が衝突する場合の解決戦略が必要。オフライン作業を重視するため、
  ローカル変更を安全に保護しつつ衝突を検出する仕組みが求められた。
decision: |
  Git の 3-way merge モデルを採用。per-task の base snapshot を保持し、
  local diff と remote diff をフィールド単位で比較してコンフリクトを検出する。
  コンフリクトはマーカーとしてタスクデータに埋め込み、ユーザーに解決を委ねる。
alternatives:
  - name: Last Write Wins
    reason_rejected: データ消失のリスクが高く、オフライン作業の価値が失われる
  - name: Remote Always Wins
    reason_rejected: ローカルでの編集が上書きされ、CLI ファーストの原則に反する
  - name: 2-way diff (base なし)
    reason_rejected: base がないため変更意図の判別が不可能。全差分がコンフリクト候補になる
consequences:
  - sync-state.json に per-task snapshot (syncFields + hash) の保持が必要
  - push/pull 両方で diff 計算のコストが発生するが、フィールド単位のため軽量
  - コンフリクトマーカーの形式を定義し、検出・解決の CLI コマンドが必要
related_requirements:
  - FR-SYNC-001
  - NFR-SYNC-001
```

- [ ] **Step 2: ADR-002 を作成**

```yaml
# docs/adr/ADR-002-zod-schema-validation.yaml
id: ADR-002
title: ファイル読み込み時に Zod バリデーションを必須化
date: "2026-02-09"
status: accepted
context: |
  .gantt-sync/ 配下の JSON ファイル (tasks.json, sync-state.json, gantt.config.json) は
  ユーザーが手動編集する可能性があり、外部からの push でも変更される。
  不正なデータがランタイムに混入するとサイレントな不整合を引き起こす。
decision: |
  すべてのファイル読み込みに Zod スキーマによるバリデーションを適用する。
  @gh-gantt/shared にスキーマを集約し、CLI と UI の両方で共有する。
alternatives:
  - name: TypeScript の型アサーションのみ
    reason_rejected: ランタイムでの検証がなく、不正データを検出できない
  - name: JSON Schema
    reason_rejected: TypeScript の型定義との二重管理になる。Zod は型推論と一体
  - name: io-ts
    reason_rejected: Zod の方が API がシンプルでエコシステムが充実している
consequences:
  - @gh-gantt/shared に zod 依存が追加
  - ファイル読み込み時のエラーメッセージが構造化される
  - スキーマ変更が型変更と同時に行われることが保証される
related_requirements:
  - NFR-STORE-001
```

- [ ] **Step 3: ADR-003 を作成**

```yaml
# docs/adr/ADR-003-git-like-sync-model.yaml
id: ADR-003
title: git ライクな pull/push/conflict モデルの採用
date: "2026-02-09"
status: accepted
context: |
  GitHub Projects との同期方式を決定する必要がある。ユーザーは開発者であり、
  AI エージェントも CLI で操作する。馴染みのあるメンタルモデルが望ましい。
decision: |
  git のワークフローを模倣した pull/push/conflict resolve モデルを採用。
  ローカルデータを .gantt-sync/ に保持し、明示的な pull/push で同期する。
alternatives:
  - name: リアルタイム自動同期
    reason_rejected: オフライン作業ができない。衝突の自動解決が困難
  - name: Web UI 経由の直接操作
    reason_rejected: CLI ファーストの原則に反する。AI エージェントが操作できない
  - name: GitHub API 直接呼び出し
    reason_rejected: レートリミット・認証の複雑さ。ローカルにデータがないためコンテキスト回復ができない
consequences:
  - .gantt-sync/ ディレクトリにローカルデータを永続化
  - pull → 作業 → push の明示的なサイクルをユーザーに要求
  - コンフリクト解決のための CLI コマンドが必要
related_requirements:
  - FR-SYNC-002
  - FR-SYNC-003
```

- [ ] **Step 4: ADR-004 を作成**

```yaml
# docs/adr/ADR-004-cli-first-design.yaml
id: ADR-004
title: CLI ファースト設計
date: "2026-02-09"
status: accepted
context: |
  gh-gantt は AI エージェント (Claude Code 等) と人間の両方が使うツール。
  Web UI だけでは AI エージェントが操作できない。
decision: |
  すべての操作を CLI で完結させる。Web UI は可視化専用とし、
  操作は API 経由で CLI と同じバックエンドを共有する。
alternatives:
  - name: Web UI ファースト
    reason_rejected: AI エージェントが操作できない。自動化も困難
  - name: API ファースト (CLI なし)
    reason_rejected: ターミナルでの操作性が悪い。セッション間のコンテキスト回復に不便
consequences:
  - Commander.js による CLI コマンド体系の構築が必要
  - Web UI は読み取り専用 + API 経由の操作に限定
  - AI エージェントと人間が同じコマンドを共有
related_requirements:
  - FR-CLI-006
```

- [ ] **Step 5: ADR-005 を作成**

```yaml
# docs/adr/ADR-005-local-first-data.yaml
id: ADR-005
title: ローカルファーストのデータ管理
date: "2026-02-09"
status: accepted
context: |
  AI エージェントはセッション間でコンテキストを失う。
  プロジェクトの現在地を素早く把握する手段が必要。
decision: |
  プロジェクトデータを .gantt-sync/ にローカル保持する。
  gh-gantt status や gh-gantt list で API コールなしにプロジェクト状態を参照できる。
alternatives:
  - name: 毎回 API から取得
    reason_rejected: ネットワーク接続が必須。レートリミット。コンテキスト回復が遅い
  - name: データベース (SQLite 等)
    reason_rejected: JSON ファイルの方がデバッグしやすく、git で差分が見える
consequences:
  - .gantt-sync/ ディレクトリの管理 (.gitignore に追加)
  - tasks.json, sync-state.json, gantt.config.json のファイル形式を定義
  - オフライン状態でもリード操作が可能
related_requirements:
  - FR-STORE-001
  - FR-STORE-002
```

- [ ] **Step 6: ADR-006 を作成**

`docs/superpowers/specs/2026-03-23-cicd-pipeline-design.md` を読み、抽出する。

```yaml
# docs/adr/ADR-006-cicd-pipeline.yaml
id: ADR-006
title: vite-plus ベースの CI/CD パイプライン
date: "2026-03-23"
status: accepted
context: |
  モノレポのビルド・テスト・リントを統合的に管理する CI パイプラインが必要。
  vite-plus (vp) がビルドツールとして採用されている前提。
decision: |
  GitHub Actions で vp CLI を直接使用する。
  ci ジョブ (lint + type + build + test) と e2e ジョブ (Playwright) を分離。
  e2e は main ブランチのみで実行し、ci の成功を前提とする。
alternatives:
  - name: 各ツール個別実行
    reason_rejected: vp check が lint + format + type を統合しており、個別実行は冗長
  - name: E2E を全ブランチで実行
    reason_rejected: 実行時間が長い (15 分)。PR では unit test で十分
consequences:
  - vp のバージョンアップが CI に直接影響する
  - E2E テストの失敗は main ブランチでのみ検出される
related_requirements: []
```

- [ ] **Step 7: 既存スペックとプランを削除**

```bash
# Design specs (living-documentation-design.md は保持)
git rm docs/superpowers/specs/2026-03-20-sync-engine-redesign.md
git rm docs/superpowers/specs/2026-03-22-gh-gantt-skills-redesign.md
git rm docs/superpowers/specs/2026-03-23-toolbar-ux-design.md
git rm docs/superpowers/specs/2026-03-23-cicd-pipeline-design.md
git rm docs/superpowers/specs/2026-03-28-task-detail-panel-layout-design.md
git rm docs/superpowers/specs/2026-03-29-task-body-templates-design.md
git rm docs/superpowers/specs/2026-03-29-task-list-density-design.md
git rm docs/superpowers/specs/2026-03-29-workflow-template-redesign.md
git rm docs/superpowers/specs/2026-03-30-timeline-header-redesign.md

# Plans
git rm -r docs/superpowers/plans/
git rm -r docs/plans/
```

**注意**: `docs/superpowers/specs/2026-04-04-living-documentation-design.md` は本タスクの設計仕様として保持する。

- [ ] **Step 8: コミット**

```bash
git add docs/adr/
git commit -m "docs: add ADRs and clean up obsolete specs/plans (Layer 2)

6 件の ADR を既存スペックから抽出して作成。
実装済みの design specs (9 件) と plans (12 件) を削除。
意思決定の Why と却下された選択肢を構造化 YAML で保存。"
```

---

### Task 3: Layer 3a — Zod → OpenAPI 自動生成

**Files:**

- Create: `packages/cli/src/server/openapi.ts`
- Modify: `packages/cli/package.json` (dependency 追加)
- Create: `scripts/docs-gen.ts`
- Modify: `package.json` (root, scripts 追加)
- Modify: `.gitignore`

- [ ] **Step 1: 依存パッケージをインストール**

```bash
pnpm --filter @gh-gantt/cli add @asteasolutions/zod-to-openapi
pnpm --filter @gh-gantt/cli add -D yaml
pnpm add -D typedoc typescript -w
```

- [ ] **Step 2: OpenAPI レジストリ定義を作成**

```typescript
// packages/cli/src/server/openapi.ts
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  ConfigSchema,
  TaskSchema,
  TasksFileSchema,
  DependencySchema,
  StatusesSchema,
} from "@gh-gantt/shared";

export const registry = new OpenAPIRegistry();

// --- Schema Registration ---

registry.register("Task", TaskSchema);
registry.register("Config", ConfigSchema);
registry.register("Dependency", DependencySchema);
registry.register("Statuses", StatusesSchema);

const TaskCreateRequestSchema = z.object({
  title: z.string(),
  type: z.string(),
  body: z.string().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
});
registry.register("TaskCreateRequest", TaskCreateRequestSchema);

const TaskUpdateRequestSchema = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]).optional(),
  state_reason: z.string().nullable().optional(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  milestone: z.string().nullable().optional(),
  custom_fields: z.record(z.unknown()).optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  sub_tasks: z.array(z.string()).optional(),
  blocked_by: z.array(DependencySchema).optional(),
});
registry.register("TaskUpdateRequest", TaskUpdateRequestSchema);

const ReparentRequestSchema = z.object({
  newParentId: z.string().nullable(),
});
registry.register("ReparentRequest", ReparentRequestSchema);

const SyncStatusResponseSchema = z.object({
  last_synced_at: z.string(),
  local_changes: z.number(),
  total_tasks: z.number(),
});
registry.register("SyncStatusResponse", SyncStatusResponseSchema);

const PushRequestSchema = z.object({
  dry_run: z.boolean().optional(),
  force: z.boolean().optional(),
});
registry.register("PushRequest", PushRequestSchema);

const ErrorResponseSchema = z.object({
  error: z.string(),
});
registry.register("ErrorResponse", ErrorResponseSchema);

// --- Path Registration ---

registry.registerPath({
  method: "get",
  path: "/api/config",
  summary: "設定を取得",
  responses: {
    200: {
      description: "Config オブジェクト",
      content: { "application/json": { schema: ConfigSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/tasks",
  summary: "タスク一覧を取得",
  responses: {
    200: {
      description: "タスク一覧 (進捗情報付き)",
      content: { "application/json": { schema: TasksFileSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/tasks",
  summary: "ドラフトタスクを作成",
  request: {
    body: {
      content: { "application/json": { schema: TaskCreateRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "作成されたタスク",
      content: { "application/json": { schema: TaskSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/tasks/{id}",
  summary: "タスクを更新",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: TaskUpdateRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "更新されたタスク",
      content: { "application/json": { schema: TaskSchema } },
    },
    404: {
      description: "タスクが見つからない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/tasks/{id}/reparent",
  summary: "タスクの親を変更",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: ReparentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "更新後のタスク一覧",
      content: { "application/json": { schema: TasksFileSchema } },
    },
    400: {
      description: "循環参照・階層違反",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/sync/pull",
  summary: "GitHub からローカルに同期",
  responses: {
    200: {
      description: "同期結果",
      content: {
        "application/json": {
          schema: z.object({
            added: z.number(),
            updated: z.number(),
            removed: z.number(),
            conflicts: z.number(),
          }),
        },
      },
    },
    409: {
      description: "未解決コンフリクトあり",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/sync/push",
  summary: "ローカルから GitHub に同期",
  request: {
    body: {
      content: { "application/json": { schema: PushRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "push 結果",
      content: { "application/json": { schema: z.object({}) } },
    },
    409: {
      description: "未解決コンフリクトあり",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/sync/status",
  summary: "同期ステータスを取得",
  responses: {
    200: {
      description: "同期ステータス",
      content: {
        "application/json": { schema: SyncStatusResponseSchema },
      },
    },
  },
});

// --- Generator ---

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "gh-gantt REST API",
      version: "0.1.0",
      description: "GitHub Projects (V2) と双方向同期するガントチャート CLI の REST API",
    },
  });
}
```

- [ ] **Step 3: .gitignore に docs/generated/ を追加**

`.gitignore` の末尾に追加:

```
docs/generated/
```

- [ ] **Step 4: docs-gen.ts スクリプトを作成**

```typescript
// scripts/docs-gen.ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const GENERATED_DIR = resolve(ROOT, "docs/generated");

async function generateOpenApi() {
  const { generateOpenApiDocument } = await import("../packages/cli/src/server/openapi.js");
  const doc = generateOpenApiDocument();
  const outPath = resolve(GENERATED_DIR, "openapi.yaml");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, stringify(doc), "utf-8");
  console.log(`OpenAPI spec written to ${outPath}`);
}

async function generateTypedoc() {
  const { Application } = await import("typedoc");
  const app = await Application.bootstrapWithPlugins({
    entryPoints: [
      resolve(ROOT, "packages/shared/src/index.ts"),
      resolve(ROOT, "packages/cli/src/index.ts"),
    ],
    tsconfig: resolve(ROOT, "tsconfig.base.json"),
    out: resolve(GENERATED_DIR, "api"),
    readme: "none",
    excludePrivate: true,
    excludeInternal: true,
  });

  const project = await app.convert();
  if (!project) {
    throw new Error("TypeDoc conversion failed");
  }
  await app.generateDocs(project, resolve(GENERATED_DIR, "api"));
  console.log(`TypeDoc output written to ${resolve(GENERATED_DIR, "api")}`);
}

async function main() {
  await mkdir(GENERATED_DIR, { recursive: true });

  console.log("Generating OpenAPI spec...");
  await generateOpenApi();

  console.log("Generating TypeDoc...");
  await generateTypedoc();

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: root package.json にスクリプトを追加**

`package.json` の `scripts` に追加:

```json
"docs": "node --import tsx scripts/docs-gen.ts"
```

- [ ] **Step 6: ビルドして動作確認**

```bash
pnpm build
pnpm docs
```

Expected: `docs/generated/openapi.yaml` と `docs/generated/api/` が生成される。

- [ ] **Step 7: コミット**

```bash
git add packages/cli/src/server/openapi.ts scripts/docs-gen.ts .gitignore package.json packages/cli/package.json pnpm-lock.yaml
git commit -m "feat: add OpenAPI + TypeDoc auto-generation (Layer 3)

Zod スキーマから OpenAPI 3.1 スペックを自動生成。
TypeDoc で shared/cli パッケージの API リファレンスを生成。
pnpm docs で一括生成。生成物は docs/generated/ (gitignore)。"
```

---

### Task 4: Layer 4 — Reconciliation スクリプト

**Files:**

- Create: `scripts/req-trace.ts`
- Create: `scripts/req-validate.ts`
- Modify: `package.json` (root, scripts 追加)

- [ ] **Step 1: req-trace.ts を作成**

```typescript
// scripts/req-trace.ts
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const REQ_PATH = resolve(ROOT, "docs/requirements.yaml");
const TEST_RESULTS_PATH = resolve(ROOT, "test-results.json");

interface VitestResult {
  testResults: Array<{
    name: string;
    assertionResults: Array<{
      ancestorTitles: string[];
      title: string;
      status: "passed" | "failed" | "pending";
      fullName: string;
    }>;
  }>;
}

interface AcceptanceCriteria {
  id: string;
  description: string;
  status: string;
  tests: string[];
}

interface Requirement {
  id: string;
  summary: string;
  acceptance_criteria: AcceptanceCriteria[];
}

interface Area {
  id: string;
  name: string;
  description: string;
  requirements: Requirement[];
}

interface Requirements {
  version: string;
  vision: string;
  areas: Area[];
}

const REQ_ID_PATTERN = /\[([A-Z]+-[A-Z]+-\d+-AC\d+)\]/;

function extractReqIds(text: string): string[] {
  const ids: string[] = [];
  const matches = text.matchAll(/\[([A-Z]+-[A-Z]+-\d+-AC\d+)\]/g);
  for (const match of matches) {
    ids.push(match[1]);
  }
  return ids;
}

async function main() {
  const reqYaml = await readFile(REQ_PATH, "utf-8");
  const req: Requirements = parse(reqYaml);

  let testResults: VitestResult;
  try {
    const json = await readFile(TEST_RESULTS_PATH, "utf-8");
    testResults = JSON.parse(json);
  } catch {
    console.error(`テスト結果ファイルが見つかりません: ${TEST_RESULTS_PATH}`);
    console.error(
      "先に pnpm test -- --reporter=json --outputFile=test-results.json を実行してください",
    );
    process.exit(1);
  }

  // テスト結果から ID → { status, testFile } のマップを構築
  const idMap = new Map<string, { status: "passed" | "failed"; testFile: string }>();

  for (const suite of testResults.testResults) {
    // テストファイルのパスをプロジェクトルート相対に変換
    const relPath = suite.name.replace(ROOT + "/", "");

    for (const test of suite.assertionResults) {
      const fullTitle = [...test.ancestorTitles, test.title].join(" ");
      const ids = extractReqIds(fullTitle);
      for (const id of ids) {
        const existing = idMap.get(id);
        // 一つでも failed があれば failed
        if (!existing || test.status === "failed") {
          idMap.set(id, {
            status: test.status === "passed" ? "passed" : "failed",
            testFile: relPath,
          });
        }
      }
    }
  }

  // requirements.yaml を更新
  let updated = 0;
  for (const area of req.areas) {
    for (const requirement of area.requirements) {
      for (const ac of requirement.acceptance_criteria) {
        const result = idMap.get(ac.id);
        if (result) {
          const newStatus = result.status === "passed" ? "covered" : "failing";
          const testFiles = [
            ...new Set([
              ...testResults.testResults
                .filter((suite) => {
                  return suite.assertionResults.some((test) => {
                    const fullTitle = [...test.ancestorTitles, test.title].join(" ");
                    return extractReqIds(fullTitle).includes(ac.id);
                  });
                })
                .map((suite) => suite.name.replace(ROOT + "/", "")),
            ]),
          ];

          if (ac.status !== newStatus || JSON.stringify(ac.tests) !== JSON.stringify(testFiles)) {
            ac.status = newStatus;
            ac.tests = testFiles;
            updated++;
          }
        } else {
          if (ac.status !== "uncovered") {
            ac.status = "uncovered";
            ac.tests = [];
            updated++;
          }
        }
      }
    }
  }

  await writeFile(REQ_PATH, stringify(req, { lineWidth: 0 }), "utf-8");
  console.log(`requirements.yaml を更新しました (${updated} 件の AC を変更)`);

  // サマリー出力
  let covered = 0;
  let uncovered = 0;
  let failing = 0;
  for (const area of req.areas) {
    for (const requirement of area.requirements) {
      for (const ac of requirement.acceptance_criteria) {
        if (ac.status === "covered") covered++;
        else if (ac.status === "uncovered") uncovered++;
        else if (ac.status === "failing") failing++;
      }
    }
  }
  console.log(`\nサマリー: covered=${covered}, uncovered=${uncovered}, failing=${failing}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: req-validate.ts を作成**

```typescript
// scripts/req-validate.ts
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { glob } from "node:fs/promises";

const ROOT = resolve(import.meta.dirname, "..");
const REQ_PATH = resolve(ROOT, "docs/requirements.yaml");
const ADR_DIR = resolve(ROOT, "docs/adr");

interface AcceptanceCriteria {
  id: string;
  description: string;
  status: string;
  tests: string[];
}

interface Requirement {
  id: string;
  summary: string;
  acceptance_criteria: AcceptanceCriteria[];
}

interface Area {
  id: string;
  name: string;
  description: string;
  requirements: Requirement[];
}

interface Requirements {
  version: string;
  vision: string;
  areas: Area[];
}

interface ADR {
  id: string;
  related_requirements: string[];
}

const REQ_ID_PATTERN = /\[([A-Z]+-[A-Z]+-\d+-AC\d+)\]/g;

const errors: string[] = [];

async function collectTestReqIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const testDirs = [
    "packages/cli/src/__tests__",
    "packages/shared/src/__tests__",
    "packages/ui/src/__tests__",
  ];

  for (const dir of testDirs) {
    const fullDir = resolve(ROOT, dir);
    let files: string[];
    try {
      files = (await readdir(fullDir)).filter(
        (f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const content = await readFile(resolve(fullDir, file), "utf-8");
      const matches = content.matchAll(REQ_ID_PATTERN);
      for (const match of matches) {
        ids.add(match[1]);
      }
    }
  }
  return ids;
}

async function main() {
  const reqYaml = await readFile(REQ_PATH, "utf-8");
  const req: Requirements = parse(reqYaml);

  // 全 AC ID を収集
  const allAcIds = new Set<string>();
  const allReqIds = new Set<string>();
  for (const area of req.areas) {
    for (const requirement of area.requirements) {
      allReqIds.add(requirement.id);
      for (const ac of requirement.acceptance_criteria) {
        allAcIds.add(ac.id);
      }
    }
  }

  // テストコードから要件 ID を収集
  const testReqIds = await collectTestReqIds();

  // 1. Orphaned AC: requirements.yaml にあるがテストから参照されない
  for (const acId of allAcIds) {
    if (!testReqIds.has(acId)) {
      errors.push(`Orphaned AC: ${acId} はテストから参照されていません`);
    }
  }

  // 2. Orphaned Tag: テストに ID があるが requirements.yaml に存在しない
  for (const testId of testReqIds) {
    if (!allAcIds.has(testId)) {
      errors.push(`Orphaned Tag: テストの [${testId}] は requirements.yaml に存在しません`);
    }
  }

  // 3. Stale ADR Ref: ADR の related_requirements が存在しない
  try {
    const adrFiles = (await readdir(ADR_DIR)).filter((f) => f.endsWith(".yaml"));
    for (const file of adrFiles) {
      const content = await readFile(resolve(ADR_DIR, file), "utf-8");
      const adr: ADR = parse(content);
      if (adr.related_requirements) {
        for (const reqId of adr.related_requirements) {
          if (!allReqIds.has(reqId)) {
            errors.push(
              `Stale ADR Ref: ${adr.id} の related_requirements "${reqId}" は requirements.yaml に存在しません`,
            );
          }
        }
      }
    }
  } catch {
    // ADR ディレクトリが存在しない場合はスキップ
  }

  // 結果出力
  if (errors.length > 0) {
    console.error("Validation errors found:\n");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    console.error(`\n${errors.length} 件のエラーが見つかりました`);
    process.exit(1);
  }

  console.log("✓ すべての検証に合格しました");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: root package.json にスクリプトを追加**

`package.json` の `scripts` に追加:

```json
"req:trace": "node --import tsx scripts/req-trace.ts",
"req:validate": "node --import tsx scripts/req-validate.ts"
```

- [ ] **Step 4: tsx を devDependency に追加**

```bash
pnpm add -D tsx yaml -w
```

- [ ] **Step 5: コミット**

```bash
git add scripts/req-trace.ts scripts/req-validate.ts package.json pnpm-lock.yaml
git commit -m "feat: add req-trace and req-validate scripts (Layer 4)

req-trace: Vitest JSON 出力からテスト名の [ID] を抽出し
requirements.yaml の status/tests を自動更新。
req-validate: orphaned AC/tag, stale ADR ref を検出して CI で検証。"
```

---

### Task 5: テスト名に要件 ID プレフィックスを追加

**Files:**

- Modify: `packages/cli/src/__tests__/*.test.ts` (主要テストファイル)
- Modify: `packages/shared/src/__tests__/*.test.ts`
- Modify: `packages/ui/src/__tests__/*.test.ts`

全テストを一度に書き換えるのではなく、各機能領域の主要テストに段階的にタグ付けする。テスト名は日本語で、AC の `description` をそのまま使う。

- [ ] **Step 1: SYNC 領域のテストにタグ付け**

**`packages/cli/src/__tests__/three-way-merge.test.ts`**:
トップレベルの `describe("threeWayMerge", ...)` を以下に変更:

```typescript
describe("[FR-SYNC-001-AC1] ローカル・リモート両方が変更した場合にコンフリクトを検出する", () => {
```

**`packages/cli/src/__tests__/conflict-marker.test.ts`**:
`describe("applyConflictMarkers", ...)` を以下に変更:

```typescript
describe("[FR-SYNC-001-AC2] コンフリクトマーカーを生成しユーザーに解決を促す", () => {
```

**`packages/cli/src/__tests__/conflicts-command.test.ts`**:
`describe("formatConflictList", ...)` を以下に変更:

```typescript
describe("[FR-SYNC-001-AC3] コンフリクトの検出と解決操作を CLI で実行できる", () => {
```

**`packages/cli/src/__tests__/push-executor.test.ts`**:
`describe("executePush", ...)` 内に要件タグを追加。トップレベルは維持し、関連する子 describe にタグ付け:

```typescript
describe("executePush", () => {
  describe("[FR-SYNC-003-AC1] ローカルの変更を GitHub に反映できる", () => {
    // 既存の push 成功系テスト
  });
  describe("[NFR-SYNC-001-AC1] push 中に API エラーが発生しても snapshot が不整合にならない", () => {
    // 既存の partial failure テスト
  });
  describe("[NFR-SYNC-001-AC2] push 途中の進捗を保存し中断からの再開を可能にする", () => {
    // 既存の progress saving テスト
  });
});
```

**`packages/cli/src/__tests__/hash.test.ts`**:

```typescript
describe("[FR-SYNC-005-AC1] タスクの内容からハッシュを算出し変更を検出できる", () => {
```

**`packages/cli/src/__tests__/mapper.test.ts`**:

```typescript
describe("[FR-SYNC-004-AC1] GitHub Project Item をローカル Task 形式に変換できる", () => {
```

**`packages/cli/src/__tests__/rebase.test.ts`**:

```typescript
describe("[FR-SYNC-006-AC1] pull 時に syncFields を最新のスナップショットにリベースできる", () => {
```

**`packages/cli/src/__tests__/diff.test.ts`**:
`describe("formatDiffPreview", ...)` を以下に変更:

```typescript
describe("[FR-SYNC-003-AC2] dry run で変更内容をプレビューできる", () => {
```

`describe("estimateApiCalls", ...)` を以下に変更:

```typescript
describe("[NFR-SYNC-002-AC1] 変更のないタスクに対して不要な API コールを行わない", () => {
```

- [ ] **Step 2: HIER 領域のテストにタグ付け**

**`packages/cli/src/__tests__/task-commands.test.ts`**:

`describe("setParent", ...)` を以下に変更:

```typescript
describe("[FR-HIER-001-AC1] タスクの親子関係を設定・変更・削除できる", () => {
```

`describe("addDependency", ...)` を以下に変更:

```typescript
describe("[FR-HIER-003-AC1] タスク間の依存関係を追加・削除できる", () => {
```

**`packages/cli/src/__tests__/type-resolver.test.ts`**:

```typescript
describe("[FR-HIER-004-AC1] ラベルや Issue Type からタスクタイプを正しく解決できる", () => {
```

**`packages/ui/src/__tests__/progress.test.ts`**:

```typescript
describe("[FR-HIER-002-AC1] 親タスクの進捗が子タスクの状態から自動算出される", () => {
```

**`packages/ui/src/__tests__/dependency-graph.test.ts`**:

`describe("detectCycles", ...)` を以下に変更:

```typescript
describe("[FR-HIER-003-AC2] 依存関係の循環を検出する", () => {
```

**`packages/ui/src/__tests__/validation.test.ts`**:

`describe("wouldCreateParentCycle", ...)` を以下に変更:

```typescript
describe("[FR-HIER-001-AC2] 循環参照を検出し拒否する", () => {
```

`describe("isTypeHierarchyAllowed", ...)` を以下に変更:

```typescript
describe("[FR-HIER-001-AC3] type_hierarchy に基づき許可されない親子関係を拒否する", () => {
```

- [ ] **Step 3: CLI 領域のテストにタグ付け**

**`packages/cli/src/__tests__/command-structure.test.ts`**:

```typescript
describe("[FR-CLI-006-AC1] init/pull/push/status/create/list/show/update/link/serve/conflicts/resolve コマンドが定義されている", () => {
```

**`packages/cli/src/__tests__/command-actions.test.ts`**:

```typescript
describe("[FR-CLI-001-AC1] タスクを一覧表示しステータス・タイプ・アサインでフィルタできる", () => {
```

**`packages/cli/src/__tests__/task-list-validation.test.ts`**:

```typescript
describe("[FR-CLI-001-AC2] --type オプションで不正なタイプが指定された場合エラーを返す", () => {
```

**`packages/cli/src/__tests__/task-show.test.ts`**:

```typescript
describe("[FR-CLI-002-AC2] 存在しないタスク ID でエラーを返す", () => {
```

**`packages/cli/src/__tests__/task-id.test.ts`**:

```typescript
describe("[FR-CLI-007-AC1] Issue 番号または内部 ID でタスクを一意に特定できる", () => {
```

**`packages/cli/src/__tests__/draft-tasks.test.ts`**:

`describe("buildDraftTaskId", ...)` を以下に変更:

```typescript
describe("[FR-CLI-004-AC2] ドラフトタスク ID は一意に生成される", () => {
```

**`packages/cli/src/__tests__/milestone.test.ts`**:

```typescript
describe("[FR-CLI-005-AC1] マイルストーンをタスクとして同期・表示できる", () => {
```

- [ ] **Step 4: API 領域のテストにタグ付け**

**`packages/cli/src/__tests__/server-api.test.ts`**:

`describe("createApiRouter", ...)` 内の関連テストにタグ付け。トップレベルは維持:

```typescript
describe("createApiRouter", () => {
  describe("[FR-API-001-AC1] GET/POST/PATCH/DELETE でタスクを操作できる", () => {
    // 既存の CRUD テスト
  });
  describe("[FR-API-003-AC1] API 経由でタスクの親子関係を変更できる", () => {
    // 既存の reparent テスト
  });
  describe("[FR-API-003-AC2] 自己参照・循環・階層違反を API レベルで拒否する", () => {
    // 既存のバリデーションテスト
  });
});
```

- [ ] **Step 5: STORE 領域のテストにタグ付け**

**`packages/cli/src/__tests__/store.test.ts`**:

```typescript
describe("[FR-STORE-001-AC1] gantt.config.json を Zod バリデーション付きで読み書きできる", () => {
```

```typescript
describe("[FR-STORE-002-AC1] tasks.json を Zod バリデーション付きで読み書きできる", () => {
```

**`packages/shared/src/__tests__/schema.test.ts`**:

```typescript
describe("[NFR-STORE-001-AC1] 不正な形式のファイルを読み込んだ場合にバリデーションエラーを返す", () => {
```

- [ ] **Step 6: VIS 領域のテストにタグ付け**

**`packages/ui/src/__tests__/date-utils.test.ts`**:

トップレベルの describe 群をラップ:

```typescript
describe("[FR-VIS-007-AC1] 営業日計算・日付レンジ・スケジュールステータスを正しく算出する", () => {
  describe("parseDate", () => {
    /* 既存テスト */
  });
  describe("isWorkingDay", () => {
    /* 既存テスト */
  });
  describe("addWorkingDays", () => {
    /* 既存テスト */
  });
  describe("getDateRange", () => {
    /* 既存テスト */
  });
  describe("schedule status helpers", () => {
    /* 既存テスト */
  });
});
```

**`packages/ui/src/__tests__/summary-calc.test.ts`**:

```typescript
describe("[FR-VIS-008-AC1] 子タスクの日付範囲からサマリーバーの開始・終了を算出する", () => {
```

**`packages/ui/src/__tests__/useKeyboardShortcuts.test.ts`**:

```typescript
describe("[FR-VIS-004-AC1] キーボードでタスク選択・展開・操作ができる", () => {
```

**`packages/ui/src/__tests__/useTreeDragDrop.test.ts`**:

```typescript
describe("[FR-VIS-005-AC1] ツリー上でタスクをドラッグして親子関係を変更できる", () => {
```

**`packages/ui/src/__tests__/useUndoRedo.test.ts`**:

```typescript
describe("[FR-VIS-009-AC1] 操作の取り消しとやり直しができる", () => {
```

- [ ] **Step 7: テストが全て pass することを確認**

```bash
pnpm test
```

Expected: 全テスト pass。describe 名の変更はテストのロジックに影響しない。

- [ ] **Step 8: Reconciliation を実行して requirements.yaml を更新**

```bash
pnpm test -- --reporter=json --outputFile=test-results.json
pnpm req:trace
```

Expected: `requirements.yaml` の多くの AC が `status: covered` に更新される。

- [ ] **Step 9: コミット**

```bash
git add packages/cli/src/__tests__/ packages/shared/src/__tests__/ packages/ui/src/__tests__/ docs/requirements.yaml
git commit -m "feat: add requirement ID prefixes to tests (Layer 4 Reconciliation)

テスト名に [FR-*-AC*] / [NFR-*-AC*] プレフィックスを追加。
req-trace で requirements.yaml の status/tests を自動更新。
テスト結果がそのまま要件充足レポートとして機能する。"
```

---

### Task 6: CI 統合

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: CI ワークフローに req:validate と docs ステップを追加**

`.github/workflows/ci.yml` の `ci` ジョブの steps 末尾に追加:

```yaml
- name: Generate docs
  run: vp run docs

- name: Validate requirements traceability
  run: |
    vp run test -- --reporter=json --outputFile=test-results.json
    vp run req:trace
    vp run req:validate
```

**注意**: `vp run test` は既に前のステップで実行されているが、JSON レポーター付きで再実行が必要。テスト実行のキャッシュが効くため追加コストは小さい。

- [ ] **Step 2: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add docs generation and requirements validation

CI パイプラインに OpenAPI/TypeDoc 生成と
requirements traceability の検証ステップを追加。"
```

---

### Task 7: 最終検証

- [ ] **Step 1: フルビルド + テスト + Reconciliation**

```bash
pnpm build
pnpm test
pnpm test -- --reporter=json --outputFile=test-results.json
pnpm req:trace
pnpm req:validate
pnpm docs
```

Expected:

- 全テスト pass
- `requirements.yaml` の status が正しく更新
- `req:validate` が pass (この時点では Orphaned AC が残る可能性あり — 未タグ付けの AC)
- `docs/generated/openapi.yaml` が生成
- `docs/generated/api/` が生成

**注意**: `req:validate` で Orphaned AC エラーが出る場合、それは「まだテストが対応していない AC」を示す。初期導入時は許容し、段階的にカバレッジを上げる。必要に応じて `req-validate.ts` に `--allow-uncovered` フラグを追加するか、Orphaned AC チェックを warning に変更する。

- [ ] **Step 2: req-validate の Orphaned AC チェックを warning に変更（必要に応じて）**

初期導入時は Orphaned AC を error ではなく warning として扱うよう修正:

`scripts/req-validate.ts` の Orphaned AC チェック部分:

```typescript
// 1. Orphaned AC: requirements.yaml にあるがテストから参照されない (warning)
const warnings: string[] = [];
for (const acId of allAcIds) {
  if (!testReqIds.has(acId)) {
    warnings.push(`Orphaned AC: ${acId} はテストから参照されていません`);
  }
}
```

warnings は出力するが `process.exit(1)` しない。errors (Orphaned Tag, Stale ADR Ref) のみ失敗にする。

- [ ] **Step 3: 最終コミット**

```bash
git add -A
git commit -m "docs: Living Documentation 体系の初期導入完了

4層ドキュメント体系を確立:
- Layer 1: docs/requirements.yaml (構造化要件)
- Layer 2: docs/adr/ (意思決定記録 6件)
- Layer 3: OpenAPI + TypeDoc 自動生成
- Layer 4: テスト名に要件 ID、Reconciliation スクリプト"
```
