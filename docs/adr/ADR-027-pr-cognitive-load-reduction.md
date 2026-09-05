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
  artifact URL からブラウザで直接表示できるようになった（単一ファイル限定、ログイン必須、最長 90 日保持）
- show-me / eli5 のような図解 skill が、単一 HTML や Mermaid で「最小の view」を選ぶ手法として普及した

同時に、既存の責務境界を崩さないことが要件である。ADR-013 は PR review 操作を製品 CLI に追加しない、
ADR-014 は品質ゲートを `gh-gantt-dev-role` に置き `gh-gantt-pr` は PR 作成だけを担う、
ADR-019 は `loop complete` を linked PR の live state で gate する、と定めている。

## Decision

PR 認知負荷軽減の 3 手段を、`gh-gantt-pr` skill の **任意拡張**（reference）として定義する。
既定の最小フロー（branch 名 / body / `gh pr create --body-file`）は変更しない。
gh-gantt 製品 CLI には PR 作成・添付・スタック操作のコマンドを追加しない（ADR-013 の境界を維持）。

### 1. 添付（`references/attachments.md`）

- gh 2.99.0 以上で `--attach` を使い、UI の before / after と図解 PNG を PR body に埋め込む
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
  HTML は Mermaid で表せないときだけ作る
- HTML は **git 管理外**（Dev-Role Config の `scratchpadDir/<issue>/pr-explainer/`、
  なければ `.gantt-sync/pr-explainer/<issue>/`）に生成し、commit しない
- 既定の配布経路（経路 A）は `skills/gh-gantt-pr/scripts/render-pr-explainer.mjs` で PNG 化して `--attach` する。
  script は実行 project の `playwright` / `@playwright/test` を解決し、`PLAYWRIGHT_CHROMIUM_EXECUTABLE` で
  browser を差し替えられる
- CI artifact の直接表示（経路 B）は project opt-in とし、**リポジトリ内容から決定論的に生成できる資料**に限定する。
  agent が手元で書いた HTML を git 管理外のまま CI run へ渡す経路がない（`workflow_dispatch` input は 64KB 上限）ため、
  経路 B を agent 作成資料の既定にしない。workflow 構成例は reference に置き、skill としては配布しない

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

### CI artifact を説明資料の既定経路にする

zip なしで HTML を直接開ける点は魅力だが、単一ファイル限定・ログイン必須・90 日保持・run 単位 URL・
run 内生成必須という制約が重い。agent が手元で書いた図を渡せないため既定にはせず、
決定論的に生成できる資料の project opt-in に限定する。既存の #301（CI で派生成果物を生成する）と
統合して検討する。

### 添付やスタックを常時必須にする

すべての PR に画像や分割を要求すると、小さな修正で手間だけが増え、認知負荷は逆に上がる。
「使う場面」のゲートを持つ任意手順とする。

## Consequences

- `gh-gantt-pr` の SKILL.md は最小フローを維持したまま、任意拡張 3 件への導線と判断表を持つ
- `skills/gh-gantt-pr/scripts/render-pr-explainer.mjs` が skill 付属 script として追加される。
  実行には project 側に `playwright` または `@playwright/test` と Chromium が必要
- スタック PR を使う場合、branch 名規則が `/<k>-<layer-slug>` 付きに変わり、Issue link の配置が層で異なる。
  ADR-019 のゲートは最上層の PR を linked PR として見る
- 経路 B（CI artifact）の workflow 実装は本 ADR の範囲外であり、必要になった project が #301 と合わせて判断する
- gh 2.99.0 未満、GHES、stacked PR 未有効のリポジトリでは各拡張は fallback に従い、最小フローだけで完了できる
- 3 手段の使用頻度と効果は実運用で観測し、必要なら追補で手順を補正する。
  想定するフォローアップ: 経路 B の workflow 実装（#301 と統合）、`gh stack submit` の実挙動に基づく手順の補正、
  PR body テンプレートへの Stack セクションの組み込み
