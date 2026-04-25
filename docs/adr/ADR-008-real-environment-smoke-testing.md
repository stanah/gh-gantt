---
id: ADR-008
title: 実環境スモークテストによる Org/個人環境差異の検証
date: 2026-04-11
status: accepted
related_requirements:
  - NFR-STABILITY-003
  - NFR-STABILITY-004
---

## Context

GitHub Projects V2 には Org 限定機能 (Issue Types ベータ) と個人リポジトリで
の代替 (Labels フォールバック) があり、同一コードベースで両環境をサポート
する必要がある。過去にこの分岐領域で複数回バグが発生しており
(init の Discovery ロジック、sub-issue 設定時の Priority 衝突 #146, #148,
issue_node_id 欠損時の silent skip #153 等)、環境差異を継続的に検証する
仕組みがなければ同種のバグが再発し続ける構造にあった。
既存テストはユニットテスト中心で、実際の GitHub GraphQL レスポンスに対する
検証が欠如していた。特に REST API (FR-API-001..003) は全てカバレッジゼロ。

## Decision

GraphQL レスポンスのフィクスチャテストは採用せず、実環境スモークテストを
主軸とする。以下の 2 系統のテスト基盤を構築する。

- 個人環境: stanah/gh-gantt-e2e-test + users/stanah/projects/4 (既存流用)
- Org 環境: gh-gantt-e2e Organization を新規作成 (GitHub Free)
  - test-repo + Org Project V2 (Issue Types 有効化)

認証は GitHub App を採用し、Org にインストールする。PAT は使わない。
スモークテストはローカルからも CI からも実行可能な二系統のエントリポイント
(pnpm smoke:personal / smoke:org) を持ち、CI では以下の頻度で実行する。

- PR ごと: 個人環境のみ
- main マージ後: 個人 + Org 両方
- 月次 cron: 個人 + Org 両方

最初に実装するシナリオは Tier 1 の最小セット (init → pull → スナップショット
比較) に限定し、副作用のある操作 (create, push) は Tier 2 以降で段階的に
追加する。スナップショット比較時の環境依存フィールド (Project ID,
Custom Field Option ID, last_synced_at) は smoke test スクリプト側の
正規化レイヤーで除外し、本体コマンドにテスト専用フラグは入れない。

関連コマンドとして gh-gantt doctor (read-only な健全性チェック) を実装し、
セルフホスティングしている gh-gantt 自身のプロジェクトに対して日常的に
実行できる継続検証の仕組みとする。

## Alternatives

### GraphQL レスポンスをフィクスチャ化してユニットテストで検証

決定的で高速だが、実環境との乖離が避けられない。GitHub は Issue Types
ベータ等のスキーマを継続的に更新しており、フィクスチャを手動で追従させる
運用は持続不可能。フィクスチャが古くなってもテストは通るため、
「テストは緑なのに実環境で壊れる」という最悪の状況を生む。

### リリース前の手動 QA チェックリスト

個人 + AI エージェント主体の開発では「やらなくなる」未来が見えている。
規律はツールで強制しないと持続しない。

### 既存プロジェクトに対する破壊的 E2E テスト

rate limit と race condition で不安定になりやすく、壊れたテストが
壊れていないバグを隠す温床になる。セルフホスティングしているプロジェクト
自体を壊すリスクも許容できない。

### 認証に PAT (Personal Access Token) を使う

有効期限管理が面倒で、漏洩時のリスクが個人アカウント全体に及ぶ。
GitHub App なら Org 限定のスコープで権限を絞れる。

## Consequences

- Org と個人の 2 系統のテスト基盤を維持する必要がある (運用コスト増)
- GitHub GraphQL API の rate limit を考慮したスケジューリングが必要
- スモークテストが flaky 化するリスクがあり、早期に flaky 検出ロジックの 導入が必要 (Phase 2 で対応)
- GitHub App の作成とインストール、secrets 管理の初期セットアップが必要
- gh-gantt doctor コマンドが「日常的に回す継続検証ツール」として機能し、 セルフホスティングの利点を最大化できる
- Tier 1 のみでは push 経路が検証されないため、Phase 2 以降で Tier 2 (create → push → pull の round-trip) を段階的に追加する必要がある
