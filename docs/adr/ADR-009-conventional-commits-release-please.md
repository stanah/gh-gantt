---
id: ADR-009
title: Conventional Commits と release-please による統一バージョニング
date: 2026-04-11
status: accepted
---

## Context

モノレポ (packages/cli, packages/shared, packages/ui) のバージョニングと
リリース規律が存在しない状態だった。全パッケージの package.json は初期値
0.1.0 のままで、git タグも CHANGELOG も存在せず、「前に動いていた動作に
戻る」「このバージョンで何が変わったか確認する」ことができなかった。
コミットメッセージには conventional commits 互換の prefix (fix(sync):,
feat(harness): 等) と非互換のブラケット記法 ([E-1] 等) が混在しており、
自動化ツールを導入するには統一が必要だった。

## Decision

Google 製の release-please を GitHub Actions に導入し、conventional commits
から自動で CHANGELOG 生成・Release PR 作成・タグ打ちを行う。

- バージョニング戦略: 3 パッケージ (cli / shared / ui) を統一バージョンで
  同期する (例: すべて v0.2.0)
- コミットメッセージ: Conventional Commits を厳密化し、commitlint と
  pre-commit フックで強制する
- 既存のブラケット記法 ([E-1] 等) は feat(harness): ... (E-1) のように
  body または scope に移行する
- npm 公開は行わず、GitHub タグと CHANGELOG のみを生成する

各 Phase の完了時点でマイナーバージョンを上げ、Milestone も Version 単位で
作成する (v0.1.0-alpha, v0.1.0, v0.2.0, v0.3.0, v0.4.0+)。

## Alternatives

### パッケージごとに独立バージョニング (cli@0.2.0 と shared@0.5.0 等)

shared の型変更は必ず cli と ui に波及する密結合な構造であり、
独立バージョニングは「どの組み合わせで動作確認されているか」を複雑にする。
安定性最優先の方針と相性が悪い。

### npm registry に公開する

対象ユーザーが本人 + AI エージェントに限定されており (ADR-007 参照)、
npm 公開はメンテナンスコスト (バージョン戦略、deprecation 対応、
scope 取得等) を増やすだけで見合わない。将来 OSS 化する際に再検討する。

### Changesets (monorepo 向けバージョニングツール)

Changesets はパッケージ独立バージョニング前提の設計で、統一バージョン
戦略と相性が悪い。release-please の方がシンプル。

### 手動でバージョンとタグを管理する

個人プロジェクトでは「やらなくなる」未来が見えている。
自動化されていない規律は持続しない。

### Conventional Commits を強制せず緩く運用する

release-please は conventional commits を前提としており、混在させると
自動化の穴が生まれる。厳密化しないなら release-please を入れる意味がない。

## Consequences

- commitlint と pre-commit フック (lefthook) の初期セットアップが必要
- 既存のブラケット記法に慣れていた場合、移行期に戸惑いが生じる可能性がある
- release-please は PR ベースで動くため、Release PR のマージを忘れると リリースが進まない (月末レビュー儀式でチェックする)
- v0.x 系では破壊的変更がマイナーバージョンで入る可能性がある (SemVer の pre-1.0 規約に従う)
- npm 公開していないため、他者が使うには git clone + pnpm link が必要
- Phase 1 の完了時に v0.1.0-alpha を初回リリースとして打ち、以降は release-please の自動フローに乗せる
