---
id: ADR-001
title: 同期エンジンに 3-way merge を採用
date: 2026-03-20
status: accepted
related_requirements:
  - FR-SYNC-001
  - NFR-SYNC-001
---

## Context

GitHub Projects (V2) との双方向同期において、ローカルとリモートの
変更が衝突する場合の解決戦略が必要。オフライン作業を重視するため、
ローカル変更を安全に保護しつつ衝突を検出する仕組みが求められた。

## Decision

Git の 3-way merge モデルを採用。per-task の base snapshot を保持し、
local diff と remote diff をフィールド単位で比較してコンフリクトを検出する。
コンフリクトはマーカーとしてタスクデータに埋め込み、ユーザーに解決を委ねる。

## Alternatives

### Last Write Wins

データ消失のリスクが高く、オフライン作業の価値が失われる

### Remote Always Wins

ローカルでの編集が上書きされ、CLI ファーストの原則に反する

### 2-way diff (base なし)

base がないため変更意図の判別が不可能。全差分がコンフリクト候補になる

## Consequences

- sync-state.json に per-task snapshot (syncFields + hash) の保持が必要
- push/pull 両方で diff 計算のコストが発生するが、フィールド単位のため軽量
- コンフリクトマーカーの形式を定義し、検出・解決の CLI コマンドが必要
