# 開発ワークフロー（gh-gantt プロジェクト）

## 作業開始
1. メインブランチを最新化する: `git checkout main && git pull origin main`
2. `gh-gantt pull` で最新のタスクデータを取得する
3. `gh-gantt task list --state open` で今日着手するタスクを確認・選択する
4. ブランチを切る: `git checkout -b feat/issue-<number>-short-title main`

## タスク化
1. 機能追加・改善の要望はまず gh-gantt issue を作成し、直接コードを修正しない
2. 既存の CLI オプションを `--help` で確認してから作業する
3. 必要であれば作業単位に分解し、子 Issue としてタスク化する

## 開発（TDD）
1. テストを先に書く — 新機能・バグ修正は失敗するテストから始める
2. 最小限の実装 — テストが通る最小のコードを書く
3. リファクタ — テストが通った状態を維持しつつ整理する
4. `pnpm typecheck && pnpm test && pnpm build` で検証
5. こまめにコミットし、手元のブランチをリモートに push する

## 完了
1. Pull Request を作成する（`Closes #<number>` を description に記載）
2. レビュー指摘に対応し、修正は同じ PR に追加コミットする
3. CI が通過しレビューが承認されたら PR をマージする
4. `gh-gantt push` で同期する（タスクの close は PR マージ時に GitHub が自動で行う）
