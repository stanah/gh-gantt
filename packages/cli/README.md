# gh-gantt

GitHub Projects (V2) と双方向同期し、タスクの階層・依存・進捗をガントチャートで可視化する CLI。

AI エージェント（Claude Code 等）と同じワークフローで人間もタスクを管理できるよう、すべての操作を CLI から完結させる設計。プロジェクトデータは `.gantt-sync/` にローカルキャッシュされ、セッションをまたいでもコンテキストを即座に取り戻せる。

## インストール

```bash
npm install -g gh-gantt
# or: pnpm add -g gh-gantt / yarn global add gh-gantt / bun add -g gh-gantt
```

### 前提

- Node.js >= 24
- GitHub CLI (`gh`) がインストール済みかつ `gh auth login` 済み

## 使い方

```bash
# 初期化（GitHub Project (V2) を取り込む）
gh-gantt init --owner <owner> --repo <repo> --project <project_number>

# 同期
gh-gantt pull     # GitHub から最新を取得
gh-gantt push     # ローカル変更を GitHub に反映
gh-gantt status   # 同期状態を表示

# タスク
gh-gantt list                  # 一覧
gh-gantt show <id>             # 詳細
gh-gantt update <id>           # 更新
gh-gantt link <id>             # 親子・依存関係を設定
gh-gantt create                # ローカルドラフト作成

# コンフリクト
gh-gantt conflicts             # 未解決コンフリクト一覧
gh-gantt resolve [issue]       # 解決

# ガントチャート UI（同梱の React SPA を配信）
gh-gantt serve                 # http://localhost:3000
gh-gantt serve --port 8080
gh-gantt serve --api-only      # API のみ
```

## Claude Code との統合

`skills/gh-gantt-*` 系のスキル（[GitHub リポジトリ](https://github.com/stanah/gh-gantt/tree/main/skills) で配布）は `gh-gantt` コマンドが PATH 上にあることを前提とする。Claude Code をローカルで使う場合は `npm install -g gh-gantt` などで一度だけインストールしておけばよい。

クラウド環境（Claude Code on Web 等）でセッションごとに環境がリセットされる場合は、SessionStart hook で `npm install -g gh-gantt` を実行するか、`npx -y gh-gantt <command>` の形でオンデマンド実行する。

## リポジトリ

ソース・Issue・ドキュメント: https://github.com/stanah/gh-gantt

## ライセンス

MIT
