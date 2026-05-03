---
name: gh-gantt-pr
description: Issue から branch 名と Pull Request description を標準化し、gh pr create で PR を作成する。ビルド、テスト、lint、typecheck、hook、レビュー監視は扱わない。
---

# gh-gantt PR 作成ワークフロー

Issue から branch を切り、Pull Request を作成するまでの接続だけを標準化する。品質ゲート、レビュー対応、言語やパッケージマネージャ固有の手順はプロジェクト側の workflow / CI / hook に委譲する。

## 入力

- Issue 番号
- Issue タイプ（`task`, `feature`, `bug`, `epic`）
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

未知のタイプは `chore` を使う。実行環境が agent 用 namespace を要求する場合は、規定の branch 名の前に namespace を付ける（例: `codex/feat/issue-44-label-filter`）。

slug は Issue タイトルから生成する。

- 英数字は小文字化する
- 日本語はローマ字化せず、意味が失われる場合は短い英語 slug を自分で付ける
- 空白、記号、連続する区切り文字は `-` に正規化する
- 末尾と先頭の `-` は削除する

例:

- `bug` + `#52` + `Undo drag bug` → `fix/issue-52-undo-drag-bug`
- `feature` + `#44` + `Label filter` → `feat/issue-44-label-filter`

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
6. `gh pr create --base <base> --head <branch> --title <title> --body <body>` を実行する。

## 扱わないこと

- ビルド・テスト・lint・typecheck の実行
- pre-commit / pre-push フックの設定または実行
- レビュー監視、レビューコメント対応、未解決 thread の resolve
- 言語、パッケージマネージャ、テストランナーの選択
