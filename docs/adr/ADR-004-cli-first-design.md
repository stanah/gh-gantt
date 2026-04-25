---
id: ADR-004
title: CLI ファースト設計
date: 2026-02-09
status: accepted
related_requirements:
  - FR-CLI-006
---

## Context

gh-gantt は AI エージェント (Claude Code 等) と人間の両方が使うツール。
Web UI だけでは AI エージェントが操作できない。

## Decision

すべての操作を CLI で完結させる。Web UI は可視化専用とし、
操作は API 経由で CLI と同じバックエンドを共有する。

## Alternatives

### Web UI ファースト

AI エージェントが操作できない。自動化も困難

### API ファースト (CLI なし)

ターミナルでの操作性が悪い。セッション間のコンテキスト回復に不便

## Consequences

- Commander.js による CLI コマンド体系の構築が必要
- Web UI は読み取り専用 + API 経由の操作に限定
- AI エージェントと人間が同じコマンドを共有
