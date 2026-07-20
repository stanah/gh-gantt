---
id: ADR-020
title: agent workflow の既定 scope を bounded にする
date: 2026-07-21
status: accepted
related_requirements:
  - NFR-STABILITY-005
  - NFR-STABILITY-012
---

## Context

タスク本文を含む全 open task やリポジトリの全 open PR を既定でモデルへ渡す契約は、
規模に比例して context budget を消費し、現在タスクからの scope drift を招く。
一方、件数と識別情報を残さず要約するだけでは、候補選定の証跡が失われる。

## Decision

- task 一覧は tool 境界で bounded projection し、task ごとに `id`, `github_issue`,
  `title`, `status`, `state` だけを出力する。証跡には `total`, `limit`, `truncated`,
  `tasks` を含め、既定 limit は 50 件とする。
- task body は search / filter / ユーザー選択で候補を絞り込んだ後に取得する。
  body を含む exhaustive export はユーザーの明示的な opt-in に限定する。
- PR 作成後・push 後・完了報告前の既定 scope は現在タスクの PR とする。
  repository-wide `--all-open` audit はユーザーの明示的な opt-in に限定する。
- 既知の単一タスクの状態補正は Issue の受入基準と関連 commit / diff に限定できる。
  横断的な閉じ忘れ監査では、従来どおりユーザーとコミット範囲を合意する。

本 ADR は ADR-013 の **scope-selection だけを supersede** する。PR review の検出項目、
quiet window、stable samples、GraphQL による返信・resolve、製品 CLI に review 操作を
追加しない責務境界は ADR-013 の決定を維持する。

## Alternatives

### 製品 CLI に projection / limit を実装する

`gh-gantt list` 自体に agent 専用の projection と context limit を追加する案。
製品 CLI の JSON は task データを扱う汎用 API であり、モデルコンテキストの予算管理は
agent workflow の責務である。CLI の後方互換性と利用者向け surface を増やすため採用しない。

### skill 内で要約だけを指示する

helper を設けず、agent に一覧の要約と省略を散文で指示する案。出力フィールド、limit、
`total`、`truncated` が実行ごとに揺れ、body が混入しても機械的に検出できない。
決定論的な証跡を作れないため採用しない。

### repository-wide `--all-open` を既定のまま維持する

別 PR の見落としを避けるため、セッション開始時と完了報告前に常に全 open PR を監査する案。
現在タスクと無関係な PR の件数に応じて待機時間と context が増え、scope drift を再発させる。
全体監査は明示的な opt-in で残せるため、既定としては採用しない。

## Consequences

- 証跡性を保ちながら、一覧件数や本文サイズにモデルコンテキストが比例しなくなる。
- `truncated: true` の場合、利用者は filter を追加するか exhaustive audit を明示する必要がある。
- `pr-review-cycle-wait.sh` の `--all-open` mode 自体は削除せず、明示的な監査に利用できる。
