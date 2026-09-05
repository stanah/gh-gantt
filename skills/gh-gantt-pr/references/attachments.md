# 画像・動画の添付（`--attach`）

PR body のテキストだけでは伝わらない「見た目の変化」と「実行結果の証跡」を、
`gh pr create --attach` で PR body に埋め込む手順。gh-gantt-pr の任意拡張であり、
添付がなくても既定の最小フロー（branch / body / `gh pr create`）は成立する。

## 前提

| 条件          | 内容                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| gh バージョン | `gh --version` が **2.99.0 以上**。`--attach` は 2.99.0 で追加された                   |
| GitHub        | GitHub.com または GitHub Enterprise Cloud。GHES では利用できない                       |
| 対象ファイル  | **画像・動画のみ**（png / jpg / gif / webp / mp4 / mov 等）。HTML・PDF・ログは添付不可 |
| 1 回の上限    | 50 ファイル / 1 コマンド。実運用の目安は 3 枚以内（後述）                              |
| 対応コマンド  | `gh pr create`, `gh pr edit`, `gh pr comment`, `gh issue create/edit/comment`          |

HTML 説明資料を見せたい場合は [pr-explainer.md](pr-explainer.md) の手順で PNG に変換してから添付する。

## 構文

```bash
# 単純添付（body 末尾に追記される）
gh pr create --base <base> --head <branch> --title <title> --body-file <body-file> \
  --attach ./after.png

# alt text 付き（`#` の後がキャプションになる）
gh pr create ... --attach './after.png#変更後のタスク一覧'

# 複数添付（--attach は repeatable）
gh pr create ... --attach './before.png#変更前' --attach './after.png#変更後'
```

body 内での配置を制御したい場合は、`<body-file>` に **ローカルパスのまま** 画像参照を書いておく。
gh は body 内の同じローカルパスをアップロード後の URL に置換し、参照がない添付だけを末尾に追記する。

```markdown
## Summary

- 一覧のフィルタ UI を追加した

| 変更前                  | 変更後                 |
| ----------------------- | ---------------------- |
| ![変更前](./before.png) | ![変更後](./after.png) |

Closes #<issue-number>
```

インラインの `--body` は使わず、常に `--body-file` で本文を渡す（gh-gantt-pr 本体の規約と同じ）。

## 添付する場面と、しない場面

| 添付する                                       | 添付しない（テキストで書く）                       |
| ---------------------------------------------- | -------------------------------------------------- |
| UI 変更の before / after                       | テストコマンドの出力（Test Plan にテキストで貼る） |
| 図解 PNG（pr-explainer で生成）                | 差分そのもの（PR の Files タブが正本）             |
| 再現手順が操作列で、動画のほうが短く伝わる場合 | エラーメッセージ・ログ（検索可能なテキストが優先） |

- **上限の目安は 3 枚**。枚数が増えるほど認知負荷は下がらず上がる。1 枚ごとに「何を見てほしいか」を alt text で書く
- **秘密情報の写り込みを確認する**。betterleaks（ADR-011）はテキスト差分だけを検査し、画像は検査しない。
  token、個人メール、内部 URL が写っていないか添付前に目視する
- **PR 作成後に追加する場合**は `gh pr edit <number> --attach <file>` を使う。body 全体を書き直さない

## gh が古い場合の fallback

1. `gh --version` を確認し、2.99.0 未満なら `--attach` を付けずに `gh pr create` を実行する
2. Test Plan には画像なしで検証内容をテキストで書く。「スクリーンショット添付予定」のような未実行の約束を書かない
3. gh を更新できた後で `gh pr edit <number> --attach <file>` を使って追加する

## 手順

1. 添付候補を列挙し、上の表で「添付する」に該当するものだけ残す（3 枚以内）
2. 各画像に秘密情報が写っていないか確認する
3. `<body-file>` の該当位置に `![<alt>](<ローカルパス>)` を書く。位置指定が不要なら書かない
4. `gh --version` を確認し、2.99.0 以上なら `--attach` を付けて `gh pr create` を実行する
5. PR 画面で画像が body 内に展開されていることを確認する
