---
id: ADR-027
title: PR の認知負荷軽減を gh-gantt-pr skill の任意拡張として扱う
date: 2026-09-05
status: accepted
related_requirements:
  - NFR-STABILITY-008
---

## Context

`gh-gantt-pr` skill（ADR-014、NFR-STABILITY-008）は Issue から branch 名と PR body を標準化し、
`gh pr create --body-file` を実行するまでの最小フローを定義している。一方、AI agent が作る PR は
差分が大きくなりがちで、レビュアーは「何が・なぜ・どう変わったか」を差分から再構成する必要があった。
PR の認知負荷を下げる手段が skill に定義されていないため、agent ごと・セッションごとに
PR の説明品質が揺れる。

2026 年に GitHub 側の前提が変わった。

- gh CLI 2.99.0 で `gh pr create` / `gh pr edit` / `gh pr comment` に repeatable な `--attach` が追加され、
  画像・動画を CLI から PR body に埋め込めるようになった（GitHub.com / GHEC のみ、画像・動画限定）
- Stacked pull requests が 2026-07-30 に public preview になり、`gh extension install github/gh-stack` で
  1 Issue を複数の小さな PR に分割・連結し、下層から順に merge できるようになった
- `actions/upload-artifact@v7` の `archive: false` で、単一 HTML を zip なしで upload し、
  artifact URL からブラウザで直接表示できるようになった（単一ファイル限定、ログイン必須、最長 90 日保持）。
  2026-09-05 に本リポジトリで検証し、直接表示でインライン JavaScript が実行されることを確認した
- show-me / eli5 のような図解 skill が、単一 HTML や Mermaid で「最小の view」を選ぶ手法として普及した

説明資料には二つの制約がある。
クリックや段階表示を伴うインタラクティブな HTML でなければ図解の価値が出ないこと、
そして PR body やコメントに HTML の本文を置くと、エージェントが `gh pr view` やレビューサイクルで
PR を読むたびにコンテキストウィンドウを圧迫することである。
したがって HTML は PR のテキストの外に置き、PR にはリンクだけを残す必要がある。

同時に、既存の責務境界を崩さないことが要件である。ADR-013 は PR review 操作を製品 CLI に追加しない、
ADR-014 は品質ゲートを `gh-gantt-dev-role` に置き `gh-gantt-pr` は PR 作成だけを担う、
ADR-019 は `loop complete` を linked PR の live state で gate する、と定めている。

## Decision

PR 認知負荷軽減の 3 手段を、`gh-gantt-pr` skill の **任意拡張**（reference）として定義する。
既定の最小フロー（branch 名 / body / `gh pr create --body-file`）は変更しない。
gh-gantt 製品 CLI には PR 作成・添付・スタック操作のコマンドを追加しない（ADR-013 の境界を維持）。

### 1. 添付（`references/attachments.md`）

- gh 2.99.0 以上で `--attach` を使い、UI の before / after の画像や動画を PR body に埋め込む
- 画像・動画限定、3 枚以内、alt text で「見てほしい点」を書く、秘密情報の写り込みを目視確認する
  （betterleaks は画像を検査しない。ADR-011）
- gh が古い場合は添付を諦めてテキストで書き、後から `gh pr edit --attach` で追加する。
  「添付予定」のような未実行の約束を Test Plan に書かない

### 2. スタック PR（`references/stacked-pr.md`）

- 分割基準は「1 PR = 1 レビュー観点」かつ「各 layer が単独で CI green」。目安を表で定義する
- 全 layer の branch 名は `<prefix>/issue-<number>-<slug>/<k>-<layer-slug>` とし、
  単一 branch 名と混在させない（git の ref 名衝突を避ける）
- Issue link は最上層だけ `Closes` / `Fixes`、他の layer は `Part of`。
  途中の merge で Issue が閉じると task 状態が早期に Done になり、ADR-019 の PR evidence ゲートが
  残りの layer を見なくなるため
- `gh stack` 未導入時は `gh pr create --base <lower-branch>` による手動スタックを fallback とする
- レビューサイクル（ADR-013）は layer ごとに回し、merge 判断は本 skill の範囲外とする

### 3. 説明資料（`references/pr-explainer.md`）

- 形式は軽い順に選ぶ: 1 行要約 → Mermaid（PR body に直接） → ファイルツリー / diff 形 → 単一 HTML。
  HTML はクリックや段階表示が必要なときだけ作る
- HTML は **git 管理外**（Dev-Role Config の `scratchpadDir/<issue>/pr-explainer/`、
  なければ `.gantt-sync/pr-explainer/<issue>/`）に生成し、commit しない
- HTML は Actions artifact（`archive: false`、保持 90 日）として公開し、PR には sticky comment で
  **リンク 1 行だけ**を残す。HTML の本文は PR body にもコメントにも書かない
- artifact は workflow run の中からしか upload できないため、skill は `templates/pr-explainer.yml` を配布し、
  project が `.github/workflows/pr-explainer.yml` として配置する。エージェントは `workflow_dispatch` で起動する
- 輸送路は二つとし、`skills/gh-gantt-pr/scripts/pr-explainer-publish.mjs` が HTML の単一ファイル契約を検証したうえで選ぶ。
  既定は `gh workflow run -F html=@<file>` で本文を input として渡す dispatch（input 総量 65,535 文字の内側で
  HTML は 60,000 文字まで）。超える場合は HTML だけの孤立コミットを一時 branch `pr-explainer/<n>-<時刻>` に push し、
  `source_branch` input で渡す。workflow は公開後にその branch を削除する
- workflow がない project では HTML を作らず、Mermaid とテキストに留める

### 責務境界

- 品質ゲート（ビルド / テスト / lint）、レビュー監視、merge 判断は引き続き `gh-gantt-dev-role` と
  `gh-gantt-workflow` の責務であり、`gh-gantt-pr` は扱わない（NFR-STABILITY-008-AC3）
- 3 手段はいずれも「使う場面」のゲートを持つ任意手順であり、常時適用を要求しない

## Alternatives

### gh-gantt CLI に `pr` サブコマンドを追加する

`gh pr create --attach` や `gh stack` の薄い wrapper を製品 CLI に置く案。ADR-013 と同じ理由で却下する。
正本は GitHub PR であり、`gh` が十分な API 面を持つ。製品 CLI の責務が PR workflow automation へ拡散する。

### 説明資料の HTML を `docs/` に commit する

PR を開けば必ず読める利点はあるが、PR ごとの一時資料がリポジトリの正本に混ざる。
Living Documentation（ADR-012）の方針では決定は ADR / Issue / PR body に集約し、
brainstorming 由来の spec / plan は tracked にしない。同じ理由で却下する。
クリック操作を伴う資料が必要な例外は、project が ADR を伴って個別に判断する。

### 説明資料の HTML を PNG に変換して `--attach` する

`gh pr create --attach` が画像だけを受け付けるため、HTML を Playwright で撮影して添付する案。
クリックや段階表示が失われ、HTML で作る意味そのものが消える。却下する。
操作を伴わない静的な図は、最初から Mermaid か画像として作ればよい。

### HTML の本文を PR コメントに埋め込み、workflow が取り出して artifact 化する

輸送路を GitHub の中で閉じられ、branch も増えない案。しかし PR のテキストに HTML が残るため、
エージェントが PR を読むたびにコンテキストウィンドウを圧迫する。折り畳んでも同じである。却下する。

### branch 以外の隠し ref、Gist、外部ホスティングを輸送路にする

隠し ref（`refs/pr-explainer/<n>`）は branch 一覧を汚さないが、Claude Code on the web の git 経路では
`refs/heads/` 以外への push が拒否されることを確認した。Gist は資料が別の場所に残り、URL を知れば誰でも読める。
Cloudflare Pages / Netlify / Vercel 等の外部ホスティングは URL が安定し失効もないが、外部アカウントとトークンを
エージェント環境に置き、資料が GitHub の外へ出る。いずれも既定にせず、`refs/heads/` への push と `workflow_dispatch`
だけで成立する経路を選ぶ。

### CI が差分から決定論的に説明資料を生成する

agent の手元の HTML を運ばずに済むが、agent が伝えたい観点を CI が推測することになる。
変更ファイルツリーや差分統計のような機械生成資料は、既存の #301（CI で派生成果物を生成する）で別に扱う。

### 添付やスタックを常時必須にする

すべての PR に画像や分割を要求すると、小さな修正で手間だけが増え、認知負荷は逆に上がる。
「使う場面」のゲートを持つ任意手順とする。

## Consequences

- `gh-gantt-pr` の SKILL.md は最小フローを維持したまま、任意拡張 3 件への導線と判断表を持つ
- `skills/gh-gantt-pr/templates/pr-explainer.yml`（workflow）と `scripts/pr-explainer-publish.mjs`（検証と起動）が
  skill 付属として追加される。本リポジトリは同じ workflow を `.github/workflows/pr-explainer.yml` に配置し、
  テストで両者の一致を検証する。workflow は既定 branch に merge されて初めて起動できる
- workflow は `pull-requests: write` で PR コメントを書き、一時 branch の削除だけを `contents: write` の別 job に隔離する。
  `workflow_dispatch` を起動できるのは write 権限を持つユーザーに限られる
- artifact の閲覧にはリポジトリの read 権限とログインが必要で、最長 90 日で失効する。
  原本はエージェントの手元に残るため、同じコマンドで再公開できる
- スタック PR を使う場合、branch 名規則が `/<k>-<layer-slug>` 付きに変わり、Issue link の配置が層で異なる。
  ADR-019 のゲートは最上層の PR を linked PR として見る
- gh 2.99.0 未満、GHES、stacked PR 未有効、workflow 未配置のリポジトリでは各拡張は fallback に従い、
  最小フローだけで完了できる
- 3 手段の使用頻度と効果は実運用で観測し、必要なら追補で手順を補正する。
  想定するフォローアップ: 説明資料 workflow の初回実運用（merge 後）、`gh stack submit` の実挙動に基づく手順の補正、
  PR body テンプレートへの Stack セクションの組み込み
