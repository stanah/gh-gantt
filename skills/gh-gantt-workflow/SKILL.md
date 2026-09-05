---
name: gh-gantt-workflow
description: gh-gantt の開発サイクル全体を回すオーケストレーター。「作業を始めたい」「次に何をすべき？」「開発サイクルを回して」で使用。特定の要望のタスク化は gh-gantt-decompose、進捗確認のみは gh-gantt-progress、同期のみは gh-gantt-sync、PR 作成のみは gh-gantt-pr、ロール分離された開発・検証は gh-gantt-dev-role、要件/ADR/テストタグの管理は gh-gantt-living-documentation を使うこと。
---

# gh-gantt 開発ワークフロー

開発サイクル全体をオーケストレーションする。`.gantt-sync/workflow.md` が存在すればプロジェクト固有のコンテキストとして参照する。

## セットアップ

`.gantt-sync/workflow.md` が存在しない場合、`templates/` 配下のいずれかをコピーしてカスタマイズする：

- [templates/workflow.basic.md](templates/workflow.basic.md) — 外部スキル不使用、組み込みの lint/test のみ
- [templates/workflow.superpowers.md](templates/workflow.superpowers.md) — superpowers ツールキット（brainstorming, writing-plans, code-reviewer 等）を使用

注: `gh-gantt init` がワークフローファイルの自動生成に対応している場合はそちらを使用する。

## Project Contract Discovery

`.gantt-sync/workflow.md`にproject-owned Graph Contractセクションや設計文書への参照がある場合は、
task選定とdev-roleへの引き継ぎ前に読み、project固有のbinding、段階境界、roadmapへ従う。
本スキルは特定projectのcontract IDやIssue番号をhard-codeしない。

## ライフサイクルフック

このスキルは以下のフックポイントを定義する。各フックで `.gantt-sync/workflow.md` に対応するセクションが存在すれば、そのアクションを実行する。定義がなければスキップする。

| フック                  | タイミング                | 典型的な用途                                                 |
| ----------------------- | ------------------------- | ------------------------------------------------------------ |
| `on_session_start`      | スキル起動直後（pull 前） | 環境確認、通知                                               |
| `on_task_selected`      | 作業対象タスク決定後      | タスク詳細の深掘り、関連調査                                 |
| `before_design`         | 設計フェーズ開始前        | ブレインストーミング、要件整理                               |
| `before_implementation` | 実装フェーズ開始前        | 計画作成、TDD 準備                                           |
| `before_commit`         | `git commit` 実行前       | 外部レビュー（サブエージェント）、lint、テスト、ユーザー承認 |
| `before_push`           | `git push` 実行前         | 最終検証、diff 確認                                          |
| `before_pr`             | `gh pr create` 実行前     | PR description チェック                                      |
| `after_pr_create`       | `gh pr create` 完了後     | PR 後レビューサイクルの開始                                  |
| `on_review_received`    | レビュー指摘受領時        | 指摘精査、対応方針決定                                       |
| `on_session_end`        | スキル終了時              | sync push、クリーンアップ                                    |

フックの実装例は `templates/workflow.*.md` を参照。

### 設計原則（[Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) 由来）

このスキルおよびテンプレートは以下の原則に基づく：

- **自己評価の禁止**: エージェントは自分の出力を過大評価する傾向がある。レビューは独立したコンテキストを持つサブエージェントまたはユーザーが行う
- **構造化ハンドオフ**: セッション間の状態は `.gantt-sync/workflow.md`, 要件ファイル（Living Documentation 採用時）, ADR, Issue 等の artifact を通じて受け渡す。記憶や推測に頼らない
- **契約ベースの実装**: 実装前に受入基準をユーザーと合意してからコードを書く
- **ハード閾値**: `before_commit` の合格基準は列挙型で、1 つでも落ちたら失敗

<HARD-GATE>
ステップ 1（sync pull）の完了を evidence で確認するまで、ステップ 3 以降に進んではならない。

チェック条件: `gh-gantt status` を実行し出力を確認する。
失敗時: `gh-gantt-sync` スキルを invoke して pull を実行する。
Evidence: コマンド出力をそのまま提示する。
</HARD-GATE>

## デフォルトフロー

各ステップの **★フック** は `.gantt-sync/workflow.md` の対応セクションを実行するタイミング。

0. **★`on_session_start`** — workflow.md の該当セクションを実行。セッション開始確認は
   workflow.md 側に一元化し、ここで同じ確認を重ねて実行してはならない
1. **REQUIRED:** `gh-gantt-sync`（pull）を invoke
2. **OPTIONAL:** `gh-gantt-progress` でタスクの状態を確認
3. タスク確認 — `gh-gantt list --state open --json | node skills/gh-gantt-workflow/scripts/project-task-list-evidence.mjs`
   を実行し、project-local な context budget に収まる bounded evidence を提示する。既定 limit は 50 件で、
   各 task は `id`, `github_issue`, `title`, `status`, `state` だけに射影され、証跡には `total`,
   `limit`, `truncated`, `tasks` を含める。Status field 名が異なる project は `--status-field <name>`、
   context budget を指定する場合は `--limit <n>` を helper に渡す。limit の優先順位は
   `project workflow の指定 > ユーザーの明示指定 > default 50` とする。
   件数が多い場合は CLI でサポートされているフィルタ（例: `--backlog`, `--scheduled`, `--type`, `--sort`）の併用を提案する。
   注: `--unblocked` および `--sort` オプションが利用中の `gh-gantt` のバージョンで利用可能な場合はそれらを使用する。
   利用できない場合（コマンドがエラーになる場合）は、オプションを外した場合も `gh-gantt list --state open --json | node skills/gh-gantt-workflow/scripts/project-task-list-evidence.mjs`
   を使い、JSON projection helper と同じ `--limit <n>` / `--status-field <name>` を維持する。
   `truncated: true` の場合は search/filter で候補を絞り込み、ユーザーに選択を促す。task body は候補を絞り込んだ後に
   `gh-gantt show <id>` で取得する。body を含む全件 export はユーザーが exhaustive audit を明示した場合だけ opt-in で行う。
4. タスクのステータスを作業中に更新 — config に `statuses` が定義されていれば `gh-gantt update <number> --status <作業中ステータス>`（`done: false` のステータスを使用）。未定義ならスキップ
5. **★`on_task_selected`** — workflow.md の該当セクションを実行
6. ブランチ作成 — Issue から branch 名を標準化する場合は `gh-gantt-pr` の命名規則（`<prefix>/issue-<number>-<slug>`）に従う
7. **★`before_design`** → 設計 → **★`before_implementation`** → 実装 & 検証
   - `.gantt-sync/workflow.md` に `## Dev-Role Config` がある場合、開発・検証は `gh-gantt-dev-role role=orchestrator` に引き継ぐ。executor gate を通るまで reviewer / PR 作成へ進んではならない
   - project config が versioned Graph Contract を binding し `run` command を提供する場合、外部 runner は `gh-gantt run start` で Run Graph を開始し、role outcome を `gh-gantt run event` へ渡す。再起動後は `gh-gantt run show` を読み、checkpoint / evidence / side-effect state が明示された paused checkpoint だけを `gh-gantt run resume` で再開する。side-effect state が `unknown` なら停止する
   - `run show` が human gate を示す場合、外部 runner は停止する。human authority の decision evidence または許可 edge への理由付き override なしに次 role を実行しない
   - human gate は専用 `gh-gantt run decide`、PR evidence は GitHub live state を読む `gh-gantt run observe-pr` で扱う。外部 runner の raw `run event` から両者を自己申告しない
   - プロジェクトが Living Documentation 体系を採用している場合（`.gantt-sync/workflow.md` に Living Documentation セクションがある）、振る舞い変更を伴う作業では `gh-gantt-living-documentation` を invoke して要件 AC の追加とテストへの `[ID]` 付与を行う
8. **★`before_commit`** — workflow.md の該当セクションを実行（自己レビュー・lint・テスト等）
9. `git commit`
10. **★`before_push`** — workflow.md の該当セクションを実行
11. `git push`
12. **★`before_pr`** — workflow.md の該当セクションを実行
13. `gh pr create` — PR 作成のみを標準化する場合は `gh-gantt-pr` を使い、PR の description に `Closes #<number>` または `Fixes #<number>` を記載する。スクリーンショット添付、スタック PR、図解 / HTML 説明資料が必要な場合も同スキルの任意拡張（判断表）に従う
14. **★`after_pr_create`** — [PR レビューサイクル](references/pr-review-cycle.md) を開始する。`skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch` で CI と非同期レビューコメントの安定を待つ。PR 作成は完了ではなく、レビュー監視の開始である
15. **★`on_review_received`**（レビュー指摘を受けた場合）— [PR レビューサイクル](references/pr-review-cycle.md) に従い、指摘を精査。妥当な指摘は同じ PR に追加コミットする（Issue 化は不要）。対応後は push し、`skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --current-branch` を再実行する。対応結果は GitHub GraphQL の pending review に集約し、対応済み thread を一括 resolve する
16. 完了報告前 hard gate — 現在タスクの PR を `--pr <number>` または `--current-branch` で確認し、
    `CHANGES_REQUESTED`、未 resolve thread、未観測 check、pending/blocking check、CodeRabbit rate limit、
    API 取得失敗による UNKNOWN 判定がないことを確認する。リポジトリ全体の監査をユーザーが明示した場合だけ、
    `skills/gh-gantt-workflow/scripts/pr-review-cycle-wait.sh --all-open` を opt-in で実行する
17. **★`on_session_end`** — workflow.md の該当セクションを実行
18. **REQUIRED:** `gh-gantt-sync`（push）を invoke。タスクの close は PR マージ時に GitHub が自動で行う

## Bounded dispatch

複数 task を並列実行するときも、gh-gantt は runner ではなく control plane として振る舞う。
次の lifecycle を順番どおり実行する。

1. `gh-gantt pull` で GitHub Projects 由来の Work Graph を更新し、dependency readiness と同期状態を確認する。
2. `gh-gantt run dispatch --workspace-map <path> --gate-snapshot <path>` で Config の global / state / repository 上限内にある ready frontier の dispatch plan をファイルへ保存する。gate snapshot は strict JSON の `schemaVersion` / `sourceRevision` / `observedAt` / review/human IDs を持つ。plan は shared strict schema の `planVersion: "1"`、`planId`、`registryEntityVersion`、`generatedAt`、候補、除外理由、capacity と Work Graph/gate/combined fingerprint を持つ。
3. dispatch plan の各 task に `gh-gantt run claim --plan-file <path> --gate-snapshot <path>` を実行する。claim は Work Graph read lease 内で current Work Graph、loop、sync、current gate snapshot、registry を再計算し、selected task の repository / state / workspace、Run Graph の task binding、plan lineage / version / fingerprint を検証してから、独立した registry CAS で claim receipt を確定する。固定 lock order は Work Graph read lease → claim registry lock とし、Work Graph lease を registry storage に流用しない。
4. 外部 runner が task ごとに別の isolated workspace を用意する。同じ workspace を複数 claim で共有しない。
5. 実行中は lease が失効する前に `gh-gantt run heartbeat` を送り、current owner と fencing version を更新する。
6. completion fencing として、registry lock 内で current claim proof と Run / task / actor lineage を検証し、Run Graph の transition、attempt、artifact、evidence を明示的な副作用なしの domain validation seam で検証する。reject では registry と journal を変更せず、同じ current proof で修正 event を retry できる。dispatch Config が有効なら proof なしの completion/outcome は一律に拒否する。
7. validation 後、event ID / payload fingerprint / current claim lineage と dispatch authorization binding を repository-shared pending authorization として先に永続化する。pending 中の heartbeat / release / 別 event は `authorization_pending` で拒否する。同じ event ID / payload / binding の retry だけが binding 付き Run Graph event を append でき、append 成功後だけ durable receipt が entity version と fencing token を進め、claim を維持したまま更新 proof を返す。sequence 競合では pending を解除して original proof を維持する。
8. pending publish 後・append 前、または append 後・receipt publish 前に中断した場合、exact retry だけを reconciliation する。claim が current なら receipt と更新 proof を回収する。先に expired / owner_stopped reclaim された場合は pending を terminalize し、既存 event だけを historical audit できるが新規 event と継続 proof は受け取れない。receipt publish 後は stored receipt に収束する。
9. task / Run の正常終了または中止時は `gh-gantt run release` で claim を明示解放する。中間 event の認可は release ではない。期限切れ claim の release は `lease_expired` で拒否し、expired reclaim を使う。
10. owner 停止を evidence ID で確認した場合、または lease が失効した場合だけ、別 owner が `gh-gantt run reclaim` を実行する。旧 owner の heartbeat、release、event authorization は stale として拒否される。
11. accepted outcome event、release、reclaim の後は `gh-gantt pull` で GitHub 由来の Work Graph を更新し、`gh-gantt list` で dependency readiness を再評価して fan-in を解く。共有 Work Graph Cache の内部ファイルは直接読み書きしない。全 upstream task が完了した downstream task だけを次の dispatch 対象にする。

claim lifecycle は `claim_acquired` / `claim_heartbeat` / `claim_released` / `claim_reclaimed` / `claim_event_authorized` として
workspace-local の Run Graph audit へ記録する。audit は event ID、fingerprint、entity version、run / task lineage を
repository-shared durable registry receipt と照合し、偽造・stale receipt は `stale_claim` で拒否する。audit event ID は
`audit:${receipt.eventId}` に固定し、同じ registry event の別 ID 追記を拒否する。receipt 確定後、
local audit の追記前に中断した場合は、同じ event ID で command を再実行して reconciliation する。
`gh-gantt run show` は `claimAudits` の total / limit / truncated / bounded items を JSON と人間表示で公開する。

sync conflict、open iteration、review gate、human gate のいずれかがある task は dispatch しない。
Work Graph に存在しない task ID を含む不明な gate snapshot は `gate_snapshot_inconsistent` で frontier 全体を停止する。
claim registry の不整合、Config にない status、plan 生成後に変化した dependency / gate / claim も fail-closed とする。

gh-gantt が提供するのは schema-validated な dispatch plan と event contract だけである。
agent/provider/shell runner を内蔵しないほか、workspace を作成しない。外部 runner が isolated workspace の
作成、process の起動、成果物の生成を担当し、gh-gantt は GitHub task status を暗黙更新しない。

## Approval-gated Work Graph mutation

外部runnerが実行中にWork Graphのsplit/add/merge/reorder/cancel/dependency変更を必要とした場合、
**REQUIRED:** `.gantt-sync/workflow.md`でproject固有contractをdiscoverする。runnerはIssueを直接変更せず、origin Runを
claim released、paused/waiting_human、active Attemptなしのcheckpointへ停止する。

1. `gh-gantt mutation execute --input '<propose JSON>'`でcurrent Work Graph由来のfrozen proposalを作る。
2. policy approvalが成立しなければ、receiptのsingle machine blockを人間がorigin Issueへ投稿する。CLIは投稿しない。
3. commentRefだけを含むdecide JSONを同じexecute入口へ渡す。caller supplied actor/approval本文は渡さない。
4. apply JSONを渡し、complete linked-worktree coverage、claim/Run/source/policy bindingを再検証する。
5. `partially_applied`または`unknown`なら同じremote side effectを自動再送せず、live postcondition evidence付きの
   explicit reconcile JSONを渡す。
6. apply後は`work_graph_invalidated`のhuman gateを維持し、same Graph Contract bindingとverified human decisionを持つ
   successor Planだけを受理する。Graph Contract/Org Graph変更はnew Runを要求する。

状態確認は`gh-gantt mutation show <proposal-id> [--full] [--limit <n>] [--offset <n>]`を使う。
`--full` の `approvalRequests` から decision・compensation・各 Run の replan に対応する
proposal/revision/fingerprint/expiry binding済みcanonical machine blockを取得し、対象Issue commentへ貼る。
default viewはbounded summaryであり、coverage列挙の省略には使わない。cancelは常にhuman-only、
ordered `sub_tasks` reorderはGitHub sub-issue priorityだけを変更する。

## Graph Engineering の採用判断

Graph Engineering は既定ではない。独立 ready frontier、独立 verifier、権限分離、長時間 recovery の
いずれかが必要で、同一受入基準の paired trial が追加 overhead を正当化する場合だけ opt-in する。
計測、導入、停止、復旧、public-safe evidence は
[references/graph-engineering.md](references/graph-engineering.md) に従う。

metric または recovery evidence が不足する場合は single-loop へ縮退する。benchmark の runner 初期値と
Graph Contract / repository Config の contract ceiling を混同せず、human gate を性能結果から解除しない。

## 自律ループモード

人間との対話なしで複数タスクを連続処理する場合（Claude Code の /loop 等）は、
タスク選定・停止判定・実績記録を `gh-gantt loop` コマンドに委ねる。
1 イテレーションの手順と停止条件は [references/autonomous-loop.md](references/autonomous-loop.md) を参照。

- 選定は `gh-gantt loop next` — デフォルトフローのステップ 3（一覧表示 → ユーザー選択）を
  置き換え、作業粒度の ready を Next Actions スコア順で決定論的に選定する。
  作業中ステータスへの更新（ステップ 4）は従来どおり `gh-gantt update <number> --status <作業中ステータス>` で行う
- 実績記録と完了時の status 更新は `gh-gantt loop complete --task-status <status>`
- 現在地の確認は `gh-gantt loop status`（直近イテレーション・停止条件・スリップ・次候補）

## Red Flags

| やりがちなこと                                                 | 問題                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| pull せずに作業開始                                            | 古いデータで作業、コンフリクトリスク                             |
| タスク選択をスキップ                                           | Issue と紐づかない                                               |
| コミット後にタスク更新を忘れる                                 | GitHub と乖離                                                    |
| エージェントがタスクを勝手に絞り込む                           | ユーザーが見るべきタスクが隠される                               |
| レビュー指摘を Issue 化する                                    | レビュー修正は同じ PR に追加コミットするだけ                     |
| Bot レビューを全て鵜呑みにする                                 | 誤検知や文脈に合わない指摘がある。精査してから対応する           |
| PR 作成で作業完了扱いする                                      | PR 後の非同期レビューサイクルが始まっている                      |
| `Dev-Role Config` があるのに executor gate を省略する          | ロール分離が無効化され、動作確認なし PR 作成を再発させる         |
| PR review 操作を gh-gantt CLI に追加する                       | GitHub PR の責務であり、`gh` / GraphQL workflow で扱う           |
| `.claude/hooks` をレビューサイクルの正本にする                 | Codex など hook を自動実行できない環境では保証にならない         |
| 明示要求なしに全 open PR を監査する                            | 現在タスクから scope drift し、context budget を圧迫する         |
| レビュー返信を個別投稿する                                     | pending review にまとめて submit し、通知を 1 回に抑える         |
| PR マージ前に手動で Issue を close する                        | `Closes #N` で自動クローズに任せる                               |
| 振る舞い変更なのに要件ファイルを更新しない (Living Doc 採用時) | トレーサビリティが欠ける。`gh-gantt-living-documentation` を使う |
| テスト追加後に Reconciliation を忘れる (Living Doc 採用時)     | CI で要件ファイルの diff エラーになる                            |

| 言い訳                                | 現実                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| 「さっき pull したばかり」            | status の出力を確認すること。記憶は evidence ではない |
| 「小さい変更だからタスク不要」        | 追跡されない変更はプロジェクトの盲点になる            |
| 「後で push する」                    | 後では来ない。コミットと push はセットで行う          |
| 「全件なら見落とさない」              | bounded evidence と段階的な detail 取得で対象を絞る   |
| 「レビュー指摘だから Issue にしよう」 | Issue は新しい作業単位。レビュー修正は既存 PR の一部  |

## リファレンス

- コマンド詳細: [references/commands.md](references/commands.md)
- Graph Engineering: [references/graph-engineering.md](references/graph-engineering.md)
