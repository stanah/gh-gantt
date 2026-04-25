---
id: ADR-003
title: git ライクな pull/push/conflict モデルの採用
date: 2026-02-09
status: accepted
related_requirements:
  - FR-SYNC-002
  - FR-SYNC-003
---

## Context

GitHub Projects との同期方式を決定する必要がある。ユーザーは開発者であり、
AI エージェントも CLI で操作する。馴染みのあるメンタルモデルが望ましい。

## Decision

git のワークフローを模倣した pull/push/conflict resolve モデルを採用。
ローカルデータを .gantt-sync/ に保持し、明示的な pull/push で同期する。

## Alternatives

### リアルタイム自動同期

オフライン作業ができない。衝突の自動解決が困難

### Web UI 経由の直接操作

CLI ファーストの原則に反する。AI エージェントが操作できない

### GitHub API 直接呼び出し

レートリミット・認証の複雑さ。ローカルにデータがないためコンテキスト回復ができない

## Consequences

- .gantt-sync/ ディレクトリにローカルデータを永続化
- pull → 作業 → push の明示的なサイクルをユーザーに要求
- コンフリクト解決のための CLI コマンドが必要
