---
id: ADR-007
title: 安定性を最優先とする Phase ベースのロードマップ設計
date: 2026-04-11
status: accepted
related_requirements:
  - NFR-STABILITY-001
  - NFR-STABILITY-002
---

## Context

プロジェクトが成熟するにつれ、同期エンジン周辺で環境差異由来のバグ
(Org/個人環境の Issue Types vs Labels フォールバック等) や silent failure
(エラーを握りつぶすスキップ) が繰り返し発生していた。
機能追加を優先すると安定性負債が累積し、AI エージェントが信頼して
操作できないツールになる懸念があった。
同時に、どのバージョンが「安定版」かを示すリリース規律が欠如しており、
package.json のバージョンは初期値 0.1.0 のまま、タグも CHANGELOG も
存在しない半端な状態だった。

## Decision

機能追加よりも安定性の土台作りを優先する Phase ベースのロードマップに
移行する。具体的には以下の 5 段階で進める。

- Phase 0: 既存スケジュールの消化
- Phase 1: スモーク基盤最小実装 (v0.1.0-alpha)
- Phase 2: AI エージェント支援の核心 + Phase 1.5 回収 (v0.1.0 → v0.2.0)
- Phase 3: テスト補強 + レビュー責任分離 (v0.3.0)
- Phase 4: 可視化・UX の改善 (v0.4.0+)

ロードマップの進捗管理そのものは「生きた状態を持つ markdown」では運用せず、
GitHub Projects V2 + gh-gantt をタスク管理の source of truth とする。
判断の根拠のみを ADR として残し、実タスクは Milestones (Version 単位) と
Labels (phase:N) + Epic (Phase と 1:1 対応) で表現する。

## Alternatives

### 機能追加と安定性投資を並行で進める

個人 + AI エージェント中心のプロジェクトでは並行作業は現実的に破綻する。
一方が疎かになり、結局どちらも中途半端になるリスクが高い。

### docs/roadmap.md として markdown で進捗管理する

Living Documentation の原則に反する。メンテナンスされない markdown は
作成時点から現実と乖離し始め、3 ヶ月後には参照されなくなる。
判断の根拠 (不変) と進捗状態 (可変) は異なる媒体に置くべき。

### Phase を細かく分けて短期サイクルを回す (週次リリース等)

個人プロジェクトではリリース儀式のオーバーヘッドが相対的に重くなる。
月次の Phase 境界で「次月何をやるか」を再決定する儀式の方が、
熱量の持続と想定外のスコープ追加への柔軟性を両立できる。

### 安定性ではなく AI エージェント支援 (#136) を最優先にする

データ破壊リスクと silent failure が残ったまま AI エージェント支援を
拡張すると、エージェントが誤った状態を前提に動作する温床となる。
AI エージェントが信頼して使えるツールにするには、まず基盤の信頼性が先。

## Consequences

- GitHub Projects V2 + gh-gantt が進捗管理の source of truth となり、 ドキュメントと実態の乖離を構造的に防げる
- Phase 間の切り替えコストが発生する (月末レビュー儀式として制度化)
- Phase 1 で
- Milestone は Version 単位 (v0.1.0-alpha, v0.1.0, v0.2.0, ...) で管理し、 Phase は phase:N Label + Epic で表現するため、二重管理の整合性に注意が必要
- 新機能アイデアは docs/ideas.md (自由記述) と GitHub Issue の二段構えで受ける
- 現 Phase への割り込みは「スモーク落ち」「データ破壊」等の致命的欠落のみ許可
