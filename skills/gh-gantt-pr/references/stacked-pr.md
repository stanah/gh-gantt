# スタック PR（`gh stack`）

1 つの Issue の変更を、レビュー観点ごとに分けた複数の小さな PR の連なり（stack）として出す手順。
gh-gantt-pr の任意拡張であり、分割しない場合は既定の単一 PR フローをそのまま使う。

スタックの目的は **1 PR = 1 レビュー観点** にしてレビュアーの認知負荷を下げることである。
PR の数を増やすこと自体は目的ではない。

## 前提

| 条件   | 内容                                                                                        |
| ------ | ------------------------------------------------------------------------------------------- |
| GitHub | Stacked pull requests（2026-07-30 に public preview）。リポジトリで利用できることを確認する |
| 拡張   | `gh extension install github/gh-stack`（gh 2.0 以上）。未導入なら後述の fallback を使う     |
| 履歴   | 各 layer は線形履歴。layer 間に merge commit を作らない                                     |
| CI     | **各 layer が単独で CI green になる**こと。ならない分割は意味がないので layer を統合する    |

## 分割の判断

以下のいずれかに該当し、かつ各 layer が単独でビルド・テストを通せる場合に分割する。

| 分割する                                                     | 分割しない                                       |
| ------------------------------------------------------------ | ------------------------------------------------ |
| refactor（挙動不変）と挙動変更が混在する                     | 差分が小さく単一観点で読める（目安: 400 行未満） |
| スキーマ / 型 / API 契約の変更と、その利用側の変更が混在する | layer に分けると途中の layer がテスト失敗する    |
| 生成物・大量の機械的変更と、手書きの本質的変更が混在する     | レビュアーが 1 人で、往復コストのほうが大きい    |
| ADR / 要件定義（設計）と実装が混在し、設計だけ先に合意したい | hotfix で速度が優先される                        |

分割順は「レビュアーが理解する順」にする。典型: 契約（型・スキーマ・ADR）→ 実装 → 利用側・UI → 生成物。

## branch 名

スタックでは全 layer を `<prefix>/issue-<number>-<slug>/<k>-<layer-slug>` にする（`k` は 1 始まりの層番号）。
既定の単一 branch 名 `<prefix>/issue-<number>-<slug>` は **使わない**。
git では `a/b` と `a/b/c` の ref が共存できないため、混在させると push に失敗する。

例（Issue #344、feature）:

```text
feat/issue-344-pr-cognitive-load/1-adr
feat/issue-344-pr-cognitive-load/2-skill-references
feat/issue-344-pr-cognitive-load/3-render-script
```

`prefix` と `slug` の決め方は SKILL.md の規則に従う。

## PR title と body

- title は `<既定の title> (k/N)` とし、何層目かを一目で示す
- body は SKILL.md の `Summary` / Issue link / `Test Plan` の順を維持し、`Summary` の直後に `## Stack` を置く
- **Issue link は最上層（最後に merge される layer）だけ `Closes #<issue-number>`**（bug は `Fixes`）。
  それ以外の layer は `Part of #<issue-number>` と書く。途中の layer の merge で Issue が閉じると、
  gh-gantt の task 状態が早期に Done になり、ADR-019 の PR evidence ゲートが残りの layer を見なくなる
- `Test Plan` は **その layer で実行した検証**だけを書く。全体の検証を全 layer にコピーしない

```markdown
## Summary

- <この layer の変更内容>

## Stack

2/3 — 前提: #<lower-pr-number>（1/3）。この layer だけをレビューする場合は `gh pr diff <this-pr-number>`。

Part of #<issue-number>

## Test Plan

- <この layer で実行した検証>
```

## 手順（`gh stack` あり）

1. `gh stack init` でスタックを開始し、`gh stack add <branch>` で layer 1 の branch を作る
2. layer 1 の変更を commit する。次の layer は `gh stack add <branch>` で上に積む
3. 各 layer の PR body を `<body-file>` として用意する（layer ごとに別ファイル）
4. `gh stack submit` で全 layer の PR を作成し、GitHub 上で stack として連結する
5. `gh pr edit <number> --title <title> --body-file <body-file>` で各 PR の title / body を本スキルの形式に揃える
6. `gh stack view` で base branch の連鎖と PR 番号を確認し、Issue link が最上層だけ `Closes` になっていることを確認する
7. 下層にレビュー修正を入れたら、修正は **その layer** に commit し、`gh stack sync` で上層を rebase して push する

## 手順（`gh stack` なしの fallback）

1. layer 1 を `main` から、layer k を layer k-1 から branch する
2. 各 layer を `gh pr create --base <lower-branch> --head <upper-branch> --title <title> --body-file <body-file>` で作成する
   （layer 1 の base は `main`）
3. `## Stack` に前提 PR の番号を手書きする（stack map の UI はない）
4. 下層が merge されたら、上層の base を `gh pr edit <number> --base <new-base>` で付け替える。
   下層 branch の削除時に GitHub が自動で付け替えることもあるが、必ず確認する
5. 下層への修正後は上層を手動で rebase し、`--force-with-lease` で push する

## レビューサイクルとの関係

- PR 作成後のレビューサイクル（`gh-gantt-workflow`）は **layer ごと**に `pr-review-cycle-wait.sh --pr <number>` で回す
- 完了報告では全 layer の PR 番号と未解決 thread 件数を列挙する
- merge は下層から順に行う。上層の merge 判断は本スキルの範囲外（レビューサイクルの責務）

## Red Flags

| やりがちなこと                                    | 問題                                                      |
| ------------------------------------------------- | --------------------------------------------------------- |
| 全 layer に同じ Summary / Test Plan をコピーする  | 分割の意味がなく、レビュアーが差分を自分で切り分ける      |
| 下層のバグを上層で直す                            | 下層 PR が壊れたまま merge され、履歴が読めなくなる       |
| 単独で CI が通らない layer を作る                 | 途中状態が main に入り、bisect とロールバックが壊れる     |
| 全 layer に `Closes #N` を書く                    | 最初の merge で Issue が閉じ、残りの layer が追跡されない |
| 単一 branch 名と `/<k>-` 付き branch を混在させる | ref 名の衝突で push が失敗する                            |
