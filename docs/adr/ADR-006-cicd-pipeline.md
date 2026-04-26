---
id: ADR-006
title: vite-plus ベースの CI/CD パイプライン
date: 2026-03-23
status: accepted
---

## Context

モノレポのビルド・テスト・リントを統合的に管理する CI パイプラインが必要。
vite-plus (vp) がビルドツールとして採用されている前提。

## Decision

GitHub Actions で vp CLI を直接使用する。
ci ジョブ (lint + type + build + test) と e2e ジョブ (Playwright) を分離。
e2e は main ブランチのみで実行し、ci の成功を前提とする。

## Alternatives

### 各ツール個別実行

vp check が lint + format + type を統合しており、個別実行は冗長

### E2E を全ブランチで実行

実行時間が長い (15 分)。PR では unit test で十分

## Consequences

- vp のバージョンアップが CI に直接影響する
- E2E テストの失敗は main ブランチでのみ検出される
