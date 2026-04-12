# AGENTS.md

AI エージェント向けのガイドライン。このリポジトリで作業する際の指針を提供する。

## なぜ gh-gantt を作るのか

GitHub Projects (V2) はタスクをボードやテーブルで整理できるが、以下が欠けている：

1. **プロジェクト全体の構造が見えない** — タスクの親子関係（エピック→フィーチャー→タスク）、依存関係、階層的な進捗の集約がない。個々のタスクは見えても「プロジェクトは予定通りか」「ボトルネックはどこか」が判断できない。

2. **AI エージェントが操作できない** — GitHub Projects の操作は Web UI に閉じている。CLI インターフェースがあれば、Claude Code のような AI エージェントも人間と同じワークフローでタスクを管理できる。

3. **セッションをまたいだコンテキストがない** — AI エージェントは会話が切り替わるとコンテキストを失う。プロジェクトデータをローカルファイル（`.gantt-sync/`）に保持することで、新しい会話でも `gh-gantt status` 一つで現在地を把握できる。

gh-gantt はこれらを解決する CLI ツール。GitHub Projects (V2) と双方向同期し、ガントチャートでタスクの時間軸・依存関係・階層的進捗を可視化する。

## このプロジェクトでの使い方

**gh-gantt 自身も gh-gantt でタスク管理している（セルフホスティング）。**
gh-gantt CLI は開発対象であると同時に、このプロジェクトの作業ツールでもある。

- **何をすべきか知る** → `gh-gantt list`, `gh-gantt status`
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

`skills/` 配下のスキルは **gh-gantt ツール自体の使い方** を記述したもの。
このプロジェクト固有の運用ではなく、gh-gantt を使う任意のプロジェクトで適用できる汎用的な知識。

- **`gh-gantt-workflow`** — 開発サイクル全体のオーケストレーター
- **`gh-gantt-sync`** — pull/push の同期規律
- **`gh-gantt-decompose`** — 要望の調査・分解・Issue 化
- **`gh-gantt-progress`** — 進捗評価・タスク衛生管理
- **`gh-gantt-dependencies`** — 依存関係の設定・検証
- **`gh-gantt-conflict-resolution`** — pull 後のコンフリクト解決手順
- **`gh-gantt-living-documentation`** — Living Documentation 体系を採用したプロジェクトで要件 YAML / ADR / テストタグを管理する（Discovery フェーズでプロジェクト固有のパスを特定）

## 開発コマンド

コード変更には以下を使う。

```bash
pnpm install          # 依存インストール
pnpm build            # 全パッケージビルド（shared → cli/ui の順）
pnpm dev              # 開発モード（CLI watch + UI dev server + API サーバー）
pnpm test             # 全テスト実行
pnpm lint             # lint + format チェック（vp check / Oxlint）
pnpm typecheck        # 型チェック

# 単一パッケージのテスト
pnpm --filter @gh-gantt/cli test
pnpm --filter @gh-gantt/shared test
pnpm --filter @gh-gantt/ui test

# 単一テストファイル
pnpm --filter @gh-gantt/cli exec vp test run src/__tests__/hash.test.ts

# CLI をグローバルにリンク（初回 or 再ビルド後）
pnpm build && pnpm --filter @gh-gantt/cli exec pnpm link --global
```

### CI 再現チェック

`lefthook` の pre-push フックが CI (`.github/workflows/ci.yml`) と同等のチェックを自動実行する。
push 前に以下が順に走るため、CI で落ちることを事前に検出できる。

| ステップ     | コマンド                                  | 目的                                          |
| ------------ | ----------------------------------------- | --------------------------------------------- |
| test         | `pnpm test:json`                          | 全テスト + JSON レポーター (req:trace の入力) |
| build        | `pnpm build`                              | ビルド検証                                    |
| req-trace    | `pnpm req:trace` + `git diff --exit-code` | requirements.yaml のトレーサビリティ検証      |
| req-validate | `pnpm req:validate`                       | テストタグと requirements.yaml の整合性       |
| docs-gen     | `pnpm docs:gen` + `git diff --exit-code`  | 生成ドキュメントの drift 検出                 |

pre-commit フックではブランチ状態チェック（main への直接コミット防止、マージ済みブランチへの誤コミット検出）も実行する。

**手動で CI 相当のチェックを実行する場合:**

```bash
pnpm test:json && pnpm build && pnpm req:trace && git diff --exit-code docs/requirements.yaml && pnpm req:validate && pnpm docs:gen && git diff --exit-code docs/generated/
```

## アーキテクチャ

pnpm workspaces モノレポ。`packages/` 配下に3パッケージ：

- **`@gh-gantt/shared`** — 型定義と Zod スキーマ
- **`@gh-gantt/cli`** — CLI (Commander) + REST API (Express) + 同期エンジン + GitHub GraphQL クライアント
- **`@gh-gantt/ui`** — React SPA (Vite Plus + D3)

## 言語規約

このプロジェクトでは**日本語を第一言語とする**。以下はすべて日本語で記述すること：

- **コミットメッセージ** — タイトル・本文ともに日本語（prefix は英語: `feat:`, `fix:`, `docs:` 等）
- **コードコメント** — インラインコメント、ブロックコメントすべて日本語
- **テスト名** — `describe` / `it` の文字列は日本語
  - 要件トレーサビリティテスト: `describe` に `[FR-*]` / `[NFR-*]` プレフィックスを付与（`req:trace` が走査する対象）
  - リグレッションテスト: `describe` に `[NFR-*]` + `[Issue #N]` を付与。ファイルは `regressions/` 配下に配置
  - ユニットテスト: プレフィックス不要。テスト名は日本語で内容を記述すれば十分
- **TypeDoc / JSDoc コメント** — 関数・型の説明は日本語
- **ドキュメント** — CLAUDE.md, AGENTS.md, ADR, requirements.yaml 等すべて日本語
- **変数名・関数名・型名** — 英語（プログラミング言語の慣例に従う）

## レビュー規律（プロジェクト固有ルール）

このプロジェクトでは **コミット前に自己レビューを実施し、ユーザーの承認を得る** ことを必須とする。

- **コード変更**: `git diff` で確認後、利用可能なレビュー機構を invoke する:
  - サブエージェント: `Agent` tool で `subagent_type: "superpowers:code-reviewer"`, `"pr-review-toolkit:code-reviewer"`, `"code-review"` 等
  - スキル: `Skill` tool で `code-review`, `pr-review-toolkit:review-pr`, `simplify` 等
- **ドキュメント・スキル変更**: `git diff` を Read で確認し、変更の要約と影響範囲をユーザーに提示する
- **いずれの場合も**: レビュー結果をユーザーに提示し、明示的な承認（「OK」「進めて」等）を得てから `git commit` / `git push` / `gh pr create` を実行する
- **省略してよいケース**: ユーザーが「そのままコミットして」等、レビュー省略を明示した場合のみ

このルールは `.claude/settings.json` の PreToolUse hooks により、`git commit` / `gh pr create` 実行時にエージェントへ自動注入される。lefthook の pre-commit / pre-push とあわせて三層ガード (ADR-010) を構成する。

## 開発規約

- ESM（`"type": "module"`、import に `.js` 拡張子必須）
- ファイル読み込みは Zod バリデーション必須
- ビルド: vp pack (cli/shared)、vp build (ui) — すべて vite-plus 統合
- テスト: vp test (Vitest 4.1 ベース、vite-plus 同梱)
- リント: vp check (Oxlint + Oxfmt)
- ローカルデータ: `.gantt-sync/`（gitignore 済み）
