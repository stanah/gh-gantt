---
id: ADR-019
title: loop complete に PR レビューサイクルの evidence ゲートを追加する
date: 2026-07-07
status: accepted
related_requirements:
  - FR-CLI-018
---

## Context

PR #304 で、エージェントが「PR を作成した」ことを「タスクが完了した」と誤認し、
レビューサイクル（CI・レビュー指摘・マージ）が終わっていないのに
`gh-gantt loop complete --outcome completed` で完了報告する事象が発生した。

対策として Claude Code hooks によるリマインド（#307）も検討されているが、
hooks は実行環境（Claude Code）に依存するガードであり、agent 非依存・
project 非依存というハーネス設計方針（ADR-014 / ADR-016）に照らすと補助線に留まる。
ADR-016 / ADR-017 の中核思想は「決定論的な判定は CLI 側に置き、創造的な部分だけを
LLM に残す」であり、「レビューサイクルが完了したか」は GitHub 由来の状態
（PR が MERGED / CLOSED か）から決定論的に判定できる。

一方、ADR-013 と `gh-gantt-workflow` の Red Flag は「PR review 操作を gh-gantt CLI に
追加しない」という責務境界を定めている。PR レビューサイクルの**操作**
（返信・resolve・approve・merge）は GitHub PR の責務であり、`gh` / GraphQL workflow で
扱う。この境界と今回のゲートの関係を整理する必要がある。

## Decision

`gh-gantt loop complete` に PR evidence ゲートを追加する。

### ゲート条件

`--outcome completed` の記録時、開いているイテレーションの選定タスクに
linked PR が存在する場合、GitHub GraphQL API から各 PR の **live 状態**
（OPEN / MERGED / CLOSED）を取得し、次のように判定する。

- **全 PR が MERGED または CLOSED** — 受理。マージ済み PR はレビューサイクル完了の
  最強の証拠であり、PR ごとの評価結果（number / state / reviewDecision /
  未解決スレッド数 / pending checks / checkedAt）を `LoopIteration.prEvidence` として
  ジャーナルに記録する。
- **OPEN の PR が残る** — 非ゼロ終了で拒否。OPEN の PR が残る completed は定義上
  時期尚早である。拒否時は診断情報（reviewDecision / 未解決スレッド数 /
  pending checks）を表示し、次のアクションを案内する。
- **API 到達不能** — 拒否（fail-closed）。判定できない completed を受理しない。

ゲート判定に使うのは state のみで、reviewDecision / 未解決スレッド数 /
pending checks は診断表示と記録のための参考情報である。reviewThreads と checks の
集計は先頭 100 件で打ち切る（判定に使わないため許容する）。

### 意識的なバイパス

`--override-pr-gate <reason>` でゲートをバイパスできる（オフライン作業・hotfix 等）。
override した場合も evidence は記録され、各エントリに `overridden: true` と
`overrideReason` が残る。API 到達不能のまま override した場合は state を
`UNKNOWN` として記録する。バイパスは黙認ではなく、説明責任付きの明示操作である。

### 適用範囲と後方互換

- `--outcome verify_failed / abandoned` には適用しない（完了主張ではないため）。
- 選定タスクに linked PR がなければ適用しない（PR を伴わないタスクは従来どおり）。
- 選定タスクがローカル tasks.json に見つからない場合は、linked PR を列挙できず
  ゲートが黙ってスキップされる fail-open になるため、completed を拒否する
  （fail-closed）。`gh-gantt pull` での同期を案内し、`--override-pr-gate` での
  続行のみ許可する。
- `Config.loop.requirePrEvidence`（既定 `true`）で機能ごと無効化できる。
- ローカルキャッシュ（`linked_prs` の state）は判定に使わない。ローカルからは
  PR 番号の列挙のみ行い、状態は必ず live フェッチで判定する。

### ADR-013 / ADR-016 の責務境界との整合

本ゲートは PR review の**書き込み操作**（返信・resolve・approve・merge）を一切行わない。
行うのは「completed という主張を GitHub 由来の状態で検証する」**読み取り専用の
状態検証**であり、`gh-gantt task close` の close evidence（FR-CLI-016）や
conflicts 検査と同種の、ジャーナル整合性のためのゲートである。したがって
「PR review 操作を CLI に追加しない」（ADR-013、gh-gantt-workflow Red Flag）とは
矛盾しない。レビューサイクルを進める操作は引き続き `gh` / GraphQL workflow
（ADR-013）と skill の責務である。

## Alternatives

### 自己申告 evidence（`--pr-merged` フラグ等）

エージェントの申告をそのまま記録する案。実装は最小だが、今回の事象は
「エージェントが完了と誤認している」ことが原因であり、誤認した主体の自己申告は
ガードにならない。却下。

### hooks によるリマインドのみ（#307）

Claude Code hooks で complete 前に注意を促す案。環境依存であり、ハーネスの中核
ガードを実行環境に置くことは ADR-016 の方針に反する。hooks は本ゲートを補完する
別レイヤーとして扱う（#307 は別タスク）。

### API 到達不能時に警告のみで受理する（fail-open）

オフラインでも complete できて便利だが、ゲートの意義（誤った完了主張の防止）が
「ネットワークを切れば迂回できる」ことで骨抜きになる。fail-closed とし、
オフライン時は `--override-pr-gate` による説明責任付きバイパスに限定する。

### OPEN のままの PR を CI・スレッド・reviewDecision で受理する

Issue #308 の字義（「CI 完了・未解決 review thread 0・CHANGES_REQUESTED なし」を
evidence とする）どおり、OPEN の PR でも上記 3 条件が揃えば completed を受理する案。
しかし OPEN の PR は quiet window の外で新規レビューが届き得るし、そもそも
このプロジェクトの完了定義は「PR がマージされ Closes で Issue が閉じる」である。
OPEN のまま completed を受理することは「PR 作成 = 完了」の誤認を条件付きで
温存することになり、ゲートの目的に反する。判定を state のみに簡約し、
3 条件は診断表示と prEvidence 記録に回す。却下。

### quiet window / stable samples による時系列安定判定

`pr-review-cycle-wait.sh` 相当の「一定期間新規指摘がないこと」まで検証する案。
ゲートは時点スナップショットの state 判定に留める。時系列の安定判定は
レビューサイクル運用（ADR-013）の責務であり、CLI ゲートに持ち込むと
複雑さと実行時間が見合わない。scope 外とする。

## Consequences

- 「PR 作成 = 完了」という誤認は `loop complete` の時点で決定論的に遮断される。
  完了の証拠（prEvidence）がジャーナルに残り、後から検証できる。
- `loop complete --outcome completed` は linked PR があるタスクでネットワークを
  要するようになる。オフライン時は fail-closed となり `--override-pr-gate` が必要。
- `LoopIteration` に `prEvidence`、`Config.loop` に `requirePrEvidence` が追加される
  （どちらも optional で後方互換）。
- GraphQL クライアントは既存の `github/` 基盤（GITHUB_TOKEN / gh auth token）を
  再利用し、`gh` バイナリへの新たな依存は追加しない。
- PR review への書き込み操作は引き続き CLI 外（`gh` / GraphQL workflow / skill）の
  責務であり、ADR-013 の境界は維持される。
