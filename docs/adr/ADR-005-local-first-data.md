---
id: ADR-005
title: ローカルファーストのデータ管理
date: 2026-02-09
status: accepted
related_requirements:
  - FR-STORE-001
  - FR-STORE-002
---

## Context

AI エージェントはセッション間でコンテキストを失う。
プロジェクトの現在地を素早く把握する手段が必要。

## Decision

プロジェクトデータを .gantt-sync/ にローカル保持する。
gh-gantt status や gh-gantt list で API コールなしにプロジェクト状態を参照できる。

## Alternatives

### 毎回 API から取得

ネットワーク接続が必須。レートリミット。コンテキスト回復が遅い

### データベース (SQLite 等)

JSON ファイルの方がデバッグしやすく、git で差分が見える

## Consequences

- .gantt-sync/ ディレクトリの管理 (.gitignore に追加)
- tasks.json, sync-state.json, gantt.config.json のファイル形式を定義
- オフライン状態でもリード操作が可能
