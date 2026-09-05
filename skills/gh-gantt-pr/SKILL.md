---
name: gh-gantt-pr
description: Issue から branch 名と Pull Request description を標準化し、gh pr create で PR を作成する。任意拡張として画像添付、スタック PR、説明資料を扱う。ビルド、テスト、lint、typecheck、hook、レビュー監視は扱わない。
---

# gh-gantt PR 作成ワークフロー

Issue から branch を切り、Pull Request を作成するまでの接続だけを標準化する。品質ゲート、レビュー対応、言語やパッケージマネージャ固有の手順はプロジェクト側の workflow / CI / hook に委譲する。

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

読みやすさの型:

- 先頭に、前提なしで読める 1 文を置く
- Summary は 5 行以内、各 1 行。太字を使わず、コードスパンは 1 行に 1 つまで
- 経緯や設計は書かず、ADR や Issue へのリンクにする
- 図は Mermaid で 6 ノード以内。HTML の本文を PR に貼らない

## 手順

1. `gh-gantt show <issue-number> --json` で Issue 番号、タイプ、タイトルを確認する。
2. branch 名を `<prefix>/issue-<number>-<slug>` で決める。
3. base branch から branch を作成する。
4. 変更を commit し、remote に push する。
5. PR body を `Summary`、`Closes #<issue-number>` または `Fixes #<issue-number>`、`Test Plan` の順で作る。
6. PR body を一時ファイルに保存し、`gh pr create --base <base> --head <branch> --title <title> --body-file <body-file>` を実行する。
7. 下の表に当たる場合だけ、対応する reference に従う。当たらなければ何も足さない。

## 任意の拡張

レビュアーが差分を読む前に全体を掴めるようにする手段。設計判断は ADR-027 にある。

| 場面                                               | reference                                                |
| -------------------------------------------------- | -------------------------------------------------------- |
| UI の変更前後を見せたい                            | [references/attachments.md](references/attachments.md)   |
| 変更が観点ごとに分けられ、各層が単独で CI を通せる | [references/stacked-pr.md](references/stacked-pr.md)     |
| 操作を伴う構造図で全体像を渡したい                 | [references/pr-explainer.md](references/pr-explainer.md) |

## 扱わないこと

- ビルド・テスト・lint・typecheck の実行
- pre-commit / pre-push フックの設定または実行
- レビュー監視、レビューコメント対応、未解決 thread の resolve
- 言語、パッケージマネージャ、テストランナーの選択
- スタック PR の merge 判断
