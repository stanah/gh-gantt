---
id: ADR-012
title: Living Documentation 4 層体系の採用
date: 2026-04-26
status: accepted
---

## Context

gh-gantt は CLI ファースト (ADR-004) かつ AI エージェント協調を前提とした
プロジェクトであり、要件・意思決定・実装・テストの間にドリフトが生じると
エージェントが誤った前提で動作するリスクが高い。手書きのドキュメント
(README / 設計メモ等) は時間経過とともに実態と乖離することが避けられない。

Cyrille Martraire の Living Documentation (2019) は「コードとテストが正典で、
手書きドキュメントは Evergreen な要件と不変の意思決定に限定する」原則を
提示しており、この方向性が gh-gantt の安定性ロードマップ (ADR-007) と整合する。

具体的に必要だったもの:

- 振る舞い要件の正典 (どこに書くか / どのフォーマットか)
- 意思決定の長期的記録 (なぜそうしたか + 何を却下したか)
- API リファレンスの自動生成 (手書きとコードのずれを防ぐ)
- テストと要件の双方向トレーサビリティ

## Decision

以下 4 層からなる Living Documentation 体系を採用する。

### Layer 1: Evergreen 要件 (`docs/requirements.yaml`)

- **形式**: 単一 YAML ファイル
- **構造**: `areas[] -> requirements[] -> acceptance_criteria[]`
- **ID 体系**: `{prefix}-{AREA}-{NNN}-AC{N}`
  - prefix: `FR` (機能要件) / `NFR` (非機能要件)
  - AREA: `SYNC` / `HIER` / `VIS` / `CLI` / `API` / `STORE` / `STABILITY`
  - NNN: 領域内通し番号 (3桁ゼロパディング不要、連番)
  - N: AC の連番 (1 から)
- **更新規則**: AC は `description` / `status` / `tests` の 3 フィールドを持ち、`status` と `tests` は Layer 4 のスクリプトで自動更新

### Layer 2: ADR (`docs/adr/ADR-NNN-<slug>.md`)

- **形式**: Markdown + YAML frontmatter (PR #184 で YAML 単体から移行)
- **frontmatter**: `id` / `title` / `date` / `status` / `related_requirements?`
- **body 固定 4 セクション**: `## Context` / `## Decision` / `## Alternatives` / `## Consequences`
- **`## Alternatives`**: 各代替案を `### <name>` サブ見出しにし、却下理由を本文に書く (Martraire「rationale は却下された選択肢にこそある」)

### Layer 3: 自動生成ドキュメント (`docs/generated/`、gitignore 済み)

- **OpenAPI**: Zod スキーマ (ADR-002) から `pnpm docs:gen` で生成
- **TypeDoc**: TypeScript ソースから生成
- **規約**: 生成物は git 管理しない。CI / lefthook の `docs:gen` ステップで毎回再生成

### Layer 4: Tests as Requirements

- **テスト名規約**: 要件トレーサビリティテストの `describe` に `[FR-*]` / `[NFR-*]` プレフィックスを付与
- **Reconciliation**: `pnpm req:trace` が Vitest JSON レポートを走査し、`requirements.yaml` の `status` (`covered` / `uncovered` / `failing`) と `tests[]` を自動更新
- **整合性検証**: `pnpm req:validate` が「テストにあるが requirements.yaml に無い ID」「ADR の `related_requirements` がスタイル」等を検出
- **CI 強制**: ADR-010 の三層ワークフローガードにより、pre-push および CI で `req:trace` 後の `git diff --exit-code docs/requirements.yaml` で陳腐化を検出

### スコープ外

- 全ユニットテストへのプレフィックス強制は **しない** (粒度が細かい unit テストはコストに見合わない)。トレーサビリティが必要な振る舞いテストのみに限定する。
- `docs/superpowers/{specs,plans}/` 等の AI ブレインストーミング由来文書は Layer 2 ADR に意思決定を抽出した時点で throwaway とし、git 管理外。

## Alternatives

### 手書きドキュメントを維持する (README / docs/ 散文)

短期的には書きやすいが、コード変更時に追従されず数ヶ月で実態と乖離する。
AI エージェントが古い記述を信じて誤動作する事故が起きやすい。Living
Documentation 原則そのものに反する。

### 全テストにプレフィックスを強制する

unit / integration / e2e すべてに `[ID]` を付ければ完全なトレーサビリティが
得られるが、unit テストは「振る舞い」より「実装詳細」を検証することが多く、
ID を 1 対 1 で割り当てる行為自体に意味がない。執筆コストの割に得られる
ROI が低い。振る舞いに紐づくテストのみ ID を付与する方針とした。

### ADR を YAML 単体で書く

PR #183 まではこの方針だったが、GitHub 上での可読性が低く、context /
decision / consequences に Markdown の表現力 (見出し・箇条書き・リンク) を
活かせない。PR #184 で frontmatter 付き Markdown に移行 (Martraire MADR
慣例にも準拠)。本 ADR では Markdown + frontmatter を正式採用とする。

### 振る舞い詳細を要件 YAML に詳細記述する

「何を満たすべきか」だけでなく「どう実装するか」「どのコードパスで」まで
書き込む案。要件ファイルが肥大化し chatty になり、コード変更で頻繁に
書き換える必要が生じてドリフト源になる。要件は「振る舞いの契約」のみに
留め、実装詳細はコードとテストに委ねる。

## Consequences

- ADR-010 の三層ガードに `req:trace` / `req:validate` / `docs:gen` の pre-push 実行が組み込まれており、本体系の維持が自動強制される
- スクリプト 3 本 (`scripts/req-trace.ts` / `req-validate.ts` / `docs-gen.ts`) のメンテナンスが継続的に必要
- テスト名規約への学習コストが新規開発者に発生する (`gh-gantt-living-documentation` skill で文書化済み)
- 新規 area コードの追加には合意形成が必要 (野放図に増やすと ID 体系が崩れる)
- `docs/generated/` を git 管理外とすることで PR diff から自動生成物のノイズを排除できる
- 過去の AI ブレインストーミング由来 spec / plan は本 ADR で意思決定を吸収した時点で git untrack 対象 (本 PR で実施)
