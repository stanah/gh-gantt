# 開発ワークフロー（gh-gantt プロジェクト）

## 作業開始

1. タスクのステータスを作業中に更新する
2. フィーチャーブランチを作成する: `git checkout -b feat/issue-<number>-<description> main`

## タスク化

**ゲート:** 選択したタスクがそのまま着手可能な場合はスキップ可

- タスクの粒度が適切で、作業内容が明確
- 追加の分解や子タスク作成が不要

1. タスクの要件を確認し、作業範囲を明確にする
2. 必要であれば作業単位に分解し、子タスクとして作成する
3. 既存タスクとの重複・矛盾がないか確認する

## 設計

**ゲート:** 以下に該当する場合はスキップ可

- バグ修正で原因が明確
- 既存パターンの踏襲で設計判断が不要
- 文言修正・設定変更など、影響範囲が自明

1. `superpowers:brainstorming` で要件を明確化し、設計をまとめる
2. `superpowers:writing-plans` で実装計画を作成する

## 開発

1. `superpowers:test-driven-development` に従って実装する
2. こまめにコミットし、リモートに push する

検証コマンド: `pnpm typecheck && pnpm test && pnpm build`

## 完了

1. `superpowers:verification-before-completion` で検証する
2. Pull Request を作成する（description に `Closes #<number>` を記載）
3. レビュー指摘は精査してから対応し、同じ PR に追加コミットする
4. CI 通過・レビュー承認後、PR をマージする

## Living Documentation

このプロジェクトは Living Documentation (Cyrille Martraire) 体系で要件・ADR・テストのトレーサビリティを管理する。運用手順は `gh-gantt-living-documentation` スキルを参照すること。以下はプロジェクト固有の設定：

- **要件ファイル**: `docs/requirements.yaml`
- **ADR ディレクトリ**: `docs/adr/`（Markdown + frontmatter, `ADR-NNN-slug.md`）
- **機能領域コード**: `SYNC`, `HIER`, `VIS`, `CLI`, `API`, `STORE`
- **言語**: 日本語（`description` フィールドとテスト名は日本語、ID プレフィックスは英語）
- **スクリプト**:
  - テスト (JSON reporter): `pnpm run test:json`
  - Reconciliation: `pnpm run req:trace`
  - 整合性検証: `pnpm run req:validate`
  - 自動生成ドキュメント: `pnpm run docs:gen`
- **自動生成物の出力先**: `docs/generated/`（gitignore 済み、CI で毎回生成）
- **設計仕様**: `docs/adr/ADR-012-living-documentation-four-layer-system.md`

振る舞い変更を伴う開発では、Issue 作成時または実装中に `gh-gantt-living-documentation` スキルを invoke して、要件 AC の追加とテスト名への `[ID]` 付与を行うこと。

## Dev-Role Config

`gh-gantt-dev-role` スキル用の設定。orchestrator / planner / implementer / executor / reviewer の各ロールが参照する。

```yaml
verifyCommands:
  - "pnpm typecheck"
  - "pnpm lint"
  - "pnpm test:json"
  - "pnpm build"
  - "pnpm req:trace"
  - "git diff --exit-code docs/requirements.yaml"
  - "pnpm req:validate"
  - "pnpm docs:gen"
scratchpadDir: ".dev-flow"
maxImprovementIterations: 3
maxExecutorRetries: 2
branchNaming: "feat/issue-{number}-{slug}"
prCreator: "gh pr create"
allowImplementerCommit: true
```

- `verifyCommands` は CI / pre-push の検査を包含し、`typecheck` / `lint` も加えた PR 前 gate
- `scratchpadDir` (`.dev-flow/`) は gitignore 済み — role の中間 artifact はコミットしない
- `allowImplementerCommit: true` で implementer がコミット可 (lefthook の pre-commit が一段ガードする)

## Red Flags

| やってはいけないこと               | 理由                         |
| ---------------------------------- | ---------------------------- |
| 設計せずに実装を始める             | 手戻りが発生する             |
| テストを後回しにする               | TDD の意味がなくなる         |
| レビュー指摘を別 Issue にする      | レビュー修正は既存 PR の一部 |
| CLI の --help を確認せずに作業する | 既存機能を見落とす           |
| 要望を直接コード修正で対応する     | まず Issue を作成する        |
