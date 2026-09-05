# 説明資料（インタラクティブな HTML）

差分を読む前に構造の変化を掴ませるための単一 HTML。
クリックや段階表示が要るときだけ作る。操作のない図は Mermaid で PR body に書く。

## 作る場面

複数モジュールにまたがる変更、責務境界や状態遷移の変更、新しい概念の導入。
数ファイルの修正や文言変更では作らない。1 PR に 1 つ、主張は 1 つ。

## HTML の契約

- 単一ファイル。CSS と JS はインライン、画像は data: URI で埋め込む
- 別ファイルを参照しない。`src`、`srcset`、`poster`、`data`、`<link>` と SVG の `href` は data: URI だけ。`<a>` のリンクは書いてよい
- `@import` を使わない。`url()` は data: URI と `#fragment` だけ
- 日本語で書き、実際のファイル名やコマンドを使う
- git 管理外に置く。Dev-Role Config があれば `<scratchpadDir>/<issue-number>/pr-explainer/`、なければ `.gantt-sync/pr-explainer/<issue-number>/`

契約は `node skills/gh-gantt-pr/scripts/check-explainer.mjs <file>` で確認できる。workflow も同じ検証を行う。

## PR に HTML を書かない

HTML の本文を PR body やコメントに貼らない。折り畳んでも同じ。
エージェントは PR を読むたびにそれを取り込み、コンテキストを圧迫する。
PR に残るのは workflow が書くリンク 1 行のコメントだけ。

## 公開の手順

HTML は Actions artifact（`archive: false`）として公開する。ブラウザで開くとそのまま描画され、JavaScript も動く（2026-09-05 に確認）。
artifact は workflow run の中でしか作れないので、HTML を一時 branch に載せて push し、その branch の workflow で公開する。
project は [templates/pr-explainer.yml](../templates/pr-explainer.yml) を `.github/workflows/pr-explainer.yml` に置く。

```bash
git worktree add -q /tmp/pr-explainer HEAD -b "pr-explainer/<number>-$(date -u +%Y%m%dT%H%M%SZ)"
cp <file> /tmp/pr-explainer/explainer.html
git -C /tmp/pr-explainer add explainer.html
git -C /tmp/pr-explainer commit -q --no-verify -m "<title>"
git -C /tmp/pr-explainer push -q --no-verify origin HEAD
git worktree remove /tmp/pr-explainer
```

`<number>` は資料を付ける PR の番号、`<title>` はコメントの見出しになる。
一時 branch は資料だけを運ぶので、project のフックは `--no-verify` で飛ばす。
workflow は契約を検証し、artifact を作り、PR に `<!-- pr-explainer -->` を目印とするコメントを作るか更新し、一時 branch を削除する。

## 制約

- 閲覧にはリポジトリの read 権限と GitHub へのログインが要る。公開リポジトリでも同じ
- 90 日で失効する。原本は手元にあるので、同じ手順で再公開できる
- artifact は run の Artifacts 欄に出ない。導線は PR コメントのリンクだけ
- 一時 branch の間だけ HTML が git の ref に載る。main の履歴には入らない
- `.github/workflows/pr-explainer.yml` がない project では HTML を作らず、Mermaid とテキストに留める
