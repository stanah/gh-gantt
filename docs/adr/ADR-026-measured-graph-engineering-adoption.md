---
id: ADR-026
title: Graph Engineering の採用を実測と recovery evidence で gate する
date: 2026-08-03
status: accepted
related_requirements:
  - NFR-STABILITY-016
---

## Context

ADR-021 で定義した Graph Engineering は、Plan / Work / Org / Run Graph を別の正本として扱い、
version、authority、evidence、budget、human gate で結ぶ gh-gantt 固有の設計規律である。
Graph Engineering は外部標準ではない。graph を作ったこと自体は、single-loop より高い品質、短い時間、
低い費用を証明しない。

一次資料調査では、Anthropic は単純な構成から始め、独立した task への並列化や独立観点に価値がある場合だけ
複雑化するよう勧めている。同社の research system の評価値を coding task へ一般化することはできない。
OpenAI Symphony は issue tracker、bounded concurrency、reconciliation の参考になるが scheduler state は
memory-only であり、gh-gantt の durable Run Graph、claim、fencing の保証とは同じでない。詳細は
[一次資料調査](../research/graph-engineering-primary-sources.md)を正本とする。

## Decision

### 実行と測定の seam

`@gh-gantt/smoke` に strict JSON の benchmark module を置く。外部 runner は作業を実行し、bounded observation と
hash-bound evidence reference を入力する。module は schema validation、paired comparison、coverage、採用・縮退
判定だけを行う。provider SDK、agent subprocess、任意 shell executor は製品へ内蔵しない。

入力は同じ acceptance criteria hash、repository revision、verifier hash、environment hash を持つ
`single_loop` と `graph_orchestration` の pair に限定する。strategy の先行順は交互にし、次の5 scenarioを
別々に含める。

入力の suite / task shape / pair ID は照合用の非公開データとして扱い、reportへ再出力しない。report上のpairは
入力値と結び付かない1始まりのordinalだけを持つ。CLIのstdout modeは単一JSON documentだけを返す。

- `fixed_run_graph`
- `ready_frontier`
- `verify_failure_recovery`
- `human_gate`
- `approved_work_graph_mutation`

### metric と evidence

verified success、wall-clock、input/output token、cost、Run node、agent invocation、tool call、retry、
human intervention / wait、recovery time、coordination failureを記録する。各 metric は
`known(value)` または `unknown(reason)` の排他的 union とし、known 0 を unknown へ丸めない。

公開 evidence reference は repository 相対 path または HTTPS URL、SHA-256、byte length、種別だけを持つ。
公開 recovery observation は scenario、status、recovery time と reference のみを許可し、command、fault injection、
postcondition本文は非公開の実行記録へ分離する。
raw prompt、conversation、provider response、token、秘密鍵、絶対 path、hostname、内部 run/session ID は残さない。
1 trial の reference は最大20件、1 reference metadata は最大64 KiB とし、report は evidence URI 自体も再出力しない。

### qualification と初期値

Graph arm を task-shape 固有の候補にできるのは、次をすべて満たす場合だけである。

1. 5 scenario に最低1 pairずつあり、suite順で先行strategyが交互である。
2. 5 recovery smoke が evidence 付きで pass し、recovery time が known である。
3. verified success が全 trial で known かつ Graph arm に failure がない。
4. `ready_frontier` の Graph arm が同じ pair の single-loop より20%以上短い。
5. token と cost が known で、Graph arm / single-loop の比が2倍以下である。
6. wall-clock、node / agent / tool call、retry、human intervention / wait、recovery timeが全trialでknownである。
7. 両armのcoordination failureがknown 0である。

どれかが欠ける場合は `single-loop` を既定とし、concurrency 1、implicit automatic retry 0 へ縮退する。
全 gate を通った task shape だけ concurrency 2、automatic retry 1 を初期値にできる。remote side effect、
Work Graph mutation、principal separation が必要な操作の human gate は成績によらず必須である。

これらは runner の初期値であり、Graph Contract の `maxExecutorRetries: 2`、repository dispatch の
`max_concurrency: 2` という contract ceiling を変更しない。benchmark は ceiling を緩和せず、観測値を
全 task へ一般化しない。output policy は `outputReferenceLimit: 20`、inline evidence 0 byte とする。

### recovery smoke

次の failure class を一つずつ注入し、別々の postcondition と evidence を残す。

- runner failure
- process restart
- stale lease
- controlled GitHub API transient failure
- sync conflict

GitHub API は実 rate-limit や実障害を起こさない。専用 smoke 環境の transport seam で fail-once / timeout を
発生させ、回復後に実 GitHub read または限定 mutation の postcondition を照合する。unknown side effect は
自動再送せず human gate へ送る。

## Alternatives

### 製品に multi-agent runner を内蔵する

provider と process lifecycle が control plane へ漏れ、外部 runner と製品の責務が混ざるため採用しない。

### Anthropic または Symphony の既定値を流用する

task、model、権限、durability が異なり、coding task の安全値を証明しないため採用しない。

### 欠測を0として比較する

未取得の token / cost / retry と実測0を混同し、Graph arm を誤って昇格できるため採用しない。

### 実 rate-limit や GitHub障害を発生させる

GitHub の利用規律に反し、他の利用者と公開repositoryへ影響するため採用しない。

## Consequences

- Graph Engineering は opt-in となり、データ不足時は単純な single-loop が選ばれる。
- task shape ごとに同条件の pair と recovery evidence を維持する運用コストが増える。
- token / cost を公開安全に取得できない provider では Graph arm は自動昇格しない。
- durable Run Graph と Symphony の memory-only scheduler state の保証差を維持できる。
- benchmark report は task quality の証拠ではなく、入力 evidence を検証・要約した qualification 結果である。
