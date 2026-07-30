---
id: ADR-023
title: Project Storage の配置・移行・repository lease を一つの Interface に閉じ込める
date: 2026-07-30
status: accepted
related_requirements:
  - FR-STORE-004
  - NFR-STABILITY-001
  - NFR-STABILITY-015
---

## Context

ADR-018 は `tasks.json`、`sync-state.json`、`comments.json` を GitHub から再構築できる
cache とし、`git rev-parse --git-common-dir` 起点で同一 repository の worktree 間に
共有する方針を定めた。一方、従来の Store は caller から渡された workspace root の
`.gantt-sync/` を個別に読み書きするため、linked worktree ごとに Work Graph の projection と
merge base が複製される。

単に保存先だけを共有すると、次の問題が残る。

- `tasks.json` と `sync-state.json` を別々に置換する途中を reader が観測できる。
- 複数 worktree の read-modify-write が後勝ちになり、remote I/O 中の競合も防げない。
- 既存 worktree に残る legacy cache のどれを採用するかが曖昧になる。
- Git の検出失敗を non-git と誤認すると、新しい workspace-local cache が生まれて
  split-brain になる。
- 同じ `.gantt-sync/` にある config、outer loop journal、Graph Contract、Run Graph まで
  一律に共有すると、Work Graph Cache と実行履歴の正本が混ざる。

このため、caller が配置や lock の詳細を組み立てない deep Project Storage module が必要である。

## Decision

### 案A+B hybrid: 一つの公開 Interface と内部の closed StorageSlot catalog

案Aの公開 seam を採用し、Project Storage module の入口を次の一つに限定する。

```ts
withProjectStorage(root, { mode, scope }, callback);
```

`mode` は `read` または `write`、`scope` は `shared-cache`、`workspace`、または両方を更新する
`all` である。callback は型付けされた storage 操作だけを受け取り、
物理 path、generation、lock record、migration manifest を受け取らない。案BをImplementation内だけに採用し、
保存対象をclosed `StorageSlot` catalogに列挙して、callerに動的登録、任意path、scopeの上書きを許可しない。

catalog は次の配置を固定する。

| StorageSlot                        | scope                              | 性質                                      |
| ---------------------------------- | ---------------------------------- | ----------------------------------------- |
| `tasks`, `sync-state`, `comments`  | repository-shared Work Graph Cache | GitHub から再構築できる projection / base |
| `config`, `workflow`, `loop-state` | workspace-local                    | 設定またはローカル観測 journal            |
| `graph-contracts`, `run-graph`     | workspace-local                    | Plan/Org 契約と accepted event journal    |

`loop-state.json` は Run Graph ではなく outer loop の観測 journal であり、どちらも #299 の
共有対象にしない。

### versioned repository namespace

Git repository では、workspace-local の Zod 検証済み config から GitHub Project identity
（正規化した owner、repository、project number）を導出し、次の versioned namespace を使う。

```text
<git-common-dir>/gh-gantt/cache/project-storage/v1/<project-key>/
  snapshots/<generation>/tasks.json
  snapshots/<generation>/sync-state.json
  CURRENT
  comments.json
  migration.json
<git-common-dir>/gh-gantt/locks/work-graph-cache.lock/owner.json
```

同じ Git repository 内でも GitHub Project identity が異なれば cache namespace を分ける。
`project-key` は正規化した Project identity の fingerprint から導出し、identity を path へ直接露出しない。
namespace version を path に含め、将来の layout 変更を暗黙の上書きにしない。
repository lease は worktree や project namespace の外側に置き、同一 repository の Project Storage
操作を統制する。

### atomic snapshot-set

`tasks.json` と `sync-state.json` は一つの snapshot-set として扱う。writer は新しい generation
directory に両方を書き、各ファイルの Zod validation を完了してから、一時 pointer の atomic rename により
`CURRENT` を publish する。reader は `CURRENT` が指す generation のファイルだけを読む。publish 前に失敗した
generation は正本にならず、旧 `CURRENT` を維持する。snapshot hash と tasks 内容の整合性検証は
NFR-STABILITY-001-AC1 の未充足事項であり、この publish 処理が保証するとはみなさない。

`comments.json` は同じ repository-shared namespace に置くが、tasks/sync-state の merge base ではないため
snapshot-set には含めない。repository lease 内で atomic replace し、remote取得の各batchでは `flush()` により
durable checkpointをpublishする。欠損時と破損したlegacy commentsは GitHub から再構築する。

### all-worktree legacy migration

共有 namespace に snapshot がない最初の shared slot access だけ、初版の exclusive repository lease 内で
copy-once migration を行う。
Git が登録している全 worktree を列挙し、各 `<worktree>/.gantt-sync/` の legacy `tasks.json` と
`sync-state.json` を次の順に検査する。

1. 両方がない worktree は候補なしとする。いずれかがある場合は config を先に検証し、別の GitHub Project
   identity を指す worktree は現在namespaceの候補から除外する。
2. 同じidentityで一方だけ存在する場合は欠損として停止する。全候補を Zod 検証し、正準化した JSON から
   pair の canonical fingerprint を計算する。破損した任意のcomments cacheは候補pairを止めず欠損扱いにする。
3. 候補が一つ、または全 fingerprint が一致する場合だけ、新generationへcopyして`CURRENT`をpublishする。
4. 候補の相違、欠損、破損は自動選択せず fail-closed にする。
5. `migration.json` に project identity、移行元、fingerprint、対象worktreeを記録する。
6. 移行後も全worktreeを照合し、記録にないlegacy pairの出現または記録済みfingerprintの変化を
   旧CLI等による再書込みとみなしてfail-closedにする。

legacy file は自動削除も dual-write もしない。移行元を残しても、manifest と fingerprint により
新しい CLI が変化を無視して進むことはない。

候補が分岐した場合、通常の shared slot access は `LEGACY_CACHE_DIVERGED` で停止する。operator は候補を確認し、
`gh-gantt storage migrate --from <worktree>` で正本にする legacy pair を明示する。`--json` は同じ操作の結果を
machine-readable に返す。指定元に候補がなければ `LEGACY_SOURCE_NOT_FOUND` で停止し、自動選択や後勝ち更新を
行わない。選択した pair を新 generation として publish し、全候補の fingerprint を migration manifest に記録する。

### 初版の exclusive repository lease

`withProjectStorage` は lazy session を callback に渡し、callback を呼ぶ前には Git discovery、shared cache の
作成、repository lease の取得を行わない。最初の shared slot access で layout を解決して repository-wide lease を
取得し、途中の `flush()`、remote I/O、callback 完了時の final flush を経て `finally` で解放するまで保持する。
callback が shared slot に触れない mock / validation-only path は Project Storage を通じて filesystem に触れない。

初版は `mode: "read"` と `mode: "write"` のどちらも同じ exclusive lease を使って直列化する。`mode` と `scope` は
書き込み可否と対象 slot を制限するが、reader の並行実行を許可するものではない。shared reader 同士を並行化する
reader/writer lease は、実際の contention と安全性を測定してから行う後続最適化とする。

lock owner record は host、pid、nonce、access、開始時刻を持つ。live owner または生死を判定できない owner の
lock は盗まない。同一 host で pid が存在しないことを確認でき、読み直した owner nonce が一致するときだけ
atomic recovery claim を取得して compare-and-recover する。他collectorのclaimが存在する場合は回収せず、claim取得後に
owner nonceが変わった場合もactive pathを変更しない。timeout は owner 情報を含む診断を返し、workspace-local cache
へfallbackしない。
解放時はnonce一致を確認したactive lock directoryをnonce固有のretired pathへatomic renameしてから削除し、
解放と次ownerの取得が競合しても新しいlockを再帰削除しない。callback内では即時の`process.exit()`を使わず、
`finally`によるlease解放を必ず通す。

### 明確な non-git fallback

Git adapter が「この root は Git repository ではない」と明確に判定した場合だけ、従来どおり
`<root>/.gantt-sync/` に全slotを置く。Git executable 不在、timeout、permission error、不正な出力、
common-dir 解決失敗は non-git と同一視せず fail-closed にする。これにより Git worktree 内の一時障害から
workspace-local cache が新設されることを防ぐ。

Git hook が export する `GIT_DIR`、`GIT_WORK_TREE` 等の repository 選択環境変数は、
`projectRoot` を正本として実行する Git subprocess へ継承しない。環境変数は `git -C <projectRoot>` より
優先され得るため、継承すると hook を起動した repository を誤って検出・操作する危険がある。

### Run Graph の扱い

Issue `#299` の repository lease と snapshot-set は Work Graph Cache のための統制であり、Graph Contract と
Run Graph event journal には適用しない。ADR-022 の Run Graph は #329 で entity version、claim、lease、
multi-process compare-and-append が実装・検証されるまで workspace-local を維持する。#329 完了後も共有化は
自動ではなく、accepted event lineage を壊さないことを確認する別の意思決定を必要とする。

## Alternatives

### 案A: callback scope を持つ一入口の `withProjectStorage`

公開 seam を一つにでき、最初の shared slot access から callback 終了までを lease 期間として強制できる。
shared slot に触れない callback は lazy のまま完了できる。caller は `root`、`read|write`、実行内容だけを
指定するため、remote I/O を含む scope から lock が抜けにくい。一方、
内部の保存対象と publish 規則を自由な path 操作のままにすると、slot ごとの配置判断が分散する。
このため公開 Interface と scope 規律を採用し、内部構造は案Bで補う。

### 案B: closed StorageSlot catalog と atomic snapshot-set

Work Graph Cache と workspace-local state のscope、Zod schema、atomic publish policyをclosed catalogに集約し、
tasks/sync-stateを一つのsnapshot-setとして扱える。これを公開catalogにするとcallerがslotやpathへ依存し、
案Aの小さいInterfaceを損なう。そのためcatalogとsnapshot-setはImplementation内だけに採用する。

### 案C: 既存 Store caller を維持する lazy resolver

`new TasksStore(root)`、`new SyncStateStore(root)` 等を維持し、各Storeが保存先を遅延解決する。
caller変更は小さいが、複数slotのread-modify-writeとremote I/Oを覆うleaseはStore単体では表せない。
各CLI commandとHTTP requestに別途lease適用を要求すると、適用漏れが型とInterfaceの外に残り、
単一writer保証を破れるため採用しない。

### 採用: 案A+B hybrid

案Aの`withProjectStorage`だけを公開し、そのImplementationに案Bのclosed catalog、配置解決、migration、
snapshot-set、repository leaseを置く。これによりlease期間をcallerのcallback scopeとして強制しながら、
StorageSlot追加時の変更をmodule内へ局所化する。案Cのcaller互換性より、lease適用漏れを構造的に防ぐことを優先する。

## Consequences

- linked worktree ごとの pull と別々の merge base を減らし、同じ Work Graph Cache を参照できる。
- 既存の Store 直接生成 caller は `withProjectStorage` callback へ移行した。新しい caller もこの一入口を使い、
  repository lease の適用漏れを防ぐ。
- mutating caller は型付きStoreのwrite後に`flush()`を完了してから成功結果を返し、publish失敗時に成功ログや
  HTTP成功応答を先行させない。shared cacheとworkspace journalを同じ操作で更新する`loop complete`は`all`を使う。
- tasks/sync-state の中途半端な世代は `CURRENT` から参照されず、process crash 後も旧世代を読める。
- 長い remote I/O は read/write 共通の exclusive repository lease を長時間保持し、別worktreeを待たせる。
  整合性を優先し、shared reader の並行化と optimistic concurrency は別の意思決定とする。
- 初回migrationでlegacy候補が一致しないrepositoryは fail-closed で停止する。operator が
  `storage migrate --from` で正本を明示した場合だけ共有 generation を更新するため、誤った候補を選ばない
  運用上の確認が必要になる。
- orphan generation の回収、network filesystem の分散lock、旧CLIとのdual-writeは別課題とする。
- 現在の regression は、実 Git linked worktree の共有 / 非共有配置、non-git fallback、legacy migration の
  一致・分岐・欠損・破損・破損comments・別Projectの不完全pair・移行後変更、publish 前 callback 失敗、
  live / dead / 生死判定不能 owner、
  同一process内の別process identity、真の別 OS process による lease 直列化、明示的 migration、
  shared slot 非接触 callback の filesystem 非接触、Git hook の repository 選択環境変数からの分離、
  linked worktree から追加 pull なしで実行する `status`、CLI の `pull` / `push` を検証する。
  linked worktree と CLI process は実物だが、GitHub transport は mock、`push` は dry-run であり、
  remote write を伴う end-to-end smoke は未検証である。
