---
id: ADR-002
title: ファイル読み込み時に Zod バリデーションを必須化
date: 2026-02-09
status: accepted
related_requirements:
  - NFR-STORE-001
---

## Context

.gantt-sync/ 配下の JSON ファイル (tasks.json, sync-state.json, gantt.config.json) は
ユーザーが手動編集する可能性があり、外部からの push でも変更される。
不正なデータがランタイムに混入するとサイレントな不整合を引き起こす。

## Decision

すべてのファイル読み込みに Zod スキーマによるバリデーションを適用する。
@gh-gantt/shared にスキーマを集約し、CLI と UI の両方で共有する。

## Alternatives

### TypeScript の型アサーションのみ

ランタイムでの検証がなく、不正データを検出できない

### JSON Schema

TypeScript の型定義との二重管理になる。Zod は型推論と一体

### io-ts

Zod の方が API がシンプルでエコシステムが充実している

## Consequences

- @gh-gantt/shared に zod 依存が追加
- ファイル読み込み時のエラーメッセージが構造化される
- スキーマ変更が型変更と同時に行われることが保証される
