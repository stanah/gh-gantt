---
id: ADR-024
title: ready frontier の claim coordination と Run Graph audit を分離する
date: 2026-08-02
status: accepted
related_requirements:
  - NFR-STABILITY-014
---

## Context

ADR-021 は Plan Graph、Work Graph、Org Graph、Run Graph の正本を分離し、ADR-022 は fixed dev-role
Run Graph の accepted event journal を workspace-local に置いた。ADR-023 は GitHub Projects 由来の
Work Graph Cache だけを git-common-dir 配下へ共有し、その repository lease と snapshot-set を
`withProjectStorage` に閉じ込めた。

複数 worktree から dependency 解決済み task を並列 dispatch するには、同じ task または workspace の
二重 dispatch を防ぐ repository-shared coordination が必要である。一方、Work Graph Cache の長時間 lease を
claim の heartbeat に使うと pull / push / status を阻害し、Run Graph journal 全体を共有すると #328 までの
workspace-local な accepted lineage を暗黙に移動してしまう。さらに lease 失効後に旧 runner が完了 outcome を
返せるなら、reclaim した新 owner の結果を stale owner が上書きできる。

## Decision

### ready frontier は Work Graph から純粋に導出する

ready frontier と dispatch plan は GitHub Projects 由来の Work Graph、明示的な現在時刻、Config、gate snapshot、
claim snapshot から純粋に導出する。未完了 dependency、親コンテナ、sync conflict、open iteration、review gate、
human gate、active claim を持つ task は除外し、候補と除外理由を stable ID と安定順で返す。不明な status、
不整合な claim snapshot は fail-closed とする。gate snapshot に Work Graph 上に存在しない task ID が一つでも
あれば `gate_snapshot_inconsistent` として frontier 全体を停止し、部分的な候補を返さない。

gate snapshot は `schemaVersion`、外部正本の `sourceRevision`、`observedAt`、review/human gate task ID を持つ
strict JSON file とし、dispatch/claim の双方で `--gate-snapshot <path>` を必須にする。gh-gantt は外部 gate の
正本を発明せず、canonical fingerprint と source revision を lineage として照合する。

dispatch plan は shared の単一 strict schema で `planVersion: "1"`、stable な `planId`、`registryEntityVersion`、
`generatedAt`、候補、除外理由、capacity と、sync conflict、open iteration、review gate、human gate、task ごとの
workspace、Work Graph/gate/combined snapshot fingerprint を含む再検証可能な context を返す。この plan lineage は候補を
表示するだけの advisory output ではなく、後続 claim の authorization input とする。

Config は global 上限を必須とし、任意の state 上限と repository 上限を追加する。active lease を各使用数へ数え、
三つの残 slot の交差だけを dispatch plan に含める。同じ task と isolated workspace は同時に一つの active claim
だけを持てる。

### claim registry だけを repository-shared にする

claim registry は次の独立した versioned namespace に置く。

```text
<git-common-dir>/gh-gantt/coordination/v1/<project-key>/
```

registry は claim、heartbeat、release、reclaim、event authorization を expected entity version、opaque claim ID、
fencing token、event ID、owner identity、workspace ID、run ID、取得時刻、失効時刻とともに compare-and-set する。
同じ event ID と payload の再実行は同じ receipt に収束し、payload mismatch、stale version、期限前 reclaim、
active claim と競合する task / workspace は state unchanged で拒否する。
期限前に停止 owner を reclaim する場合は、停止を確認した evidence ID を receipt と audit に残す。
期限切れ claim の release は ownership を解放したことにせず、`lease_expired` で拒否して expired reclaim の
理由を保持する。

claim は `run dispatch` が返した strict plan file と current gate snapshot file を必須入力とする。claim は
Work Graph read lease を保持した callback 内で current Work Graph、loop、sync、gate snapshot、claim registry を
読み直して dispatch plan を再計算し、選択 task の repository / state / workspace、Run Graph の
task binding、`planId` / `planVersion` / `registryEntityVersion` を一致検証する。plan 生成後に dependency や gate、
claim、status が変化した場合と、直接指定された blocked / unknown task は registry mutation 前に fail-closed で
拒否する。固定 lock order は claim 時だけ Work Graph read lease → 独立した claim registry lock とし、registry CAS
直前にも combined snapshot fingerprint を再照合する。Work Graph lease を registry storage として流用しない。

coordination namespace は claim 専用の短時間 filesystem lease と atomic publish を所有する。dead owner recovery は
観測した owner nonce に bind した `recovery-claim.json` を exclusive create し、owner/recovery nonce の再照合後だけ
active lock directory を atomic retire する。別 process が回復後に取得した live lock を古い観測で削除しない。
completion の critical
section では current proof 検証、workspace-local Run Graph の domain validation / append、registry publish だけを行い、
GitHub I/O、runner、worktree 操作、長時間 task を実行しない。lock order は registry lock から Run Graph journal lock の
順に固定し、heartbeat / release / reclaim は Run Graph lock を取得しない。
completion の lock order は registry lock → Run Graph journal lock とする。ADR-023 の Work Graph Cache lease、
snapshot-set、workspace-local fallback は claim registry の lease/storage として流用しない。

### pending authorization を先に永続化し、Run Graph event と receipt を確定する

claim proof 付き `attempt_finished` / `node_outcome_submitted` は、registry lock 内で current proof と Run / task / actor
lineage を検証してから、Run Graph の transition、active attempt、artifact、evidence を明示的な副作用なしの seam で
検証する。domain reject では repository registry と Run Graph journal のどちらも変更せず、caller は同じ current
proof を使って修正 event を retry できる。暗黙の async-local preparation state は使用しない。

validation 成功後、event ID、payload fingerprint、claim lineage と、claim ID、旧 fencing token、owner / run / task、
command fingerprint の `dispatchAuthorization` binding を repository-shared registry の pending authorization として
先に永続化する。pending 中の heartbeat、release、別 event authorization は `authorization_pending` で fail-closed に
する。同一 event ID / payload / binding の exact retry だけが処理を再開できる。その後 binding 付き event を
workspace-local Run Graph へ append し、append 成功後だけ registry
の entity version と fencing token を進め、operation-discriminated receipt を publish する。task / Run claim 自体は
維持し、receipt は更新 proof を public JSON result に含めるため、同じ claim で
`attempt_finished`、`node_outcome_submitted`、次 node の event を順次認可できるようにする。task / Run の終端または
中止で owner が `run release` を明示実行したときだけ claim を解放する。

両 store を一つの atomic filesystem transaction にはしない。crash が pending publish 後・Run Graph append 前なら
pending だけが残り、exact retry が append を再開する。append 後・receipt publish 前なら pending と immutable binding
付き event が残る。claim が current の間の exact retry はその event を検証して receipt と更新 proof を publish する。
先に expired/owner_stopped reclaim された場合は pending を terminalize し、旧 owner は同じ binding を持つ既存 event
だけを historical reconciliation/audit できるが、新規 event の append と claim 継続用 proof は受け取れない。
registry publish 後の retry は stored
receipt に収束する。続けて `claim_acquired`、`claim_heartbeat`、`claim_released`、`claim_reclaimed`、
`claim_event_authorized` の audit event を追記し、receipt 後・audit 前の停止は同じ event ID で reconciliation する。

validation と append の間に別 event が入り sequence が競合した場合、prepared event と registry receipt は受理せず、
pending を atomic に解除して original proof と active claim を維持する。caller は current Run Graph view に対する修正
event を同じ proof で送る。
authorization commit と heartbeat / reclaim は同じ registry lock の勝者だけを受理する。

`recordClaimAudit` の event ID は内部規則 `audit:${receipt.eventId}` に固定する。同じ receipt/registry event を別の
audit event ID で再追記できない。schema-valid な入力だけでは受理せず、fingerprint、entity version、run / task
lineage を repository-shared registry の durable receipt と照合する。照合できない偽造・stale receipt は
`stale_claim` として state unchanged で拒否する。`RunGraphView.claimAudits` と `run show` は audit の total、
limit、truncated、bounded items を公開し、operator が claim / release / reclaim / event authorization の理由と lineage を
無制限 journal dump なしで確認できるようにする。

Run Graph の fixed dev-role node / edge / current node は変更しない。claim audit は owner / workspace / run / task
lineage と fencing proof を追加する versioned extension であり、既存 accepted segment、terminal attempt、stable ID、
event lineage を上書きしない。Run Graph journal は workspace-local のままとし、repository 共有へ移動しない。

heartbeat と release は current claim ID と fencing version の一致を要求する。event authorization は current claim
proof、Run / task / actor lineage、command fingerprint を registry transaction 内で検証するたびに version と token を
進め、claim を維持した更新 proof を返す。これにより event authorization と heartbeat / reclaim の勝者を一意にする。
lease 失効後の reclaim で fencing version を進め、旧 owner の heartbeat、release、event authorization を
state unchanged で拒否する。

dispatch Config が有効な repository では、raw `applyEvent` による `attempt_finished` / `node_outcome_submitted` を
Run 単位の過去 read に依存せず一律に拒否する。proof 付き commit だけを許可するため、raw guard と claim 取得の
check-then-append race は存在しない。

### gh-gantt は control plane に限定する

公開 CLI は `run dispatch`、`run claim --plan-file <path>`、`run heartbeat`、`run release`、`run reclaim` と、claim
proof 付き `run event` の schema-validated JSON contract を提供する。gh-gantt は agent/provider/shell runner、
workspace / worktree 作成、process 起動を内蔵せず、GitHub task status を暗黙更新しない。外部 runner が claim
receipt に対応する isolated workspace を用意し、実行と outcome 提出を担当する。

completion、release、reclaim の後は GitHub Projects 由来の Work Graph Cache を読み直して dependency readiness を
再評価する。全 upstream task が完了した downstream task だけを次の frontier に入れる。この fan-in のために
fixed dev-role Graph Contract を fork / join DAG に変更しない。

approval-gated proposal と Work Graph mutation、新しい plan version は Issue #331 の責務とする。本決定だけでは、
bounded parallelism と approval-gated mutation の両方を要求する `NFR-STABILITY-014-AC8` を covered にしない。

## Alternatives

### Run Graph journal 全体を repository-shared にする

一つの journal で claim と実行履歴を監査できるが、ADR-022/023 の workspace-local 正本を暗黙に変更し、
multi-writer compare-and-append、migration、compaction の境界まで同時に広げるため採用しない。共有するのは
短命な claim coordination に必要な registry だけとする。

### Work Graph Cache の repository lease を claim に流用する

既存 lock を再利用できるが、heartbeat や task 実行が pull / push / status と競合し、長時間保持または頻繁な
lock contention を生む。異なる正本と critical section を同じ lease に束ねるため採用しない。

### GitHub Issue status を claim として使う

遠隔の可視性は得られるが、status update は task state と実行 ownership を混同し、offline race、workspace 排他、
短い heartbeat、fencing token を表せない。GitHub Projects は Work Graph の正本に維持する。

### 外部 runner に排他と上限管理を委ねる

gh-gantt の実装は小さくなるが、runner ごとに gate、capacity、lease、stale completion の意味が分岐し、複数
worktree の二重 dispatch を control plane で検証できないため採用しない。

## Consequences

- 同一 repository の linked worktree は同じ claim registry を観測し、task と workspace の二重 dispatch を防げる。
- Work Graph Cache、claim registry、Run Graph journal は別 namespace、別 lease、別正本を維持する。
- Run Graph event と registry receipt / local audit の間には一時的不一致が起こり得るため、immutable authorization
  binding と event ID による reconciliation が必須になる。
- event authorization receipt は Run Graph append 後だけ claim を維持したまま version と token を進めるため、複数
  event と heartbeat / reclaim の勝者は registry 上で一意になり、append conflict は original proof を消費しない。
- clock skew の影響を完全には除けないため、期限だけでなく単調な fencing version を completion まで検証する。
- operator-visible audit は bounded view のため全履歴 export ではなく、必要な lineage を上限付きで観測する。
- runner は isolated workspace の作成と process lifecycle を実装する必要があるが、provider 固有機能は gh-gantt に入らない。
- fan-in は Work Graph の再評価で解決し、fixed dev-role Run Graph の topology と既存 event lineage を維持する。
- network filesystem の分散 lock、無制限 concurrency、orphan generation compaction、#331 の Work Graph mutation は対象外とする。
