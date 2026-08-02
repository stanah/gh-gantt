# 開発ワークフロー（gh-gantt プロジェクト）

## 作業開始

1. タスクのステータスを作業中に更新する
2. フィーチャーブランチを作成する: `git checkout -b feat/issue-<number>-<description> main`

## タスク化

**ゲート:** 選択したタスクがそのまま着手可能な場合はスキップ可

- タスクの粒度が適切で、作業内容が明確
- 追加の分解や子タスク作成が不要

1. タスクの要件を確認し、作業範囲を明確にする
2. 必要であれば作業単位に分解し、子タスクとして作成する
3. 既存タスクとの重複・矛盾がないか確認する

## 設計

**ゲート:** 以下に該当する場合はスキップ可

- バグ修正で原因が明確
- 既存パターンの踏襲で設計判断が不要
- 文言修正・設定変更など、影響範囲が自明

1. `superpowers:brainstorming` で要件を明確化し、設計をまとめる
2. `superpowers:writing-plans` で実装計画を作成する

## 開発

1. `superpowers:test-driven-development` に従って実装する
2. こまめにコミットし、リモートに push する

検証コマンド: `pnpm typecheck && pnpm test && pnpm build`

## 完了

1. `superpowers:verification-before-completion` で検証する
2. Pull Request を作成する（description に `Closes #<number>` を記載）
3. レビュー指摘は精査してから対応し、同じ PR に追加コミットする
4. CI 通過・レビュー承認後、PR をマージする

## Living Documentation

このプロジェクトは Living Documentation (Cyrille Martraire) 体系で要件・ADR・テストのトレーサビリティを管理する。運用手順は `gh-gantt-living-documentation` スキルを参照すること。以下はプロジェクト固有の設定：

- **要件ファイル**: `docs/requirements.yaml`
- **ADR ディレクトリ**: `docs/adr/`（Markdown + frontmatter, `ADR-NNN-slug.md`）
- **機能領域コード**: `SYNC`, `HIER`, `VIS`, `CLI`, `API`, `STORE`, `STABILITY`
- **言語**: 日本語（`description` フィールドとテスト名は日本語、ID プレフィックスは英語）
- **スクリプト**:
  - テスト (JSON reporter): `pnpm run test:json`
  - Reconciliation: `pnpm run req:trace`
  - 整合性検証: `pnpm run req:validate`
  - 自動生成ドキュメント: `pnpm run docs:gen`
- **自動生成物の出力先**: `docs/generated/`（gitignore 済み、CI で毎回生成）
- **設計仕様**: `docs/adr/ADR-012-living-documentation-four-layer-system.md`

振る舞い変更を伴う開発では、Issue 作成時または実装中に `gh-gantt-living-documentation` スキルを invoke して、要件 AC の追加とテスト名への `[ID]` 付与を行うこと。

## Graph Contract

正典は`docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md`とする。

- **基盤 (#327)**: plan_id、plan_version、authority binding値のないunversioned provisional projectionとして、外部orchestratorが`.dev-flow`のJSON/schema/manual gateを運用した。製品はeventを受理しなかった。
- **現行 (#328)**: 製品control planeがversion bindingとeventを検証・受理する。外部runnerはexecutionだけを担う。
- **binding**: `.gantt-sync/gantt.config.json` の次の値を exact binding とする。

```yaml
plan_id: dev-role-fixed
plan_version: "1"
schema_version: "1"
```

- **control plane**: gh-gantt が binding、stable ID、transition、budget、authority、human gate、checkpoint、event 重複を検証する。
- **execution plane**: 外部 runner は次の CLI contract で結果を返し、provider SDK・agent subprocess・任意 shell executor は gh-gantt に内蔵しない。

```bash
gh-gantt run start --issue <issue> --event-id <id> --actor <actor> --json
gh-gantt run event <run-id> --file <event.json> --json
gh-gantt run show <run-id> --json
gh-gantt run resume <run-id> --event-id <id> --actor <actor> --checkpoint <artifact-id> --evidence <evidence-id> --side-effect-state <not_started|committed|reconciled|unknown> --json
gh-gantt run decide <run-id> --event-id <id> --actor <human> --decision <approved|rejected|override> --evidence-id <id> --json
gh-gantt run observe-pr <run-id> --repository <owner/repo> --number <pr> --event-id <id> --actor <orchestrator> --evidence-id <id> --json
```

`run show` が `human_gate_required` を返した場合、外部 runner は停止する。human authority の承認または
Graph Contract が許可した edge への理由・evidence 付き override だけが再開を許可する。
resume は外部副作用の状態を必須入力とし、`unknown` は自動再開しない。`committed` / `reconciled` は
`side_effect_reconciliation` evidence なしに受理しない。
外部 runner 用 `run event` は `human_decision` と `pr_observed` を受理しない。human decision は
専用 `run decide`、PR 状態は GitHub GraphQL から live state を取得する `run observe-pr` だけを使用する。
`run observe-pr` は live `closingIssuesReferences` で Run 対象 Issue への exact linkage を確認し、
未結線または取得不完全の PR では Run を完了しない。

## Bounded dispatch

この repository は `.gantt-sync/gantt.config.json` の `dispatch.max_concurrency` を global 上限、
`dispatch.state_concurrency` と `dispatch.repository_concurrency` を追加上限として使う。
gh-gantt は次の lifecycle を control plane の公開 CLI contract として提供する。

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
11. accepted outcome event、release、reclaim の後は共有 Work Graph Cache を読み直し、dependency を再評価して fan-in を解く。全 upstream task が完了した downstream task だけを次の dispatch 対象にする。

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

## Dev-Role Config

`gh-gantt-dev-role` スキル用の設定。orchestrator / planner / implementer / executor / reviewer の各ロールが参照する。

```yaml
verifyCommands:
  - "pnpm typecheck"
  - "pnpm lint"
  - "pnpm test:json"
  - "pnpm build"
  - "pnpm req:trace"
  - "git diff --exit-code docs/requirements.yaml"
  - "pnpm req:validate"
  - "pnpm docs:gen"
scratchpadDir: ".dev-flow"
maxImprovementIterations: 3
maxExecutorRetries: 2
branchNaming: "feat/issue-{number}-{slug}"
prCreator: "gh pr create"
allowImplementerCommit: true
```

- `verifyCommands` は CI / pre-push の検査を包含し、`typecheck` / `lint` も加えた PR 前 gate
- `scratchpadDir` (`.dev-flow/`) は gitignore 済み — role の中間 artifact はコミットしない
- `allowImplementerCommit: true` で implementer がコミット可 (lefthook の pre-commit が一段ガードする)

## Red Flags

| やってはいけないこと               | 理由                         |
| ---------------------------------- | ---------------------------- |
| 設計せずに実装を始める             | 手戻りが発生する             |
| テストを後回しにする               | TDD の意味がなくなる         |
| レビュー指摘を別 Issue にする      | レビュー修正は既存 PR の一部 |
| CLI の --help を確認せずに作業する | 既存機能を見落とす           |
| 要望を直接コード修正で対応する     | まず Issue を作成する        |
