# PR 説明資料（図解 / HTML）

PR body のテキストでは伝わりにくい「構造の変化」を、レビュアーが差分を読む前に 1 枚で渡す手順。
gh-gantt-pr の任意拡張であり、作らなくても既定の最小フローは成立する。

認知負荷を下げるのは情報を増やすことではなく、**読む順番と全体像を先に渡す**ことである。
資料は 1 PR に 1 つ、伝えたい点を 1 つに絞る。

## 作る場面（ゲート）

以下のいずれかに該当する場合だけ作る。該当しなければ PR body の `Summary` で足りる。

| 作る                                                                     | 作らない                       |
| ------------------------------------------------------------------------ | ------------------------------ |
| 変更が複数パッケージ / 複数モジュールにまたがる（目安: 10 ファイル以上） | 1〜数ファイルの bug fix        |
| 状態遷移、データフロー、責務境界が変わる（ADR を伴う変更）               | 文言・設定値・依存更新         |
| 新しい概念や命名を導入する                                               | 既存パターンの踏襲で差分が自明 |
| UI のレイアウトや導線が変わる                                            | 差分そのものを見れば分かる変更 |

## 形式の選び方

軽い形式から順に検討し、最初に足りる形式で止める（show-me スキルの「最小の view を選ぶ」原則）。

| 形式                     | 使う場面                                                           | 置き場所                                    |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------- |
| 1 行要約（eli5 流）      | 常に。`Summary` の先頭に、前提知識のない読者向けの 1 文を置く      | PR body                                     |
| Mermaid                  | 呼び出し順、状態遷移、データフロー、依存関係                       | PR body に直接（GitHub がレンダリングする） |
| ファイルツリー / diff 形 | どのファイルが何を担うか、既存構造がどう変わるか                   | PR body のコードブロック                    |
| 単一 HTML                | Mermaid で表せない before / after 比較、レイアウト、密度の高い概念 | git 管理外に生成 → PNG 化して添付           |

Mermaid は PR body に書けるため、追加の添付も CI も要らない。**HTML は Mermaid で表せないときだけ**作る。

## HTML の規約

- **単一ファイル**。CSS / JS はインライン、外部 CDN・Web font・外部画像を参照しない
  （PNG 化でも、後述の CI artifact 直接表示でも、外部参照は描画されないか遅延する）
- 幅 1280px で読める前提でレイアウトし、文字は 14px 以上
- 実データを使う。実際のファイル名、コマンド、型名、Issue 番号を書き、ダミーラベルを置かない
- 日本語で書く（プロジェクトの言語規約）
- 1 ファイルに 1 つの主張。スライド形式にするなら 3 枚以内

### 出力先（git 管理外）

HTML と PNG は **コミットしない**。次の順で出力先を決める。

1. `.gantt-sync/workflow.md` に `## Dev-Role Config` があれば `<scratchpadDir>/<issue-number>/pr-explainer/`
2. なければ `.gantt-sync/pr-explainer/<issue-number>/`

いずれも gitignore 済み（`.dev-flow/`、`.gantt-sync/*`）。`.gantt-sync/` 配下でも Work Graph Cache や
journal（`tasks.json`、`sync-state.json`、`loop-state.json` 等）には触れない。
commit 前に `git status --short` で HTML / PNG が untracked のまま残っていないことを確認する。

## 経路 A（既定）: PNG 化して `--attach`

`gh pr create --attach` は画像・動画しか受け付けないため、HTML を PNG にレンダリングして添付する。

```bash
node skills/gh-gantt-pr/scripts/render-pr-explainer.mjs \
  .gantt-sync/pr-explainer/<issue-number>/overview.html \
  .gantt-sync/pr-explainer/<issue-number>/overview.png
```

- スクリプトは実行 project の `playwright` または `@playwright/test` を使う。
  Chromium がない場合は `npx playwright install chromium`、または `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で実行ファイルを指定する
- `--width <px>`（既定 1280）と `--scale <n>`（既定 2）で解像度を調整する
- 生成した PNG は [attachments.md](attachments.md) の手順で PR body に配置する。
  `Summary` の直下に置き、alt text に「この図で見てほしい点」を書く

利点: PR を開いた瞬間に見える、添付は GitHub 側に永続化される、閲覧に追加権限が要らない。
欠点: 静的画像になる（クリック操作は失われる）、更新は `gh pr edit --attach` で差し替える。

## 経路 B（project opt-in）: CI artifact を直接開く

`actions/upload-artifact@v7` の `archive: false` で単一 HTML を zip なしで upload すると、
artifact URL をブラウザで開いたときに HTML がそのまま表示される。

制約を理解したうえで、**リポジトリ内容から決定論的に生成できる資料**にだけ使う。

| 制約            | 内容                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 単一ファイル    | `archive: false` は 1 ファイルだけ upload できる。CSS / JS / 画像はインライン化が必須                                                                                       |
| ログイン必須    | artifact URL はリポジトリに read 権限を持つログイン済みユーザーだけが開ける                                                                                                 |
| 保持期間        | 既定 90 日（`retention-days` で 1〜90）。PR の記録としては残らない                                                                                                          |
| URL が run 単位 | `https://github.com/<owner>/<repo>/actions/runs/<run-id>/artifacts/<artifact-id>`。push ごとに変わる                                                                        |
| 生成場所        | HTML は workflow run の中で生成される必要がある。エージェントが手元で書いた HTML を git 管理外のまま CI へ渡す経路はない（`workflow_dispatch` の input は 64KB 上限で不適） |
| 権限            | PR に URL を貼るには workflow に `pull-requests: write` が必要                                                                                                              |

したがって経路 B は「エージェントが書いた説明図」ではなく、CI が差分から機械生成する資料
（変更ファイルツリー、パッケージ別の差分統計、依存グラフ、Mermaid ガント等）に向く。
project が採用する場合の最小構成は次のとおり（本スキルはこの workflow を配布しない。project 側で追加する）。

```yaml
# .github/workflows/pr-explainer.yml（構成例）
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  explainer:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
        with:
          fetch-depth: 0
      - run: <差分から単一 HTML を生成するコマンド> > pr-explainer.html
      - id: upload
        uses: actions/upload-artifact@<pinned-sha> # v7 以上
        with:
          name: pr-explainer
          path: pr-explainer.html
          archive: false
          retention-days: 30
      - uses: actions/github-script@<pinned-sha>
        with:
          script: |
            // 既存の説明資料コメントを探して更新し、なければ 1 件だけ作る（sticky comment）
            const marker = "<!-- pr-explainer -->";
            const url = "${{ steps.upload.outputs.artifact-url }}";
            const body = `${marker}\n📎 PR 説明資料（run 単位、要ログイン）: ${url}`;
            const { data: comments } = await github.rest.issues.listComments({
              ...context.repo, issue_number: context.issue.number, per_page: 100,
            });
            const existing = comments.find((c) => c.body?.startsWith(marker));
            if (existing) {
              await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
            } else {
              await github.rest.issues.createComment({ ...context.repo, issue_number: context.issue.number, body });
            }
```

## 手順

1. 上の「作る場面」に該当するか判断する。該当しなければ `Summary` に 1 行要約だけ書いて終える
2. Mermaid で表せるなら PR body に Mermaid を書き、HTML は作らない
3. HTML が必要なら、出力先ディレクトリに単一 HTML を書く（外部参照なし、実データ、日本語）
4. `render-pr-explainer.mjs` で PNG 化し、[attachments.md](attachments.md) に従って `Summary` 直下に配置する
5. `git status --short` で HTML / PNG が commit 対象に入っていないことを確認する
6. 経路 B を使う project では、CI が生成した資料へのリンクが sticky comment で更新されることを確認する

## Red Flags

| やりがちなこと                             | 問題                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| 説明資料の HTML を `docs/` に commit する  | PR ごとの一時資料が正本に混ざる。決定は ADR / Issue / PR body に残す |
| 図を複数枚添付して全部説明する             | 認知負荷が上がる。1 PR に 1 つの主張                                 |
| Mermaid で書けるものを HTML にする         | PNG 化と添付の手間が増え、更新しづらくなる                           |
| 外部 CDN や Web font を HTML から参照する  | PNG 化や artifact 直接表示で描画されない                             |
| CI artifact の URL を PR body に固定で書く | push ごとに URL が変わり、90 日で消える。sticky comment で更新する   |
