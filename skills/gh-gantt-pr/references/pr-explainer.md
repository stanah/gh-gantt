# PR 説明資料（図解 / インタラクティブ HTML）

PR body のテキストでは伝わりにくい「構造の変化」を、レビュアーが差分を読む前に渡す手順。
gh-gantt-pr の任意拡張であり、作らなくても既定の最小フローは成立する。

認知負荷を下げるのは情報を増やすことではなく、読む順番と全体像を先に渡すことである。
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

| 形式                     | 使う場面                                                                | 置き場所                                    |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------------------- |
| 1 行要約（eli5 流）      | 常に。`Summary` の先頭に、前提知識のない読者向けの 1 文を置く           | PR body                                     |
| Mermaid                  | 呼び出し順、状態遷移、データフロー、依存関係                            | PR body に直接（GitHub がレンダリングする） |
| ファイルツリー / diff 形 | どのファイルが何を担うか、既存構造がどう変わるか                        | PR body のコードブロック                    |
| 単一 HTML                | クリックで切り替える before / after、段階的に開く構造図、密度の高い概念 | git 管理外に生成し、artifact として公開     |

Mermaid は PR body に書けるため、追加の公開手順が要らない。
HTML は、クリックや段階表示といった操作がなければ伝わらないときだけ作る。操作を伴わない図は Mermaid か PR body の図で足りる。

## HTML の規約

- 単一ファイル。CSS / JS はインライン、外部 CDN / Web font / 外部画像を参照しない。
  artifact の直接表示は単一ファイルだけを配信するため、外部参照は描画されない
- 幅 1280px で読める前提でレイアウトし、文字は 14px 以上
- 実データを使う。実際のファイル名、コマンド、型名、Issue 番号を書き、ダミーラベルを置かない
- 日本語で書く（プロジェクトの言語規約）
- 1 ファイルに 1 つの主張。スライド形式にするなら 3 枚以内
- 60,000 文字以内に収めると既定の輸送路（dispatch）で送れる。超える場合は fallback（branch）を使う

### 出力先（git 管理外）

HTML はコミットしない。次の順で出力先を決める。

1. `.gantt-sync/workflow.md` に `## Dev-Role Config` があれば `<scratchpadDir>/<issue-number>/pr-explainer/`
2. なければ `.gantt-sync/pr-explainer/<issue-number>/`

いずれも gitignore 済み（`.dev-flow/`、`.gantt-sync/*`）。`.gantt-sync/` 配下でも Work Graph Cache や
journal（`tasks.json`、`sync-state.json`、`loop-state.json` 等）には触れない。
commit 前に `git status --short` で HTML が untracked のまま残っていないことを確認する。

### PR 本文とコメントに HTML を書かない

HTML の本文を PR body やコメントに貼らない。折り畳み（`<details>`）に入れても同じである。
エージェントは `gh pr view` やレビューサイクルで PR のテキストを読むため、HTML が含まれていると
コンテキストウィンドウを圧迫する。PR に残すのは workflow が書く**リンク 1 行のコメント**だけにする。

## 公開の仕組み

HTML は GitHub Actions の artifact として公開する。`actions/upload-artifact@v7` の `archive: false` で
単一ファイルを zip なしで upload すると、artifact URL をブラウザで開いたときに HTML がそのまま描画され、
インライン JavaScript も実行される（2026-09-05 に実機で確認）。

artifact は workflow run の中からしか upload できないため、エージェントの手元の HTML を workflow run へ渡す
輸送路が必要になる。project は [templates/pr-explainer.yml](../templates/pr-explainer.yml) を
`.github/workflows/pr-explainer.yml` として配置し、エージェントは `workflow_dispatch` で起動する。

| 輸送路             | 使う場面                    | 仕組み                                                                                                                                       |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| dispatch（既定）   | HTML が 60,000 文字以内     | `gh workflow run pr-explainer.yml -F pr=<n> -F title=<t> -F html=@<file>`。git に触れない                                                    |
| branch（fallback） | HTML が 60,000 文字を超える | HTML だけの孤立コミットを一時 branch `pr-explainer/<n>-<時刻>` に push し、`-F source_branch=` で渡す。workflow が公開後に branch を削除する |

どちらの場合も workflow は次を行う。

1. HTML の単一ファイル契約（HTML 文書であること、外部参照がないこと）を検証する
2. `archive: false`、保持 90 日で artifact として upload する
3. 対象 PR に `<!-- pr-explainer -->` を目印とする sticky comment を作成または更新し、タイトルと artifact リンク、失効日を書く
4. branch 経由なら一時 branch を削除する

### 制約

| 制約         | 内容                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| 閲覧条件     | artifact URL はリポジトリに read 権限を持つログイン済みユーザーだけが開ける                                 |
| 保持期間     | 最長 90 日で失効する。原本はエージェントの手元にあるので、同じコマンドで再公開できる                        |
| 導線         | artifact は run 概要の Artifacts 欄に並ばない。PR コメントのリンクが唯一の導線になる                        |
| 起動権限     | `workflow_dispatch` を起動できるのはリポジトリへ write 権限を持つユーザーだけである                         |
| 有効化の時期 | workflow は既定 branch に存在して初めて起動できる。導入 PR 自身では使えない                                 |
| 実行環境の差 | branch fallback は `refs/heads/` への push だけを使う。branch 以外の ref への push は環境によって拒否される |

## 手順

1. 「作る場面」に該当するか判断する。該当しなければ `Summary` に 1 行要約だけ書いて終える
2. Mermaid で表せるなら PR body に Mermaid を書き、HTML は作らない
3. project に `.github/workflows/pr-explainer.yml` があるか確認する。なければ HTML は作らず、Mermaid とテキストに留める
4. HTML が必要なら、出力先ディレクトリに単一 HTML を書く（外部参照なし、実データ、日本語）
5. `node skills/gh-gantt-pr/scripts/pr-explainer-publish.mjs <file> --pr <number> --title <title>` で契約を検証し、
   選ばれた輸送路とコマンドを確認する。`--run` を付けると `gh` / `git` を実行して公開まで行う
6. PR に sticky comment のリンクが書かれたことを確認する。PR body には資料の存在だけを 1 行で書き、HTML は貼らない
7. `git status --short` で HTML が commit 対象に入っていないことを確認する

## Red Flags

| やりがちなこと                            | 問題                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| HTML を PR body やコメントに貼る          | エージェントが PR を読むたびにコンテキストを圧迫する。リンク 1 行にする |
| 説明資料の HTML を `docs/` に commit する | PR ごとの一時資料が正本に混ざる。決定は ADR / Issue / PR body に残す    |
| HTML を PNG に変換して添付する            | クリック操作が失われ、資料の意味がなくなる                              |
| 図を複数枚用意して全部説明する            | 認知負荷が上がる。1 PR に 1 つの主張                                    |
| Mermaid で書けるものを HTML にする        | 公開手順が増え、更新しづらくなる                                        |
| 外部 CDN や Web font を HTML から参照する | artifact の直接表示で描画されない                                       |
| artifact URL を PR body に固定で書く      | 再公開で URL が変わり、90 日で消える。sticky comment に任せる           |
