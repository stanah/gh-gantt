# Graph Engineering の計測・導入・停止・復旧

Graph Engineering は graph を作ることではなく、Plan / Work / Org / Run Graph を version、authority、evidence、
budget、human gate で安全に結ぶ gh-gantt 固有の運用である。外部標準や品質保証として扱わない。
設計判断は [ADR-026](../../../docs/adr/ADR-026-measured-graph-engineering-adoption.md)、一次資料は
[調査ノート](../../../docs/research/graph-engineering-primary-sources.md)、導入前の実測結果は
[Issue #332 benchmark](../../../docs/benchmarks/graph-engineering-2026-08-03.md)を参照する。
machine-verifiable な recovery summary は
[versioned evidence](../../../docs/benchmarks/graph-engineering-recovery-evidence.json)を正本とする。

## 使う条件 / 使わない条件

次のいずれかに実価値があり、追加 cost を paired trial で説明できる場合だけ opt-in する。

- 依存のない ready frontier を2本以上、isolated workspace と claim で安全に並列化できる。
- implementer と verifier、runner と human authority など、独立検証または権限分離が必要である。
- 長時間実行を checkpoint、fencing、reconciliation から復旧する必要がある。
- 承認付き Work Graph mutation を audit し、実行中 plan を暗黙変更せず新 versionへ進める必要がある。

次は single-loop を使う。

- 短い直列 task、単純な文言・設定変更、低価値 task。
- 共有 context が大きく、subtask の独立性が低い coding task。
- ready frontier、独立 verifier、remote side effect、recovery のどれも必要ない task。
- token / cost / verified success が unknown のままで、追加 overhead を説明できない task。

## 導入

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm benchmark:graph -- --input benchmark-record.json --output benchmark-report.json
```

`benchmark-record.json` は公開対象にしない作業用入力である。strict schemaは未定義のraw fieldと危険なevidence URIを
拒否するが、suite / task shape / pair IDを公開可能とは保証しない。`benchmark-report.json` はこれらの入力値と
元evidenceの本文・URIを再出力せず、pairを1始まりのordinalへ変換したqualification summaryである。

CIや採用gateで Graph候補を必須にする場合だけ次を使う。

```bash
pnpm benchmark:graph -- --input benchmark-record.json --require-qualified
```

通常の分析は `single_loop` 判定でも exit 0、`--require-qualified` は `graph_candidate` 以外を exit 1 にする。

## 評価 scenario と paired trial

各 suite は次の5 scenarioに最低1 pairを持つ。

| ID                             | 再現するもの                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `fixed_run_graph`              | fixed dev-role の plan → implement → verify → review → human handoff |
| `ready_frontier`               | 独立 task の bounded claim、parallel execution、fan-in               |
| `verify_failure_recovery`      | terminal attemptを保持した新 attempt / nodeでの再検証                |
| `human_gate`                   | human decisionまでの停止、authority、principal separation            |
| `approved_work_graph_mutation` | proposal、承認、apply / reconcile、新 plan version                   |

pair は acceptance criteria hash、repository revision、verifier hash、environment hashを完全一致させる。
`single_loop` と `graph_orchestration` の先行順を交互にし、単発の成功を全taskへ一般化しない。

metric は `known` と `unknown` を混同しない。特に token / costを取得できないときに0を入れてはならない。
verified success は agent の自己申告ではなく、同じ verifier の結果を使う。

## 初期 policy と contract ceiling

measurement gateが揃うまでのrunner初期値は次のとおり。

- default: single-loop
- dispatch: concurrency 1
- automatic retry: 0（暗黙retryなし）
- remote side effect / mutation: human gate 必須
- output: `outputReferenceLimit: 20`、inline evidence 0 byte

全5 scenario / recoveryと全metricがknownで揃い、ready frontierが20%以上短く、token / costが2倍以下、
両armのcoordination failureがknown 0のtask shapeだけ、concurrency 2・automatic retry 1へ進める。

これはrunner初期値であり、repositoryの`max_concurrency: 2`とGraph Contractの`maxExecutorRetries: 2`は
contract ceilingである。benchmarkはcontract ceilingを変更・緩和しない。

## 実環境 recovery smoke

failure classをまとめて「復旧済み」としない。専用smoke環境で1件ずつ注入し、fault前のaccepted state、
stale owner拒否、side-effect state、同一verifierのpostconditionを別々に残す。

| ID                     | 安全な注入                                                             | 必須 postcondition                                                 |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `runner_failure`       | attemptを`failed`または`stalled`でterminal化しrunnerを停止             | 旧attemptを再開せず、新attemptまたはfail-closed handoffへ進む      |
| `process_restart`      | commandごとにCLI processを終了し、別processで`run show` / `run resume` | checkpoint、attempt lineage、wait reasonを再観測できる             |
| `stale_lease`          | 短いleaseを期限切れにして別ownerが`run reclaim --reason expired`       | 旧ownerのheartbeat / event / releaseが拒否される                   |
| `github_api_transient` | transport seamで1回だけtimeout / unavailableを返す                     | retry指示とbudgetを守り、次の実read postconditionが一致する        |
| `sync_conflict`        | 専用scratch taskの同一fieldをlocal / remoteで別変更する                | `gh-gantt conflicts`で検出し、明示resolve後に`No conflicts.`となる |

`github_api_transient` では実 rate-limit や GitHub 障害を発生させない。大量requestや意図的な二次rate-limitは
禁止し、fail-once / timeoutと回復後の実postconditionを組み合わせる。mutationを使う場合は専用repository、
明示execute gate、最小scope、後処理を必須にする。

## 停止

次のいずれかで新規dispatchとautomatic retryを停止する。

- verified success、authority、contract version、side-effect stateのいずれかがunknown。
- 同じfailure classが反復、retry budget超過、claim contention、join wait、重複作業が増加。
- GitHubの`retry-after` / rate-limit resetを守れない。
- human gate、review gate、sync conflict、open iterationが残る。
- Graph armがsingle-loopより遅い、またはtoken / costが2倍を超える。

停止時はRun Graphの現在node、attempt、claim、checkpointをbounded viewで確認する。raw runner logから状態を
推測せず、unknown side effectは自動再送しない。

## 復旧

1. `gh-gantt pull`、`gh-gantt status`、`gh-gantt conflicts`でWork Graphと同期gateを再確認する。
2. `gh-gantt run show <run-id> --json`でcheckpoint、wait reason、claim auditを確認する。
3. current ownerが停止済み、またはlease期限切れであることをevidence化してから`run reclaim`する。
4. side effectが`not_started`なら再開可能。`committed` / `reconciled`はreconciliation evidenceを要求する。
   `unknown`はhuman gateへ送り、自動再送しない。
5. 同じacceptance verifierを再実行し、recovery timeとpostconditionをrecordへ追加する。
6. benchmarkを再実行し、`graph_candidate`でなければsingle-loopのままにする。

## public-safe evidence

コミットまたはPRへ残せるのは、trial ordinal、scenario、sanitized task shape、repository revision、hash、件数、
duration、outcome、failure class、repository相対path / HTTPS URLである。

raw prompt、conversation、provider response、API token、private key、header、cookie、hostname、ユーザーの絶対 path、
provider session / run ID、raw API responseは残さない。秘密をredactしても本文全体は保存せず、bounded summaryと
SHA-256へ変換する。判断に迷う値は公開せず`unknown(reason)`にする。

公開 recovery pack の observation は scenario、status、recovery time と evidence reference だけを持つ。
reference の allowlist は kind、repository相対path / HTTPS URI、SHA-256、byte length とし、command、
fault injection、postcondition本文は非公開の実行記録へ分離する。
