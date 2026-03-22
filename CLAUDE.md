# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## なぜ gh-gantt を作るのか

GitHub Projects (V2) はタスクをボードやテーブルで整理できるが、以下が欠けている：

1. **プロジェクト全体の構造が見えない** — タスクの親子関係（エピック→フィーチャー→タスク）、依存関係、階層的な進捗の集約がない。個々のタスクは見えても「プロジェクトは予定通りか」「ボトルネックはどこか」が判断できない。

2. **AI エージェントが操作できない** — GitHub Projects の操作は Web UI に閉じている。CLI インターフェースがあれば、Claude Code のような AI エージェントも人間と同じワークフローでタスクを管理できる。

3. **セッションをまたいだコンテキストがない** — AI エージェントは会話が切り替わるとコンテキストを失う。プロジェクトデータをローカルファイル（`.gantt-sync/`）に保持することで、新しい会話でも `gh-gantt status` 一つで現在地を把握できる。

gh-gantt はこれらを解決する CLI ツール。GitHub Projects (V2) と双方向同期し、ガントチャートでタスクの時間軸・依存関係・階層的進捗を可視化する。

## このプロジェクトでの使い方

**gh-gantt 自身も gh-gantt でタスク管理している（セルフホスティング）。**
gh-gantt CLI は開発対象であると同時に、このプロジェクトの作業ツールでもある。

- **何をすべきか知る** → `gh-gantt task list`, `gh-gantt status`
- **作業を始める** → `gh-gantt pull` で最新取得、Issue 確認
- **作業が終わる** → `gh-gantt push` で GitHub に反映

gh-gantt CLI はグローバルにインストール済み。`gh-gantt` コマンドで直接実行できる。
**タスク管理や開発の進め方は `gh-gantt-workflow` スキルに従うこと。**

このプロジェクトは個人リポジトリのため GitHub Issue Types は使えない。
代わりに GitHub Labels でタスクの種類を管理している（`gantt.config.json` の `task_types` で定義）。
利用可能なタイプ: `task`, `epic`, `feature`, `milestone`

**IMPORTANT: `.gantt-sync/` 配下の同期データ（`tasks.json`, `sync-state.json`）を直接読み書きしてはならない。**
常に `gh-gantt` CLI コマンドを使うこと。直接操作はバリデーションをバイパスし、同期状態を破損させる。
設定ファイル（`gantt.config.json`, `workflow.md`）は直接編集してよい。

## スキル

`.claude/skills/` 配下のスキルは **gh-gantt ツール自体の使い方** を記述したもの。
このプロジェクト固有の運用ではなく、gh-gantt を使う任意のプロジェクトで適用できる汎用的な知識。
**このプロジェクト固有の開発ルール（TDD、コーディング規約等）は `.gantt-sync/workflow.md` に書く。スキルを変更してはならない。**

- **`gh-gantt-workflow`** — 開発サイクル全体のオーケストレーター
- **`gh-gantt-sync`** — pull/push の同期規律
- **`gh-gantt-decompose`** — 要望の調査・分解・Issue 化
- **`gh-gantt-triage`** — 既存タスクの衛生管理
- **`gh-gantt-dependencies`** — 依存関係の設定・検証
- **`gh-gantt-progress`** — 進捗追跡・リスク評価
- **`conflict-resolution`** — pull 後のコンフリクト解決手順

## 開発コマンド

コード変更には以下を使う。

```bash
pnpm install          # 依存インストール
pnpm build            # 全パッケージビルド（shared → cli/ui の順）
pnpm dev              # 開発モード（CLI watch + Vite dev server）
pnpm test             # 全テスト実行
pnpm typecheck        # 型チェック

# 単一パッケージのテスト
pnpm --filter @gh-gantt/cli test
pnpm --filter @gh-gantt/shared test
pnpm --filter @gh-gantt/ui test

# 単一テストファイル
pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/hash.test.ts

# CLI をグローバルにリンク（初回 or 再ビルド後）
pnpm build && pnpm --filter @gh-gantt/cli exec pnpm link --global
```

## アーキテクチャ

pnpm workspaces モノレポ。`packages/` 配下に3パッケージ：

- **`@gh-gantt/shared`** — 型定義と Zod スキーマ
- **`@gh-gantt/cli`** — CLI (Commander) + REST API (Express) + 同期エンジン + GitHub GraphQL クライアント
- **`@gh-gantt/ui`** — React SPA (Vite + D3)

## 開発規約

- ESM（`"type": "module"`、import に `.js` 拡張子必須）
- ファイル読み込みは Zod バリデーション必須
- ビルド: tsup (cli/shared)、Vite (ui)
- テスト: Vitest
- ローカルデータ: `.gantt-sync/`（gitignore 済み）
