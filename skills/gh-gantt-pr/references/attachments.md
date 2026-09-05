# 画像と動画の添付

`gh pr create --attach <file>` で画像や動画を PR body に埋め込む。
gh 2.99.0 以上、GitHub.com と GitHub Enterprise Cloud で使える。
対象は png、jpg、gif、webp、svg、mp4、mov、webm だけで、HTML や PDF は添付できない。

## 使う場面

UI の変更前と変更後、操作の列で見せたい再現手順に使う。
テスト出力やログは検索できるテキストのほうが役に立つので、Test Plan に文字で貼る。
図解を静止画にしない。操作を伴う図は [pr-explainer.md](pr-explainer.md) の説明資料として扱う。

## 書き方

`<body-file>` の置きたい位置に `![説明](./after.png)` と書き、同じパスを `--attach` に渡す。
gh が body 内のパスをアップロード後の URL に置き換える。body に書かなかった添付は末尾に追記される。
alt text は `--attach` の引数側で `<path>#<alt text>` と書く。body 側のパスには `#` を付けない。

```bash
gh pr create --base <base> --head <branch> --title <title> --body-file <body-file> \
  --attach './before.png#変更前' --attach './after.png#変更後'
```

## 守ること

- 3 枚まで。枚数が増えるほど読む負荷は上がる
- 添付前に token やメールアドレスの写り込みを目で確認する。betterleaks（ADR-011）は画像を検査しない
- PR 作成後に足すときは `gh pr edit <number> --attach <file>` を使う
- gh が 2.99.0 未満か GitHub Enterprise Server なら添付せず文字で書く。「添付予定」とは書かない
