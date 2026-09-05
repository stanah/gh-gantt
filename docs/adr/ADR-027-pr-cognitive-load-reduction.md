---
id: ADR-027
title: PR の認知負荷軽減を gh-gantt-pr skill の任意拡張として扱う
date: 2026-09-05
status: accepted
related_requirements:
  - NFR-STABILITY-008
---

## Context

`gh-gantt-pr` skill は branch 名と PR body を標準化し、`gh pr create` を実行するまでを定めている（ADR-014、NFR-STABILITY-008）。
レビュアーが「何が、なぜ、どう変わったか」を掴む手段は定めていないため、agent が作る PR の説明品質は揺れる。

2026 年に GitHub 側の前提が三つ変わった。
gh CLI 2.99.0 が `--attach` で画像と動画を PR body に埋め込めるようになった。
Stacked pull requests が public preview になり、`gh stack` 拡張で 1 Issue を複数の PR に分けられるようになった。
`actions/upload-artifact@v7` の `archive: false` で、単一 HTML を zip なしで artifact にすると、ブラウザで直接描画され、インライン JavaScript も動く。JavaScript が動くことは 2026-09-05 に本リポジトリで確認した。

説明資料には二つの制約がある。
操作を伴うインタラクティブな HTML でなければ図解の価値が出ない。
PR body やコメントに HTML の本文を置くと、agent が PR を読むたびにコンテキストウィンドウを圧迫する。

## Decision

添付、スタック PR、説明資料の三つを `gh-gantt-pr` の任意拡張として reference に置く。
既定の最小フローは変えず、製品 CLI に PR 操作のコマンドを追加しない（ADR-013）。

添付は gh 2.99.0 以上で `--attach` を使い、画像と動画に限る。3 枚まで。

スタック PR は「1 PR = 1 レビュー観点」かつ「各層が単独で CI green」のときだけ使う。
全層を `<prefix>/issue-<number>-<slug>/<k>-<layer>` とし、Issue link は最上層だけ `Closes` にする。
途中の層で Issue が閉じると ADR-019 のゲートが残りの層を見なくなるためである。

説明資料は単一 HTML を git 管理外に書き、Actions artifact（`archive: false`、保持 90 日）として公開する。
PR には workflow が書くリンク 1 行のコメントだけを残し、HTML の本文は PR のテキストに置かない。
HTML は一時 branch `pr-explainer/<PR 番号>-<時刻>` に workflow と共に push し、その branch の `push` トリガーで公開する。
workflow は公開後に一時 branch を削除する。
この方式は既定 branch に依存せず、導入 PR 自身の資料をその PR で公開できる。

PR body は型を固定する。
先頭は前提なしで読める 1 文。Summary は 5 行以内で各 1 行。太字を使わず、経緯や設計は ADR へのリンクにする。

## Alternatives

### HTML を PNG に変換して `--attach` する

`--attach` が画像しか受け付けないための案。クリックや段階表示が失われ、HTML で作る意味が消える。却下。

### HTML を PR コメントに埋め込み、workflow が取り出して artifact にする

輸送路が GitHub の中で閉じるが、HTML が PR のテキストに残り、agent のコンテキストを圧迫する。折り畳んでも同じ。却下。

### `workflow_dispatch` の input で HTML を渡す

git に触れない利点があるが、input 総量 65,535 文字の上限があり、既定 branch にある workflow しか起動できない。
導入 PR 自身では動かせず、起動に `actions: write` も要る。一時 branch への `push` トリガーのほうが制約が少ない。却下。

### GitHub Pages に PR ごとの path で配置する

本リポジトリは公開リポジトリであり、Pages で公開されること自体は新たな露出ではない。
ログイン不要、失効なし、URL 安定の点で artifact を上回る。
一方で HTML を `gh-pages` branch に commit することになり、PR の close 時に消す運用も要る。
ログイン必須と 90 日失効を許容して artifact を選んだ。公開リポジトリで閲覧条件を緩めたい project は公開先を Pages に差し替えられる。

### branch 以外の隠し ref、Gist、外部ホスティングを輸送路にする

隠し ref は Claude Code on the web の git 経路で `refs/heads/` 以外への push が拒否された。
Gist は資料の所在が PR から離れる。外部ホスティングは外部アカウントとトークンを agent 環境に置く。
いずれも branch への push だけで成立する経路に劣る。却下。

### CI が差分から説明資料を機械生成する

agent が伝えたい観点を CI が推測することになる。変更ファイルツリーや差分統計は #301 で別に扱う。

## Consequences

- `gh-gantt-pr` に reference 3 本と workflow テンプレート、契約検証スクリプトが加わる。本リポジトリは同じ workflow を `.github/workflows/` に置き、テストで一致を検証する
- 説明資料の閲覧にはリポジトリの read 権限とログインが要り、90 日で失効する。原本は agent の手元に残るので再公開できる
- 一時 branch の間だけ HTML が git の ref に載る。main の履歴には入らない
- gh 2.99.0 未満、GHES、stacked PR 未有効、workflow 未配置の project では、各拡張を使わず最小フローだけで完了できる
