---
id: ADR-029
title: config / workflow / journal の配置を repository モードと git モードから選べるようにする
date: 2026-09-09
status: accepted
related_requirements:
  - FR-STORE-004
  - FR-STORE-005
  - NFR-STABILITY-015
---

## Context

ADR-023 は Work Graph Cache（`tasks.json`、`sync-state.json`、`comments.json`）を git-common-dir 配下へ移し、config、workflow、outer loop journal、Run Graph は workspace-local の `<worktree>/.gantt-sync/` に残した。
この配置では `gantt.config.json` と `workflow.md` を commit することが linked worktree 間で設定を共有する唯一の手段になる（ADR-018）。

設定をリポジトリで管理したくないプロジェクトには二つの負担が残る。
`.gantt-sync/` を `.gitignore` に追加しなければ未追跡 file として現れ続ける。
config を commit しないと linked worktree ごとに `init` をやり直すか、手で copy する必要がある。

一方で、既存プロジェクトは `.gantt-sync/` に config を置いて運用しており、これを壊さずに選択肢を増やす必要がある。

## Decision

### 二つの配置モード

workspace slot（`config`、`workflow`、`loop-state`、`graph-contracts`、`run-graph`）の配置モードを `repository` と `git` の二つから選ぶ。
Work Graph Cache の配置と repository lease は ADR-023 のまま変えない。

| モード       | config / workflow                                 | loop-state / Run Graph                                    | commit 対象      |
| ------------ | ------------------------------------------------- | --------------------------------------------------------- | ---------------- |
| `repository` | `<worktree>/.gantt-sync/`                         | `<worktree>/.gantt-sync/`                                 | config, workflow |
| `git`        | `<git-common-dir>/gh-gantt/config/v1/<root-key>/` | `<git-common-dir>/gh-gantt/workspaces/v1/<worktree-key>/` | なし             |

`root-key` は toplevel から見た project root の相対 path の fingerprint、`worktree-key` は正準化した worktree path の fingerprint とし、identity を path へ直接露出しない（ADR-023 と同じ規則）。
`git` モードでは同じ repository の全 linked worktree が同じ config と workflow を参照する。
loop-state と Run Graph は worktree 単位の観測レイヤーという性質（ADR-018、ADR-022）を保つため、`git` モードでも worktree ごとに namespace を分ける。
`git` モードは `.gantt-sync/` を作らず、`.gitignore` の変更も要らない。

### 解決順序

配置モードは `withProjectStorage` の内部で次の順に解決し、caller は path を組み立てない。

1. Git repository でなければ `repository`。`git` モードの明示指定は `STORAGE_MODE_UNSUPPORTED` で停止する。
2. `<worktree>/.gantt-sync/gantt.config.json` と `git` モードの `gantt.config.json` の存在を調べる。片方だけがあればそのモードを使う。
3. 両方があれば `STORAGE_MODE_AMBIGUOUS` で停止し、両方の path と「正本でない方を削除する」解消手順を表示する。
4. どちらも無ければ明示指定（`init --storage`）に従い、無指定なら後方互換の `repository` にする。
5. 明示指定が既存 config のモードと食い違えば `STORAGE_MODE_MISMATCH` で停止し、`storage migrate --to` へ誘導する。

判定に使うのは config の存在だけとし、`.gantt-sync/` に残った legacy cache や journal は判定に含めない。
legacy cache は ADR-023 の migration manifest と fingerprint で引き続き監視する。
`git` モードで worktree に config が無い legacy pair は、共有 config の identity で照合する。

### 移行

`gh-gantt init --storage <repository|git>` で新規プロジェクトのモードを選ぶ。
既存プロジェクトは `gh-gantt storage migrate --to <mode>` で config、workflow、現在の worktree の loop-state と Run Graph を移す。
移行は repository lease の中で行い、移行先に同名 file があれば `STORAGE_RELOCATION_CONFLICT` で停止する。
移行元、移行先、移した slot は migration manifest の `storageRelocations` に追記し、ADR-023 の legacy fingerprint とは別の履歴として残す。
`gh-gantt storage status` は解決したモードと path を表示する。

### `withProjectStorage` を通らない store の扱い

Run Graph の `GraphContractStore` と `RunGraphEventStore`、および claim / proposal の identity resolver は `withProjectStorage` を通らない。
これらは Project Storage が公開する `resolveWorkspaceStorageLocation` で同じ解決順序に従い、journal と config の path を自前で組み立てない。
lease は取得しないため、ADR-023 の lease 規律は変わらない。

## Alternatives

### `.gantt-sync/` を `.gitignore` に追加するだけにする

リポジトリに何も追加しないという要件は満たすが、config を linked worktree 間で共有できず、worktree ごとに `init` が必要になる。
git-common-dir を共有点にする ADR-023 の方針と整合しないため採用しない。

### config を Work Graph Cache の namespace に置く

namespace は config から導く GitHub Project identity で決まるため、config 自身をその中に置くと identity を解決できない。
config は identity に依存しない `config/v1/<root-key>/` に置き、Work Graph Cache とは別の階層にする。

### 曖昧な場合に新しい方を優先する

更新時刻で自動選択すると、旧 CLI や手動 copy で更新された側を正本と誤認しうる。
ADR-023 の legacy migration と同じく fail-closed にし、operator に解消させる。

### journal も全 worktree で共有する

loop-state と Run Graph を共有すると、worktree ごとの観測履歴と accepted event lineage が混ざる。
ADR-023 の「Run Graph の扱い」を維持し、`git` モードでも worktree 単位に分ける。

## Consequences

- 既存プロジェクトは `.gantt-sync/gantt.config.json` があれば従来どおり `repository` モードで動き、挙動は変わらない。
- config 読み込みは workspace-only の caller でも Git discovery を伴うようになる。toplevel / common-dir / worktree 一覧は root ごとに cache し（#353、#355）、shared slot に触れない callback は従来どおり discovery を行わない。
- `git` モードでは config が commit されないため、エフェメラル環境では `init --storage git` で GitHub Project から再生成するか、config を別経路で持ち込む必要がある。手順は AGENTS.md に記載する。
- 直接 `ConfigStore(projectRoot)` を生成していた command（sprint、doctor、resolve、delete、API server、init）は `withProjectStorage` へ移行した。新しい caller も同じ入口を使う。
- regression は、`git` モードでの config 共有と journal 分離、`.gantt-sync/` 非作成、両モード config の fail-closed、後方互換の `repository` 解決、non-git の制約、`storage migrate --to` の往復と manifest 記録を実 Git linked worktree で検証する。
- 移行済み legacy file の掃除は `storage cleanup`（#378）で行い、判定規則は ADR-023 の all-worktree legacy migration 節に追記した。
