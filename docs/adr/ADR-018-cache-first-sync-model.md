---
id: ADR-018
title: キャッシュファースト同期モデルへの移行 (ADR-003/005 の改訂)
date: 2026-07-07
status: accepted
related_requirements:
  - FR-SYNC-002
  - FR-SYNC-003
  - FR-STORE-001
  - FR-STORE-002
  - FR-STORE-003
---

## Context

ローカル (`.gantt-sync/`) と リモート (GitHub) の乖離によるコンフリクトが頻発している。
worktree・エフェメラル環境など複製が増えるほど悪化する構造で、コンフリクト量は
おおよそ「複製の数 × 複製が同期されずに生きる時間」に比例する。

ADR-003 (git ライクな pull/push/conflict モデル) と ADR-005 (ローカルファーストの
データ管理) は、`.gantt-sync/` にローカルデータを永続化し、明示的な pull → 作業 →
push サイクルをユーザーに要求する設計を採用した。この設計は「セッション間で
コンテキストを失わない」という目的には適うが、副作用として複製の寿命を長くする
方向に働く — pull を忘れる、まとめて後で push する、という運用が長時間の乖離を
常態化させる。

一方で実装を調査した結果、双方向同期対象のフィールドの大部分はすでに GitHub 側に
保存済みであることが分かった。

- title / body / state → Issue 本体
- state_reason / assignees / labels / milestone → Issue のネイティブフィールド
- created_at / updated_at / closed_at → Issue の read-only メタデータ
- acceptance_criteria / acceptance_criteria_slot / roles / review 情報 → Issue
  body 内のマーカーブロック
- start_date / end_date / custom_fields (priority, estimate_hours) →
  ProjectV2 フィールド
- type → Organization Issue Type → ProjectV2 単一選択フィールド → GitHub
  Label の優先順で解決する 3 層のハイブリッド（ProjectV2 単独ではない）
- parent / sub_tasks → ネイティブ sub-issue リレーション
- blocked_by → ネイティブ blocked-by リレーション

ただし精査の結果、以下の既知のギャップも見つかった。

- **`status`（ProjectV2 の Status フィールド）は現状 pull 専用の一方向。**
  `push-executor.ts` の `updateProjectItemField` 呼び出し（8 箇所）は
  start_date / end_date / type / priority / estimate_hours のみを対象とし、
  Status フィールドへの書き込みは一つも存在しない。ローカルで
  `gh-gantt update --status` を行っても GitHub の Status には反映されず、
  「破棄可能なキャッシュ」という本 ADR の前提が現状ではこのフィールドに
  限り成立しない。既存のバグであり、本 ADR の移行スコープとは切り離して
  #303 で追跡する（Consequences 参照）。
- **`date` フィールドも milestone 合成タスクに限り pull-only の一方向。**
  `diff.ts` / `push-executor.ts` はいずれも `isMilestoneSyntheticTask` で
  既存 milestone タスクを push 対象から完全に除外しており、`date` を変更して
  push しても GitHub には反映されない。draft 作成時に一度だけ `dueOn` へ
  一方向送信されるのみで、以降は pull で `dueOn` を読み込むだけの関係であり、
  「双方向同期」ではない。`status`（#303）と同種のギャップだが、こちらは
  `date` フィールド整理タスク（#298）の対象範囲に元々含まれているため、
  新規 Issue は起票せず #298 に委ねる。
- **既存 Issue の `assignees` / `labels` / `milestone` の変更も push されない。**
  `updateIssue` は title / body のみを送信し、labelIds / milestoneId /
  assigneeIds は draft → Issue 作成経路でのみ使用される。既存 Issue への
  ローカル変更は push されず、次の pull でリモート値に巻き戻される。#305 で
  追跡する。
- **`start_date` / `end_date` のクリア（null 化）も push されない。**
  日付フィールドの送信は truthy 判定でガードされており、ProjectV2 フィールドを
  クリアする経路が存在しない。ローカルで消した日付が GitHub に残り続ける。
  #306 で追跡する。
- `linked_prs`（FR-STORE-003 が定義する保存形式）とコメントキャッシュは
  実装済みの read-only キャッシュだが、`reactions` キャッシュは取得コードが
  存在せず常に空オブジェクトのまま初期化される未実装のプレースホルダである。

未 push の draft タスク (`#draft-N`) も含め、ローカルにしか存在しない実データは
`date`（milestone 以外の通常タスク）と draft タスクに限られる。つまり
`tasks.json` / `sync-state.json` は構造上すでにキャッシュに近く、上記の
pull-only ギャップ群（`status` は #303、既存 Issue メタデータは #305、
日付クリアは #306、milestone `date` は #298）を埋めれば「唯一のデータ」
として扱う必要がなくなる。これらのギャップが解消されるまでは、該当フィールドのローカル変更は
push で GitHub に届かないため、キャッシュ破棄の前提は成立しない（＝ギャップ
解消は本 ADR の移行の前提条件である）。

## Decision

GitHub を唯一の真実源 (single source of truth) とし、`.gantt-sync/` 配下の
ファイルを以下の 3 区分で再定義する。

| 区分                   | 対象                                             | 性質                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 再構築可能キャッシュ   | `tasks.json`, `sync-state.json`, `comments.json` | いつ破棄しても `gh-gantt pull` で GitHub から完全再構築できる write-through キャッシュ                                                                                                                                                                                    |
| ローカル観測ジャーナル | `loop-state.json`                                | 外側ループの実行履歴（ADR-016/017）。**pull では再構築されない**。破棄するとイテレーション履歴・予実データは失われるが、`gh-gantt loop next` は GitHub 由来の状態だけで継続できる（ADR-017 の設計どおり）。「破棄可能」だが「再構築可能」ではない点でキャッシュと区別する |
| コミット対象の設定     | `gantt.config.json`, `workflow.md`               | git 管理する共有設定。キャッシュではない                                                                                                                                                                                                                                  |

本 ADR で「同期データ」「キャッシュ」と言うときは 1 行目の再構築可能
キャッシュのみを指す。

**ADR-003 の「明示的な pull → 作業 → push サイクルを常態とする」という運用前提、
および ADR-005 の「`.gantt-sync/` への永続化 = セッションを跨ぐ唯一の参照先」
という位置づけは、本 ADR により以下のとおり改訂される。** 両 ADR の骨子
（ADR-003: 3-way merge によるコンフリクト検出、CLI 経由の明示操作。ADR-005:
`.gantt-sync/` へのローカル永続化によるオフライン参照）自体は維持し、supersede
はしない。改訂するのは「ローカル状態を長時間保持してよい」という運用前提のみ
であり、以下の 5 点を実装方針とする。

### 1. 同期データは git 管理しない

`tasks.json` / `sync-state.json` の git コミットは、git 履歴という第三の複製系を
追加し「複製の数」「複製の寿命」の両方を悪化させる。per-task ファイル分割による
コミットも含めて採用しない。git コミット対象は `gantt.config.json` と
`workflow.md`、および CI が生成する派生成果物 (任意) に限定する。

### 2. 複製の寿命を積極的に短縮する

読み取り系コマンド (list / status / loop next 等) の stale チェック + auto-pull、
変更系コマンド (update / close / link 等) の write-through push (即時 push) を
既定動作にする。「pull → まとめて作業 → 後で push」という長時間ローカル変更を
前提とした運用から、変更が数秒〜数十秒で GitHub に反映される運用へ転換する。

### 3. 複製の数を積極的に減らす

同期データの置き場を `git rev-parse --git-common-dir` 起点に解決し、同一マシン上
の全 worktree が単一のキャッシュを共有する。worktree ごとの pull が不要になる。

共有化に伴い、**書き込み排他（ファイルロック等による単一 writer 保証）を必須
要件とする**。現状の書き込みは原子的な置き換えのみでロックがなく、複数
worktree からの並行 pull / push は後勝ちで同期結果を上書きしうる。排他制御の
設計・実装は #299 のスコープに含める。

### 4. ローカル専用データを排除する

draft タスクは既定で即座に GitHub Issue化する (オフライン時のみ `--draft` で
オプトイン)。ローカル専用の `date` フィールドは ProjectV2 フィールドへの同期
対象化、または廃止のいずれかで解消する。これによりキャッシュ破棄で失われる
データを無くす。

### 5. コンフリクト解決を宣言的にする

フィールド単位の解決ポリシー (例: `state` はローカル優先、`start_date` は
リモート優先) を設定で宣言し、`gh-gantt resolve --auto` で機械的に適用できる
ようにする。真の同時編集だけが人間・エージェントの判断に残る。

## Alternatives

### tasks.json / sync-state.json を git コミットする

346KB 規模の単一 JSON に対する行ベース merge は PR ごとの衝突を実質的に保証する。
また GitHub 側の状態は刻々と変化するため、コミットした snapshot はマージした
瞬間から陳腐化する。`sync-state.json` は（Decision 3 の git-common-dir 化を
実施する前の現状において）per-workspace の merge base (3-way merge の base
snapshot・hash) であり、複数ワークスペース間で共有すること自体に意味がない。
Decision 3 の実装後は同一マシン上の全 worktree が単一のキャッシュファイルを
共有するようになるが、それは「単一の実体を複数ワークスペースが参照する」
のであって、「git 履歴という別の複製系にコミットして共有する」こととは
異なる。複製系を増やしコンフリクト量の 2 因子を悪化させるため git コミットは
不採用。

### tasks.json を per-task ファイルに分割してコミットする

行ベース merge の衝突確率は下がるが、「git 履歴 vs GitHub API」という二重権威
問題と `sync-state.json` の共有不能性は解消しない。根治にならないため不採用。

### CRDT / 操作ログ方式の導入

理論的には洗練されているが、直列化ポイントは結局 GitHub API であり、
write-through push (Decision 2) で同期窓を短縮すれば得られる利益はほぼ同等。
実装・運用の複雑さに見合わないため不採用。

### .gantt-sync/ を git submodule 化する

二重権威問題は解消せず、submodule 特有の運用複雑さ (detached HEAD、
サブモジュール更新忘れ等) が新たに加わるだけのため不採用。

## Consequences

- ADR-003 の「明示的な pull → 作業 → push サイクル」は、読み取り系の
  auto-pull と変更系の write-through push により「意識しなくても同期される」
  運用へ移行する。ユーザーが明示的に操作する自由 (`pull --force`,
  `push --dry-run` 等) は維持する。
- ADR-005 の「`.gantt-sync/` にローカルデータを永続化する」は維持するが、
  永続化の意味が「唯一のデータ」から「破棄可能なキャッシュ」へ変わる。
- `gantt.config.json` / `workflow.md` の git コミットが必要になる (#295)。
- 本 ADR の decision に従い、以下の実装タスクが必要になる: stale チェック +
  auto-pull (#296)、write-through push (#297)、draft 即時実体化と `date`
  フィールド整理 (#298)、git-common-dir 化によるワークツリー間共有 (#299)、
  宣言的コンフリクトポリシーと `resolve --auto` (#300)。
- CI による派生成果物生成 (#301, 任意) は「リポジトリ内で人間が状況を可視化
  したい」というニーズへの代替手段であり、単一書き込み者 (CI) に限定することで
  PR 間コンフリクトを構造的に排除する。
- 既存の 3-way merge・コンフリクトマーカー・resolve コマンド (ADR-001) の
  仕組みはそのまま活用する。変わるのはコンフリクトが「生じる頻度」であり、
  検出・解決の仕組み自体ではない。
- レビュー時の fact-check により、push が一部フィールドを GitHub に反映しない
  既存バグ群（pull-only の一方向ギャップ）が判明した: ProjectV2 Status（#303）、
  既存 Issue の assignees / labels / milestone（#305）、日付フィールドの
  クリア（#306）。いずれも本 ADR 自体（方針の記録）のスコープ外の独立した
  不具合として追跡するが、**「キャッシュはいつ破棄してもよい」という運用を
  宣言する前提条件**であり、#297（write-through push）・#298（date 整理）の
  完了までに解消されている必要がある。未解決のまま運用を切り替えると、
  該当フィールドのローカル変更だけがキャッシュ破棄で消失し続ける。
