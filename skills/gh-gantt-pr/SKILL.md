---
name: gh-gantt-pr
description: Issue から branch 名と Pull Request description を標準化し、gh pr create で PR を作成する。任意拡張として画像添付（--attach）、スタック PR（gh stack）、図解 / HTML 説明資料でレビュアーの認知負荷を下げる。ビルド、テスト、lint、typecheck、hook、レビュー監視は扱わない。
---

# gh-gantt PR 作成ワークフロー

Issue から branch を切り、Pull Request を作成するまでの接続だけを標準化する。品質ゲート、レビュー対応、言語やパッケージマネージャ固有の手順はプロジェクト側の workflow / CI / hook に委譲する。

PR の認知負荷軽減（添付・スタック PR・説明資料）は [任意の拡張](#任意の拡張認知負荷軽減) として提供し、既定の最小フローは変えない。

## 入力

- Issue 番号
- Issue タイプ（`task`, `feature`, `bug`, `epic`, `milestone`）
- Issue タイトル
- base branch（未指定なら `main`）
- Summary に入れる変更内容
- Test Plan に入れる検証内容

Issue の現在情報は `gh-gantt show <issue-number> --json` で取得する。

## branch 名

branch 名は `<prefix>/issue-<number>-<slug>` とする。

| Issue タイプ | branch prefix |
| ------------ | ------------- |
| `task`       | `feat`        |
| `feature`    | `feat`        |
| `bug`        | `fix`         |
| `epic`       | `epic`        |
| `milestone`  | `milestone`   |

未知のタイプは `chore` を使う。実行環境が agent 用 namespace を要求する場合は、規定の branch 名の前に namespace を付ける（例: `codex/feat/issue-44-label-filter`）。

slug は Issue タイトルから生成する。

- 英数字は小文字化する
- 日本語はローマ字化せず、意味が失われる場合は短い英語 slug を自分で付ける
- 空白、記号、連続する区切り文字は `-` に正規化する
- 末尾と先頭の `-` は削除する

例:

- `bug` + `#52` + `Undo drag bug` → `fix/issue-52-undo-drag-bug`
- `feature` + `#44` + `Label filter` → `feat/issue-44-label-filter`
- `milestone` + `#60` + `Phase 1 release` → `milestone/issue-60-phase-1-release`

## PR description

PR body は以下の形にする。Issue タイプが `bug` の場合は `Fixes #<issue-number>`、それ以外は `Closes #<issue-number>` を使う。

```markdown
## Summary

- <変更内容>

Closes #<issue-number>

## Test Plan

- <実行した検証>
```

`Test Plan` には未実行のものを成功扱いで書いてはならない。未実行なら理由付きで `未実行: <理由>` と明記する。

## 手順

1. `gh-gantt show <issue-number> --json` で Issue 番号、タイプ、タイトルを確認する。
2. branch 名を `<prefix>/issue-<number>-<slug>` で決める。
3. base branch から branch を作成する。
4. 変更を commit し、remote に push する。
5. PR body を `Summary`、`Closes #<issue-number>` または `Fixes #<issue-number>`、`Test Plan` の順で作る。
6. PR body を一時ファイルに保存し、`gh pr create --base <base> --head <branch> --title <title> --body-file <body-file>` を実行する。
7. 任意: 下の判断表に該当する場合だけ、対応する拡張の reference に従う。該当しなければ何も追加しない。

## 任意の拡張（認知負荷軽減）

レビュアーが差分を読む前に「何が・なぜ・どう変わったか」を掴めるようにする 3 手段。
いずれも「使う場面」のゲートを持つ任意手順であり、常時適用を要求しない。設計判断は ADR-027 を正本とする。

| 使う場面                                                             | 拡張                 | reference                                                |
| -------------------------------------------------------------------- | -------------------- | -------------------------------------------------------- |
| UI の before / after を PR body に埋め込みたい                       | 画像・動画の添付     | [references/attachments.md](references/attachments.md)   |
| 1 Issue の変更がレビュー観点ごとに分けられ、各層が単独で CI を通せる | スタック PR          | [references/stacked-pr.md](references/stacked-pr.md)     |
| 複数モジュール横断、責務境界や状態遷移の変更、新しい概念の導入       | 図解 / HTML 説明資料 | [references/pr-explainer.md](references/pr-explainer.md) |

共通ルール:

- 添付は画像・動画のみ（gh 2.99.0 以上）。HTML は添付できない
- 図解は Mermaid で表せるなら PR body に直接書き、HTML はクリックや段階表示が必要なときだけ作る
- 説明資料の HTML は git 管理外（`scratchpadDir/<issue-number>/pr-explainer/` または `.gantt-sync/pr-explainer/<issue-number>/`）に置き、commit しない
- HTML は project の pr-explainer workflow で Actions artifact（`archive: false`）として公開し、PR にはリンク 1 行のコメントだけを残す。公開は `scripts/pr-explainer-publish.mjs` で行う
- HTML の本文を PR body やコメントに貼らない。エージェントが PR を読むときにコンテキストを圧迫する
- workflow（`.github/workflows/pr-explainer.yml`）がない project では HTML を作らず、Mermaid とテキストに留める
- スタック PR では Issue link を最上層だけ `Closes` / `Fixes` とし、他の層は `Part of #<issue-number>` と書く
- 前提（gh のバージョン、`gh stack` 拡張、GitHub のプラン）を満たさない場合は各 reference の fallback に従い、最小フローだけで完了してよい

## 扱わないこと

- ビルド・テスト・lint・typecheck の実行
- pre-commit / pre-push フックの設定または実行
- レビュー監視、レビューコメント対応、未解決 thread の resolve
- 言語、パッケージマネージャ、テストランナーの選択
- スタック PR の merge 判断と順序管理（レビューサイクルの責務）
- 説明資料を公開する workflow の運用（`templates/pr-explainer.yml` を配布するが、配置と権限設定は project 側の判断）
