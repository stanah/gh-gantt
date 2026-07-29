---
id: ADR-021
title: Graph Contract と Run Graph の責務境界を定義する
date: 2026-07-30
status: accepted
related_requirements:
  - NFR-STABILITY-014
---

## Context

gh-gantt は GitHub Issues / Projects 由来の仕事構造、repository-owned workflow、dev-role artifact、
外側loopの実績を持つ。しかし、計画、仕事、権限、実行履歴の正本と、固定workflowの実行を追う
ID・遷移・証拠は単一契約になっていない。task status と run status、retry と review improvement、
外部runnerと製品の責務を分けなければ、durable実行履歴や並列化を安全に追加できない。

一次資料に明記された事実として、[OpenAI Symphonyの固定commit版仕様](https://github.com/openai/symphony/blob/f8e8b8a670c799f6e0ade7a8c25c4bf4a4a56ec7/SPEC.md)は
orchestratorの単一authority、明示的state machine、reconciliation、workspaceとagent subprocessの
execution層を定義する。一方、scheduler stateはin-memoryで、restart時に正確なstateを永続storeから
復元する仕様ではない。[Anthropic公式記事](https://www.anthropic.com/engineering/building-effective-agents)は
事前定義workflowと動的agentを区別し、単純な構成から必要な場合だけ複雑化するよう勧める。

gh-gantt固有の推論として、計画・仕事・権限・実績を別graphに分け、version、authority、evidence、
budget、human gateで結ぶ設計規律をGraph Engineeringと呼ぶ。参照資料はこの名称を定義していないため、
Graph Engineeringを確立済みの外部標準として扱わない。

## Decision

### 正準4 graphと正本

| graph      | authoritative definition        | canonical artifact / store        | current #327                                                  | after #328            |
| ---------- | ------------------------------- | --------------------------------- | ------------------------------------------------------------- | --------------------- |
| Plan Graph | Graph Contract topology         | versioned plan artifact           | ADR-021 + workflowのunversioned provisional projection        | Graph Contract store  |
| Org Graph  | Graph Contract role / authority | versioned authority binding       | ADR-021 + Dev-Role Configのunversioned provisional projection | Graph Contract store  |
| Work Graph | GitHub Issues / Projects        | GitHub remote task / relation     | GitHub remoteが正本、.gantt-syncはcache                       | 変更なし              |
| Run Graph  | accepted run event              | append-only Run Graph event store | 正準storeなし、.dev-flow artifactはevidence                   | Run Graph event store |

Graph ContractはPlan GraphのtopologyとOrg Graphのrole / authorityを定義し、Work Graphの対象を参照する。
versioned contract導入後、repository-owned workflowはcontract ID/versionの選択、repository固有config、
verify commandを設定する。
Run Graph eventはWork Graphを暗黙に変更しない。

### version bindingと競合規則

- 現行#327にはplan_id、plan_version、authority bindingの値がない。ADR-021とrepository-owned workflowは
  unversioned provisional projectionであり、versioned Graph Contract実装済みの証拠にはしない。
- 現行は外部orchestratorがworkflow、JSON Schema、manual gateの整合を確認するが、ID/versionのexact bindingや
  fail-closed validationを実行したとは扱わない。
- exact bindingとfail-closed validationは#328以後に導入する。Graph Contractは`plan_id`、`plan_version`、
  `schema_version`、versioned authority bindingを持ち、workflowは`plan_id`と`plan_version`をexact bindingする。
  workflowはGraph Contractを再定義しない。
- #328以後の優先順位は、Work Graph dataはGitHub remote、Plan/Org topologyはbindingされたGraph Contract、
  actual executionはaccepted Run Graph eventの順にそれぞれのscope内で正本とする。
- workflowの散文やrole referenceがbindingされたcontractと競合した場合、推測で一方を選ばず
  fail-closedで`waiting_human`へ送る。missing、unsupported、ambiguous versionも同じ扱いにする。
- #328以後は製品control planeがbindingされたcontractを検証してeventを受理する。machine schemaと
  ADRの説明が競合する場合はeventをfail-closedで拒否し、schema/ADR reconciliationを人間へ要求する。

### Graph Contractの最小表現

versioned Graph Contractは次を表現する。

- `role`: Org Graph actor classとauthority binding
- `node`: stable node ID、role、input/output artifact contract、node lifecycle
- `edge`: stable edge ID、source、target、transition condition
- `artifact`: artifact ID、schema、producer attempt、content hashまたはbounded reference
- `evidence`: evidence ID、producer、attempt、provenance、bounded reference
- `authority`: transitionの要求、承認、限定overrideを許可された主体
- `budget`: verify retry、review improvement、将来のtime/cost/concurrencyの独立上限
- `human gate`: approval requirement、待機理由、decision evidence
- `schema version`: reader compatibilityとmigration rule

artifactはrole間のデータ契約、evidenceは判断根拠であり、両方にprovenanceを持たせる。本文全体を
複製せずcontent hashまたはbounded referenceを使う。`run ID`、`node ID`、`attempt ID`、
`artifact ID`、`evidence ID`は安定opaque IDとし、task、plan version、producer attemptのlineageを保つ。

### 正準状態集合

tracker task stateはGitHub/project configの外部stateであり、次のRun Graph stateへ混在させない。

| entity  | states                                                                       | terminal                                         |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| run     | pending, running, paused, waiting_human, completed, failed, cancelled        | completed, failed, cancelled                     |
| node    | pending, ready, running, paused, waiting_human, completed, failed, cancelled | completed, failed, cancelled                     |
| attempt | created, running, succeeded, failed, timed_out, stalled, cancelled           | succeeded, failed, timed_out, stalled, cancelled |

### 正準transition

`terminal or checkpoint`が`checkpoint`の行だけ同じrun内でresume/migrateできる。terminal stateからは
新しいrunまたはnode/attemptを作らない限り再開しない。不正eventはrefusal列どおりstateを変えず、
reject evidenceを残す。`same state`はsourceの個別stateを保つ意味である。

#### Run transition

| source                                     | event or guard                                       | target            | terminal or checkpoint | refusal                    |
| ------------------------------------------ | ---------------------------------------------------- | ----------------- | ---------------------- | -------------------------- |
| run.pending                                | start + exact version/target valid                   | run.running       | no                     | reject; keep pending       |
| run.running                                | pause + checkpoint persisted                         | run.paused        | checkpoint             | reject; keep running       |
| run.paused                                 | resume + checkpoint/artifact/evidence valid          | run.running       | no                     | reject; keep paused        |
| run.running                                | human_gate_required or budget_exceeded               | run.waiting_human | checkpoint             | reject; keep running       |
| run.waiting_human                          | human_approved + authority/decision evidence valid   | run.running       | no                     | reject; keep waiting_human |
| run.running                                | complete + required nodes/gates complete             | run.completed     | terminal               | reject; keep running       |
| run.running                                | fail + non-retryable                                 | run.failed        | terminal               | reject; keep running       |
| run.{pending,running,paused,waiting_human} | cancel + authority evidence valid                    | run.cancelled     | terminal               | reject; keep source        |
| run.{paused,waiting_human}                 | migrate + supported version/migration evidence valid | same state        | checkpoint             | reject; keep source        |
| run.{completed,failed,cancelled}           | stale_event                                          | same state        | terminal               | reject; keep source        |

#### Node transition

| source                                            | event or guard                                     | target             | terminal or checkpoint | refusal                    |
| ------------------------------------------------- | -------------------------------------------------- | ------------------ | ---------------------- | -------------------------- |
| node.pending                                      | dependencies_satisfied                             | node.ready         | no                     | reject; keep pending       |
| node.ready                                        | attempt_started + authority valid                  | node.running       | no                     | reject; keep ready         |
| node.running                                      | pause + checkpoint persisted                       | node.paused        | checkpoint             | reject; keep running       |
| node.paused                                       | resume + checkpoint/artifact/evidence valid        | node.running       | no                     | reject; keep paused        |
| node.running                                      | human_gate_required or budget_exceeded             | node.waiting_human | checkpoint             | reject; keep running       |
| node.waiting_human                                | human_approved + authority/decision evidence valid | node.running       | no                     | reject; keep waiting_human |
| node.running                                      | attempt_succeeded + schema-valid node outcome      | node.completed     | terminal               | reject; keep running       |
| node.running                                      | non-retryable node outcome                         | node.failed        | terminal               | reject; keep running       |
| node.{pending,ready,running,paused,waiting_human} | cancel + authority evidence valid                  | node.cancelled     | terminal               | reject; keep source        |
| node.{completed,failed,cancelled}                 | stale_event                                        | same state         | terminal               | reject; keep source        |

#### Attempt transition

| source                                                 | event or guard                    | target            | terminal or checkpoint | refusal              |
| ------------------------------------------------------ | --------------------------------- | ----------------- | ---------------------- | -------------------- |
| attempt.created                                        | start + current attempt ID        | attempt.running   | no                     | reject; keep created |
| attempt.running                                        | succeed + evidence valid          | attempt.succeeded | terminal               | reject; keep running |
| attempt.running                                        | fail + failure evidence valid     | attempt.failed    | terminal               | reject; keep running |
| attempt.running                                        | timeout                           | attempt.timed_out | terminal               | reject; keep running |
| attempt.running                                        | stall                             | attempt.stalled   | terminal               | reject; keep running |
| attempt.running                                        | cancel + authority evidence valid | attempt.cancelled | terminal               | reject; keep running |
| attempt.{succeeded,failed,timed_out,stalled,cancelled} | stale_event                       | same state        | terminal               | reject; keep source  |

### Cross-entity propagation

attemptはexecution mechanicsであり、attemptのterminal eventだけではnode outcomeにならない。
control planeはattempt eventとschema-valid node outcomeを別々に検証し、次の表だけで親entityへ伝播する。

| source                             | event or guard                                                      | target                              | run effect                       | identity / lineage                 |
| ---------------------------------- | ------------------------------------------------------------------- | ----------------------------------- | -------------------------------- | ---------------------------------- |
| attempt.succeeded                  | schema-valid node outcome                                           | node.completed + evaluate Plan edge | run.running                      | terminal attempt preserved         |
| attempt.{failed,timed_out,stalled} | retryable + attempt_count < attempt budget                          | node.ready                          | run.running                      | new monotonic attempt ID + lineage |
| attempt.{failed,timed_out,stalled} | retryable + attempt_count >= attempt budget                         | node.waiting_human                  | run.waiting_human checkpoint     | terminal attempt preserved         |
| attempt.{failed,timed_out,stalled} | non-retryable                                                       | node.failed                         | run.failed terminal              | terminal attempt preserved         |
| executor role node                 | schema-valid verify_failed outcome + retry budget available         | new implementer Run node ID         | run.running + evaluate Plan edge | source node remains completed      |
| reviewer role node                 | schema-valid request-changes outcome + improvement budget available | new implementer Run node ID         | run.running + evaluate Plan edge | source node remains completed      |

retryableなfailed、timed_out、stalledでは、終端attemptを変更せずnodeをreadyへ戻すと同時に、同じnodeの
単調増加する新attempt IDとlineageを作る。attempt budgetを使い切ったretryable failureはnodeとrunを
`waiting_human` checkpointへ送り、non-retryable failureだけがnodeとrunを`failed` terminalへ送る。

### Fixed dev-role transition

このtableは最初のPlan Graphを定義する。`waiting_human`は停止handoffであり、外部runnerが必須human gateを
bypassできない。限定bypassはcontractが許可したedgeだけをauthority、理由、対象、時刻、evidence付きで
実行する。

各role nodeはschema-valid outcomeを出して`completed`となり、表のtargetはPlan edgeが作る新しいRun nodeを
表す。`verify_failed`と`request-changes`でもterminalなsource nodeを再openせず、新しいtarget role Run node IDを
作る。

| source      | event or guard                                                               | target        | outcome             | evidence                                       |
| ----------- | ---------------------------------------------------------------------------- | ------------- | ------------------- | ---------------------------------------------- |
| planner     | plan_valid + schema-valid                                                    | implementer   | CONTINUE            | plan artifact                                  |
| planner     | plan_invalid or evidence_missing                                             | waiting_human | BLOCKED             | validation evidence                            |
| implementer | implementation_valid + evidence present                                      | executor      | CONTINUE            | implementation artifact                        |
| implementer | implementation_invalid or evidence_missing                                   | waiting_human | BLOCKED             | validation evidence                            |
| executor    | verify_passed                                                                | reviewer      | CONTINUE            | all command evidence                           |
| executor    | verify_failed + retry_count < maxExecutorRetries                             | implementer   | RETRY               | failure evidence + new implementer Run node ID |
| executor    | verify_failed + retry_count >= maxExecutorRetries                            | waiting_human | BLOCKED             | failure evidence                               |
| reviewer    | approve                                                                      | human / PR    | READY_FOR_PR        | independent review artifact                    |
| reviewer    | request-changes + no critical + improvement_count < maxImprovementIterations | implementer   | IMPROVE             | findings + new implementer Run node ID         |
| reviewer    | budget exhausted + only minor remains                                        | human / PR    | CONDITIONAL_HANDOFF | remaining findings in PR description           |
| reviewer    | budget exhausted + major remains                                             | waiting_human | BLOCKED             | remaining major findings                       |
| reviewer    | critical finding                                                             | waiting_human | ESCALATED           | critical finding evidence                      |
| any role    | required evidence missing                                                    | waiting_human | BLOCKED             | missing evidence list                          |
| human / PR  | approved / merged                                                            | terminal      | COMPLETED           | human decision + PR evidence                   |

### Budget計数規則

- 初回executor attemptはretry_count=0とする。executor failureからimplementerへ戻るedgeを受理すると
  `retry_count`を1増やす。`maxExecutorRetries`は初回後の追加retry回数であり、値2ならexecutorは最大3回。
- 初回reviewer passはimprovement_count=0とする。reviewerの`request-changes`からimplementerへ戻るedgeを
  受理すると1増やす。`maxImprovementIterations`はreviewer起点の追加改善回数であり、値3ならreviewerは最大4回。
- evidence欠落はbudgetを消費せずBLOCKED、critical findingは残budgetに関係なくESCALATEDとする。
- improvement budget超過時、minorだけならCONDITIONAL_HANDOFF、majorが残ればBLOCKEDとする。
- retryは古いattemptを再開せず、単調増加する新しいattempt IDとlineageを作る。terminal/stale attemptの
  updateは拒否する。

### control planeとexecution planeの段階境界

現行(#327)は外部orchestratorがworkspace、agent subprocess、tool/command、JSON artifact、schema validation、
manual gateを運用する。`.dev-flow`はignored evidenceであり、durable Run Graphでも製品control planeでもない。

#328以後、gh-ganttの製品control planeがbinding validation、stable ID、transition、budget、authority、
human gate、checkpoint、idempotent event受付、bounded status viewを担う。外部runnerはexecution planeとして
処理し、schema-valid outcome/artifact/evidence eventを返す。provider SDK、agent subprocess、任意shell
executor、PR reply/resolve/mergeは製品へ内蔵しない。

### versioned拡張

- 並列化(#329)はready frontier、claim、lease、bounded concurrency、join conditionを追加する。
- 動的変更(#331)はapproval付きproposalを検証して新しいplan versionを作る。実行中versionを直接変更しない。
- 可視化(#330)はplanned topologyとactual transitionを重ねる。

Issue #327ではTypeScript schema、store、CLI event commandを実装しない。

## Alternatives

### Work GraphとRun Graphをtask statusへ統合する

GitHub statusだけでroleとattemptを表すと再試行履歴とevidenceが失われ、人間の仕事状態とrunnerの一時状態が
競合するため採用しない。

### gh-ganttへrunnerとprovider SDKを内蔵する

[Symphonyのcoordination/execution分離](https://github.com/openai/symphony/blob/f8e8b8a670c799f6e0ade7a8c25c4bf4a4a56ec7/SPEC.md#32-abstraction-levels)を
参考に一体化も検討したが、agent/CI固有の実行方式をcontrol planeへ持ち込み、general-purpose workflow
engineへscopeが広がるため採用しない。これは一次資料の要請ではなくgh-gantt固有の推論である。

### 動的graphと並列実行を同時に導入する

[Anthropic公式記事の単純な構成から始める指針](https://www.anthropic.com/engineering/building-effective-agents#when-and-when-not-to-use-agents)に
照らし、ID、authority、failure semanticsを実測する前にmutation surfaceを増やさない。まず一Issueの
fixed graph、次にbounded parallelism、最後にapproval-gated mutationの順で追加する。

## Consequences

- ADR-021が4 graph、state、transition、budget、責務境界の唯一の設計正典となる。
- active workflow/skill/view文書は文脈固有の操作とADR-021への導線だけを持つ。
- 現行artifact handoffを製品control plane実装済みとは扱わず、durable Run Graphは#328に残す。
- NFR-STABILITY-014は将来製品挙動が実装されるまで`uncovered`を維持する。
- #329と#331はstable ID、lineage、schema version、fail-closed規則を壊さず拡張する。
