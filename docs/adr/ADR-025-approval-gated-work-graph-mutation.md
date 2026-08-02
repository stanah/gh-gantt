---
id: ADR-025
title: approval-gated Work Graph mutation proposal を Run Graph から分離する
date: 2026-08-02
status: accepted
related_requirements:
  - NFR-STABILITY-014
---

## Context

Graph engineering の実行中には、観測結果から Work Graph の分割、追加、統合、依存変更、兄弟優先順の変更、
中止が必要になる。外部 runner が GitHub Issue を直接変更すると、提案時の graph、承認者、影響範囲、途中失敗、
元 Run との lineage を証明できない。逆に Work Graph 変更を Graph Contract patch として扱うと、Plan Graph、
Org Graph、Work Graph、Run Graph の正本境界を壊す。

## Decision

### 公開境界と lifecycle

`MutationProposalControlPlane` の公開入口は `execute(command)` と `inspect(query)` の二つだけとする。
schemaVersion 1 の strict command union は `propose / decide / apply / reconcile / expire / supersede / accept_replan` を受理し、
`commandId` と canonical payload fingerprint の exact retryだけを同じ結果へ収束させる。状態は
`awaiting_human / approved / rejected / expired / superseded / applying / partially_applied / reconciling /
pending_audit / accepting_replan / compensating / applied / compensated` とする。default inspect は bounded summary、frozen plan は明示 `--full` と
上限付き paginationだけで返す。

proposal は caller が指定した diff や risk を信用しない。repository lease 内の current Work Graphから
target、before/after、upstream/downstream impact、risk、ordered primitive step、source revision、task snapshot、
plan fingerprintを導出して凍結する。origin Run ID、canonical workspace ID、task、Graph Contract binding、
checkpoint/authority lineageも固定する。apply直前に全 linked worktreeのtyped Run Graphとrepository-shared claimを
完全列挙し、列挙集合、revision、時刻、nonterminal Run、coverage fingerprintを証明する。欠落、nested/duplicate path、
scan中drift、invalid journal、active claim/attempt、pending authorization、別unfinished Runはfail-closedにする。
mutation対象がnested descendantでも、対象からcanonical originまでの全ancestorをaffected集合へ閉じ、coverage、policy、
claim競合、mutation reservation、Run invalidationの全てで同じ集合を使う。`apply` actorはremote I/O前に
orchestrator authorityをpreflightし、planner/implementer/humanによるapplyはstate unchangedで拒否する。

CLI は次のJSON contractだけを公開し、runner、process、worktree、承認commentを作らない。

```bash
gh-gantt mutation execute --input '<schemaVersion 1 command JSON>'
gh-gantt mutation show <proposal-id> [--full] [--limit <n>] [--offset <n>]
```

### policy と trusted human authority

policyはversioned optional configであり、未設定、未知version、部分一致、評価不能はdefault-denyとして
`awaiting_human`にする。全stepがrepository/root/task type/operation数/affected数/riskの一つのruleに一致するときだけ
policy approvalを生成する。cancelなどdestructive closeは常にhuman-onlyである。

`HumanApprovalAuthority` は `verify(boundDecision, commentRef)` だけを公開する。GitHub commentをdecide時とapply直前に
live取得し、origin repository/Issue、stable comment ID、User author node ID、single canonical machine block、proposal ID、
revision、fingerprint、decision、expiry、purpose、step ID、target Run/project root、successor descriptor fingerprint、
body hash、updated/deleted状態、approval config fingerprintを照合する。
allowed authorはloginではなくstable User node IDで指定する。viewer node IDとauthor node IDが同一ならprincipal separationが
ないため拒否する。token、shared secret、秘密鍵はconfig/proposal/fixture/comment blockへ保存しない。

### primitive、cancel、ordered sub_tasks

split/add/merge/reorder/cancel/dependency intentとdirect CLIのcreate/update/link/hard-deleteは、共通
`WorkGraphCommandEngine.executeCommand`のtyped commandからprojection、affected task、primitive planへlowerする。
Commanderは事後`validateGraph`済み配列を渡さず、このplanを既存sync/push/delete adapterで実行する。永久delete intentはv1で拒否する。cancelはreview/ACを
完了扱いにせずIssueを`CLOSED + NOT_PLANNED`へ変更し、source revisionに結び付くbefore fingerprintと実行可能な
`reopen_cancelled_task` recovery intentを保存する。reopenはproposal revision、step ID、before fingerprintを照合する。
`type_hierarchy`が設定されている場合、create/update/link/proposalの全入口は同じEngine検証を既定で適用し、
許可されない親子型をリモートI/O前に拒否する。例外的な読込境界だけが明示的に検証を無効化できる。

`sub_tasks`は集合ではなくGitHub sub-issue priority順を表す。pull/query順を保ち、hashはsortせず、3-way mergeは両側の
異なる並べ替えをconflictにする。pushはmembership確定後にpriorityを適用する。公式根拠は
[GitHub GraphQL Issues mutations](https://docs.github.com/en/graphql/reference/issues#reprioritizesubissue) の
`reprioritizeSubIssue` と `ReprioritizeSubIssueInput(issueId, subIssueId, beforeId | afterId)` であり、Projects表示行順や
dependency edgeをreorderの代用にしない。

### saga、storage、reconciliation

proposal registryは`<git-common-dir>/gh-gantt/coordination/mutation-proposals/v1/<project-key>`、claim registryは既存の
`<git-common-dir>/gh-gantt/coordination/v1/<project-key>`に置き、Work Graph Cache、workspace-local Run Graph journalとも
root/lock/正本を共有しない。順序はproposal reservation → Work Graph write lease → claim snapshot → proposal finalize →
Run Graph auditとし、長時間lockを重ねない。

remote I/O前にstable step ID、before image、expected postcondition、create correlation tokenをdurableに予約する。
proposal journalへmemory-only preparation fingerprintを先にCASし、その後にだけlocal projectionをflushする。
remote開始前には`side_effect_in_flight`とapplication/mutation fencing tokenをdurable化し、lease失効後の新ownerは
reconcile-onlyとする。mutation reservationの`in_flight`は固定expiryを越えてもdispatchから有効と見なし、remote結果を
proposal journalへ`reconciling`として確定してreconcileした後にだけ通常leaseへ戻す。takeoverはowner/fencing tokenをCAS更新し、旧ownerの
publishを拒否する。旧ownerはremote outcome/local publish前に両fenceを再照合する。compensationも同じ規律に従う。
push executorは各stepの`committed / unknown / reconciled`、remote identifiers、診断をcallbackで返す。create成功後の
draft reification前crash、transport response unknown、relation warningは成功と推測せず`partially_applied`へ止める。
unknown createを自動再送しない。明示reconcileはnon-secret correlation markerまたはrelation/stateのlive postconditionを
照合し、exactly oneだけをreconciled、zeroをnot_started、multiple/取得不能をunknownにする。console warningやsnapshot
rollbackはremote rollbackの証明ではない。
create bodyの照合では、そのstepに予約した一意な末尾correlation markerだけを正規化して除き、それ以外のbody driftを
拒否する。正準なcreate事後条件はreview metadata・acceptance criteria・rolesを直列化したbody、Issue
state/type/assignees/labels/milestone、parent、順序付き`sub_tasks`、集合として正規化した`blocked_by`、Projectの
status/start/end/type/priority/estimate fieldsを含む。correlation検索とpostcondition queryはcursor終端まで取得した
同じlive Issue/Project item表現を検証し、一部欠落・drift・取得不能は`unknown`のままにする。

proposal lifecycleとstepはorigin Runのimmutable audit eventへ追記する。receipt後・audit前のcrashは同じevent IDで
reconcileする。Graph Contract/Org Graph patchはproposal unionに含めず、既存contract binding、run/node/attempt ID、
accepted artifact/evidence lineageを上書きしない。
compensationでsuccessor descriptorを差し替える場合は、対象Runごとに新しいimmutable
`work_graph_invalidated` eventを追記する。`work_graph_replan_accepted`は同じproposalの最新invalidation eventに記録された
descriptorとのexact matchを必須にし、補償前descriptorのreplayを拒否する。

### `work_graph_invalidated` transition

| 条件          | source run                           | current node                               | active Attempt       | 結果                                                                          |
| ------------- | ------------------------------------ | ------------------------------------------ | -------------------- | ----------------------------------------------------------------------------- |
| legal         | pending/running/paused/waiting_human | pending/ready/running/paused/waiting_human | なし、またはterminal | run/nodeをwaiting_humanへ投影。terminal Attempt lineageは保持                 |
| idempotent    | waiting_human                        | waiting_human                              | なし、またはterminal | 同じevent ID/payloadは同じ結果                                                |
| reject        | completed/failed/cancelled           | 任意                                       | 任意                 | eventをappendしない                                                           |
| reject        | 任意                                 | completed/failed/cancelled                 | 任意                 | eventをappendしない                                                           |
| audit pending | legal                                | legal                                      | created/running      | `active_attempt_conflict`。Attempt terminal化後の同event ID reconcileだけ許可 |

### `work_graph_replan_accepted` transition

| 条件                                                                                                | source                 | 結果                                                              |
| --------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| verified human、same Graph Contract binding、successor Plan revision descriptor、active Attemptなし | run/node=waiting_human | run=running、旧node=cancelled、新stable node=ready                |
| reject/descriptor不一致/active Attemptあり                                                          | waiting_human          | 状態維持                                                          |
| Graph Contract変更要求                                                                              | waiting_human          | 既存Runをrebindせず、外部human-authority operationとnew Runを要求 |

## Consequences

- graph変更は承認、origin、coverage、remote side effect、Run auditまで追跡できる。
- GitHubと複数local storeを一つのtransactionにできないため、unknownと明示reconcileは正常なlifecycleになる。
- Graph Contractのtopology/authority変更は別操作・別Runで行い、Work Graph proposalから暗黙変更しない。
