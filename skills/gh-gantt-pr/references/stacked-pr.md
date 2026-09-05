# スタック PR

1 つの Issue を、レビュー観点ごとの PR の連なりに分ける。
目的は 1 PR を 1 観点で読めるようにすることで、PR を増やすことではない。

## 分ける基準

次のどれかに当たり、かつ各層が単独で CI を通せるときだけ分ける。

- 設計（ADR や型）と実装が混ざっている
- 挙動を変えない整理と挙動の変更が混ざっている
- 機械的な大量変更と手書きの変更が混ざっている
- 差分が 400 行を超え、観点が複数ある

途中の層がテストを通らない分割はしない。
層の順はレビュアーが理解する順にする。契約、実装、利用側の順が典型。

## branch 名と PR

全層を `<prefix>/issue-<number>-<slug>/<k>-<layer>` にする。`k` は 1 始まり。
単一 PR 用の `<prefix>/issue-<number>-<slug>` と混ぜると ref 名が衝突して push できない。

title は既定の title に `(k/N)` を付ける。
body は SKILL.md の型に従い、Summary の直後に前提 PR の番号を 1 行書く。
Issue link は最上層だけ `Closes #<issue-number>`（bug は `Fixes`）にし、下の層は `Part of #<issue-number>` と書く。
途中の層で Issue が閉じると、ADR-019 の PR evidence ゲートが残りの層を見なくなる。
Test Plan にはその層で実行した検証だけを書く。

## 作り方

`gh stack` 拡張（`gh extension install github/gh-stack`）があるなら、`<base>` を trunk にして `gh stack init` し、`gh stack add` で層を積み、`gh stack submit` で PR を作る。
title と body は `gh pr edit <number> --title <title> --body-file <body-file>` で型に揃える。
下の層を直したらその層に commit し、`gh stack sync` で上の層を rebase する。

拡張がないときは手で積む。層 1 を `<base>` から、層 k を層 k-1 から branch し、
`gh pr create --base <lower-branch> --head <upper-branch> --title <title> --body-file <body-file>` で作る。
下の層が merge されたら `gh pr edit <number> --base <new-base>` で上の層の base を付け替える。

## レビューと merge

レビューサイクルは層ごとに `pr-review-cycle-wait.sh --pr <number>` で回す。
merge は下の層から行う。merge の判断はこの skill の範囲外で、レビューサイクルが担う。
