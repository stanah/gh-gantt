# Graph Engineering の task-fit と運用証拠に関する一次資料調査

参照日: 2026-08-03

## 調査範囲と用語

この文書は、Graph Engineering の実環境ベンチマークと運用ガイドを設計するために、Anthropic の公式 engineering 記事、OpenAI Symphony の公式仕様、GitHub 公式 API ドキュメントを調査した結果をまとめる。

ここでいう **Graph Engineering** は、計画・仕事・権限・実行履歴を別の graph として扱い、version、authority、evidence、budget、human gate で結ぶ、このリポジトリ固有の設計規律である。調査した外部一次資料はこの名称や 4 graph モデルを定義していない。したがって、外部で確立済みの一般標準とは表現しない。[A1][O1]

以下では、一次資料に直接書かれている内容を「事実」、gh-gantt の設計・ベンチマークへ適用した判断を「推論」として分離する。

## 一次資料から確認できる事実

### 1. 複雑化には task-fit と費用対効果が必要

- **事実**: Anthropic は、まず可能な限り単純な解決策を選び、必要な場合だけ複雑性を増やすことを推奨している。agentic system は一般に、より良い task performance と引き換えに latency と cost を増やす。[A1]
- **事実**: Anthropic は parallelization の適用条件を、独立して分割できる subtask を速度向上のため並列実行できる場合、または複数の独立観点・試行により信頼度を上げたい場合としている。[A1]
- **事実**: Anthropic の orchestrator-workers pattern は、必要な subtask を事前に予測できない複雑な仕事に適する。一方、固定された小さな subtask へ容易に分割できる場合には、より単純な prompt chaining が候補になる。[A1]
- **事実**: Anthropic の multi-agent research system は breadth-first で互いに独立した調査方向に強く、同社の内部 research eval では特定構成が single-agent 構成を 90.2% 上回った。ただしこれは研究 task と特定モデル構成に関する社内評価である。[A2]
- **事実**: 同じ記事は、multi-agent system が chat interaction の約 15 倍の token を使ったという同社データを示し、価値が追加費用を正当化する task が必要だとしている。また、共有 context や agent 間依存が多い領域は不向きで、多くの coding task は research より並列化可能部分が少ないと述べている。[A2]

**推論**:

- 90.2% と 15 倍を gh-gantt の期待値や合格閾値へ転用してはならない。前者は research 内部評価、後者は chat interaction 比であり、「同一 coding task の single-loop 対 Graph Engineering」という比較ではない。
- Graph Engineering の採用判断は graph の存在自体ではなく、独立 frontier、権限分離、独立 verification、長時間実行の checkpoint/recovery のどれが必要かで行う。
- 一直線で短く、共有 context が大きく、独立検証も外部副作用もない task は single-loop を標準候補にする。graph 化の固定費を正当化する一次資料上の根拠がないためである。

### 2. coordination は性能要因であると同時に failure surface でもある

- **事実**: Anthropic は multi-agent system で coordination complexity が急増し、単純な問い合わせへの過剰な subagent 生成、重複作業、調査漏れ、過剰な相互更新を実際の failure mode として報告している。[A2]
- **事実**: 同社は delegation に objective、output format、使用する tool/source、task boundary を明示し、task complexity に応じて agent 数と tool call 数を調整する規則を設けている。[A2]
- **事実**: 同期的な subagent 実行は coordination を単純化する一方、一つの遅い subagent が全体を止める。非同期化は並列性を増やすが、結果の coordination、state consistency、error propagation を難しくする。[A2]
- **事実**: Anthropic は automated evaluation だけでは見落とす edge case があるため manual testing を必須としており、agent interaction の非決定性に対して tracing と interaction structure の観測が重要だとしている。[A2]

**推論**:

- ベンチマークでは最終成功だけでなく、重複 node、待ち合わせ時間、stale owner、再試行、human intervention を coordination cost として独立に記録する。
- 並列 arm は「同時に開始した agent 数」ではなく、依存関係を満たした ready frontier と claim の証拠で定義する。偶然重なった process だけでは graph orchestration の証拠にならない。
- output と evidence は typed かつ bounded にし、欠落を空値や成功として扱わない。これは Anthropic の明確な delegation boundary と、このリポジトリの bounded projection を組み合わせた設計判断である。

### 3. issue tracker は scheduling/reconciliation の control-plane input になり得る

- **事実**: OpenAI Symphony 仕様は、issue tracker を継続的に読み、issue ごとの隔離 workspace で coding agent を実行する長時間 service を定義する。repository-owned `WORKFLOW.md`、bounded concurrency、単一 authoritative orchestrator state、retry、reconciliation、operator-visible observability を目標に含む。[O1]
- **事実**: 同仕様は policy、configuration、coordination、execution、integration、observability を別 layer として扱う。orchestrator は poll、dispatch、retry、stop/release を所有し、workspace manager と agent runner が実行環境を担う。[O1]
- **事実**: Symphony は dispatch 前に reconciliation を行い、worker 起動前に `claimed` と `running` の重複を確認する。異常終了は exponential backoff retry へ、stall は worker 停止と retry へ送る。[O1]
- **事実**: Symphony における tracker ticket の書き込みは scheduler 自身の組み込み業務ロジックではなく、通常は agent が利用可能な provider-native tool を通じて行う。成功した run は `Done` ではなく `Human Review` のような workflow-defined handoff で終えてよい。[O1]
- **事実**: Symphony の scheduler state は意図的に memory-only である。process restart 後は retry timer や running session を復元せず、tracker の再 poll と保存済み workspace から eligible work を再 dispatch する。[O1]

**推論**:

- Work Graph の tracker state と、Run Graph の attempt/checkpoint/claim state を同一視しない。tracker は「何を実行可能か」の外部正本になり得るが、「どの副作用まで完了したか」を単独では証明しない。
- gh-gantt の durable Run Graph は Symphony の必須要件ではなく、restart 後に retry/attempt lineage と side-effect ambiguity を保持するための、より強いリポジトリ固有保証である。
- issue state が変わったときに実行を停止できること、停止後に同じ task を二重 dispatch しないこと、human handoff を完了と誤認しないことを運用 smoke の独立 assertion にする。

### 4. recovery は「再起動した」ではなく、失敗分類と再調停の証拠が必要

- **事実**: Anthropic は長時間 agent では error が累積し、先頭からの restart は高価であるため、checkpoint と deterministic retry safeguard を組み合わせて途中から再開できる仕組みを構築したと説明している。[A2]
- **事実**: Symphony は workflow/config、workspace、agent session、tracker、observability を failure class として分ける。dispatch validation failure は新規 dispatch だけを止め、tracker fetch failure は次 tick へ、worker failure は bounded backoff retry へ送る。[O1]
- **事実**: Symphony の runtime snapshot は running/retrying、turn count、token total、runtime、rate-limit 情報を含めることを推奨している。また logs には outcome と簡潔な failure reason を含め、大きな raw payload は避けるとしている。[O1]
- **事実**: GitHub は API の concurrent request を避け、mutative request の間隔を空け、rate-limit 時は `retry-after` または reset 時刻を尊重し、継続失敗時は exponential backoff と有限回での停止を行うよう公式に案内している。[G1][G2]

**推論**:

- 一時的 GitHub API failure の smoke で、意図的に大量 request を送り実 rate-limit や障害を発生させてはならない。専用 smoke 環境で transport boundary に fail-once/timeout を注入し、その前後に実 GitHub 読み取りまたは限定 mutation の postcondition を照合する。これは real integration を保ちつつ GitHub の利用規律を破らない方法である。
- recovery success は、再 process が立ち上がったことではなく、次をすべて満たした場合に限る。
  1. fault 前の accepted checkpoint と authority/claim lineage を再観測できる。
  2. stale owner の event または mutation publish が拒否される。
  3. `committed`、`not_started`、`reconciled`、`unknown` を混同せず、unknown side effect を自動再送しない。
  4. 同じ acceptance criteria の verifier が回復後に合格するか、fail-closed な human handoff に到達する。
- raw conversation、raw provider response、secret、絶対 path を公開 evidence に含めず、schema-valid summary、hash、件数、duration、outcome、sanitized failure class だけを残す。欠落した値は `0` ではなく理由付き `unknown` にする。

## gh-gantt ベンチマークへの適用案（推論）

以下は一次資料の直接要件ではなく、Issue #332 の比較を再現可能にするための実験設計案である。

### 比較単位

- 同一 acceptance criteria、同一 repository revision、同一 verifier、同等の model/tool permission、同一外部環境を paired trial にする。
- control arm は単一 agent/context/workspace の single-loop とする。Graph arm は Graph Contract、ready frontier、authority、Run Graph evidence、human gate を使う。
- 順序効果を減らすため arm の実行順を交互にし、各 scenario を複数回行う。最小反復数や信頼区間は実装時に明示し、単発の成功を一般化しない。
- provider prompt/session/run の識別子や raw prompt は公開しない。公開 evidence では trial ordinal、repository revision、sanitized environment profile、prompt/verifier の content hash を使う。

### 再現対象 scenario

| scenario                       | single-loop control                  | Graph Engineering arm                                        | 主な判定                                              |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| 固定直列 workflow              | 一つの loop で plan→implement→verify | fixed Run Graph の role node を順に遷移                      | graph 固定費、独立 verify の差                        |
| 独立 ready frontier            | 独立 task を順次処理                 | bounded claim で並列処理し fan-in                            | verified success、wall-clock、coordination failure    |
| verify failure recovery        | 同じ loop が修正・再検証             | terminal attempt を保持し、budget 内で新 attempt/node へ遷移 | retry 数、再現性、recovery time                       |
| human gate と承認済み mutation | human 判断まで停止し手動変更         | proposal→独立承認→apply/reconcile→replan acceptance          | principal separation、unknown side effect、audit 完備 |
| 運用 recovery                  | process ごと再開                     | checkpoint/claim/fencing/reconciliation から継続             | 二重実行なし、stale event 拒否、AC 再合格             |

recovery scenario は少なくとも runner/agent 停止、orchestrator process restart、stale lease、制御された GitHub transport failure、同期 conflict を別々に測る。一つの障害で他の回復経路も検証済みとは扱わない。

### metric の最小契約

各 metric は `known(value)` または `unknown(reason)` の排他的な形にし、未取得を数値 `0` に正規化しない。

| metric               | 記録する意味                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| verified success     | acceptance verifier の pass/fail/inconclusive。agent の自己申告とは分ける    |
| wall-clock           | trial 開始から verified terminal/handoff まで。human 待機時間も別列で保持    |
| token                | input/output/total。cumulative と delta の意味を混在させない                 |
| cost                 | 同じ時点の価格表で算出できる場合だけ記録。算出不能は unknown                 |
| node/agent/tool call | graph node attempt、agent invocation、tool call を別々に数える               |
| retry                | continuation、retryable failure、review improvement を区別する               |
| human intervention   | 回数、待機時間、decision 種別、principal separation の成否                   |
| recovery time        | fault 注入から verifier 合格または fail-closed handoff まで                  |
| coordination failure | duplicate work、claim conflict、stale result、join wait、evidence 欠落を分類 |

Anthropic の結果が token/tool call と performance の関連を示していても、token を品質の代替指標にはしない。最上位判定は verified success と safety invariant であり、その後に wall-clock と resource cost を比較する。

### 採用・縮退・停止の判断

- **採用候補**: Graph arm が safety invariant を維持し、同じ verifier に対する成功率、独立検証、または recovery のいずれかを改善し、その価値が追加 latency/token/tool call/human burden を上回る。
- **single-loop へ縮退**: 独立 frontier がなく、Graph arm の verified outcome が同等以下で、追加 overhead だけが測定された場合。
- **並列度を下げる**: rate-limit、claim contention、join wait、重複作業、context 再構成が増え、wall-clock または成功率を悪化させた場合。
- **自動 retry を止める**: side effect が unknown、authority が不明、budget 上限到達、同じ failure class が反復、または GitHub の retry 指示を満たせない場合。
- **human gate へ送る**: destructive mutation、principal separation 未証明、contract/version 不一致、stale lease の競合、reconciliation 不能の場合。

一次資料から安全な concurrency、retry 回数、output budget の固定値は導けない。Symphony の既定値や Anthropic の research 向け agent/tool-call 目安をそのまま採用せず、候補値ごとの paired trial から成功率優先で選ぶ。測定前の fallback は concurrency 1、暗黙 retry なし、危険な mutation は human-only とするのが保守的だが、これは外部標準ではなく運用上の初期仮説である。

## 既存 ADR との整合性確認

| 既存判断                                                                             | 一次資料との関係                                                                                                                                    | 結論                                                             |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| ADR-008: unit/fixture だけでなく実環境 smoke を使う                                  | Anthropic は manual test と production tracing、Symphony は Real Integration Profile を重視する。一方、fixture を採用しない判断自体は gh-gantt 固有 | 矛盾なし。controlled fault と実 postcondition を組み合わせる     |
| ADR-020: task/PR/evidence を bounded projection する                                 | Anthropic の effort scaling と明確な output boundary、Symphony の bounded status/簡潔な log に整合                                                  | 矛盾なし。raw evidence の無制限公開は避ける                      |
| ADR-021: Plan/Org/Work/Run Graph を分離し、Graph Engineering を固有用語とする        | Symphony の layer 分離は参考になるが 4 graph は定義しない                                                                                           | 矛盾なし。外部標準という表現は禁止                               |
| ADR-022: accepted event journal から durable Run Graph を復元する                    | Symphony の restart は tracker/filesystem driven で exact scheduler state を復元しない                                                              | 矛盾ではなく保証強化。Symphony 準拠の必須要件とは主張しない      |
| ADR-023: Work Graph Cache と Run Graph/coordination store を分け、lease を閉じ込める | Symphony の workspace isolation と single orchestrator authority に方向性は近いが、storage layout/lease は gh-gantt 固有                            | 矛盾なし。実 smoke で crash/lock recovery を検証する             |
| ADR-024: ready frontier、bounded concurrency、claim、heartbeat、reclaim、fencing     | Symphony の bounded dispatch、claimed/running check、reconciliation と整合。durable claim/fencing はより強い固有保証                                | 矛盾なし。外部仕様の要請とは書かない                             |
| ADR-025: Work Graph mutation を human approval と reconciliation で gate する        | Symphony は単一の approval policy を規定せず、ticket write を agent tool 側へ委ねる                                                                 | 矛盾なし。gh-gantt 独自の authority/safety policy として維持する |

注意すべき差分は、Symphony の memory-only scheduler state を gh-gantt の recovery proof と取り違えないこと、Symphony の concurrency default を gh-gantt の安全値として流用しないこと、Anthropic の research benchmark を coding task の効果量として一般化しないことである。

## 一次資料

- [A1] Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), 参照日 2026-08-03。
- [A2] Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), 公開日 2025-06-13、参照日 2026-08-03。
- [O1] OpenAI, [Symphony Service Specification（commit `f8e8b8a` 固定）](https://github.com/openai/symphony/blob/f8e8b8a670c799f6e0ade7a8c25c4bf4a4a56ec7/SPEC.md), Draft v1、参照日 2026-08-03。
- [G1] GitHub Docs, [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), 参照日 2026-08-03。
- [G2] GitHub Docs, [Rate limits and query limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api), 参照日 2026-08-03。
