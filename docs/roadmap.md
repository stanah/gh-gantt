# gh-gantt ロードマップ

最終更新: 2026-04-11
次回レビュー予定: 2026-04-30（月末レビュー儀式）

本ドキュメントは gh-gantt の中期ロードマップを定める生きた文書である。
月末レビュー儀式で更新し、Phase の進捗・追加アイデア・リスク認識を反映する。

## 基本方針

### 対象ユーザー

- **第一対象**: プロジェクトオーナー本人 + 本人が使用する AI エージェント（Claude Code 等）
- **OSS 化**: 当面見送り。ただし「将来 OSS として育つ可能性」は構造的に温存する
- **設計判断の優先順位**: 他者向けの汎用性より、自分と AI エージェントの日常ワークフロー最適化を優先

### 最優先事項: 安定性

機能追加よりも、以下の安定性を最優先する。

- **データ破壊の根絶**: `.gantt-sync/` 配下の sync-state・tasks.json が誤って書き換わらないこと
- **タスク見逃しの根絶**: silent failure（エラーを握りつぶしてスキップ）を許容しないこと
- **環境差異の吸収**: GitHub Projects V2 の Org/個人環境差異を構造的に検証できること

### 安定性への懸念領域

既知の構造的リスク：

1. **Silent failure**: #153 のように `issue_node_id` 欠損時に sub-issue / blocked-by が
   無言でスキップされる類のバグ。検知不可能な障害が最悪。
2. **状態整合性の破綻**: #149 / #154 のように snapshot.hash と tasks.json が不一致になる問題。
   連鎖して次の pull/push を汚染する。
3. **Org/個人環境差異**: Issue Types (Org 限定 beta) と Labels フォールバックの分岐ロジック。
   過去に一度修正済みだが、同種のバグが GraphQL スキーマ変化で再発する可能性が高い。
4. **エッジケース見落とし**: null/undefined・欠損データへの対応不足。

## 検証戦略

### 採用しない選択肢

- **GraphQL レスポンスのフィクスチャテスト**: 決定的で高速だが、実環境との乖離が避けられない。
  GitHub のスキーマ変化に手動で追従する運用は持続不可能。

### 採用する戦略: 実環境スモークテスト

実際の GitHub リポジトリ・Project V2 に対して smoke test を実行し、
Org/個人環境の両方で継続的に動作を検証する。

#### テスト基盤

| 環境 | リポジトリ                               | Project                                            | 用途             |
| ---- | ---------------------------------------- | -------------------------------------------------- | ---------------- |
| 個人 | `stanah/gh-gantt-e2e-test`（既存）       | `users/stanah/projects/4`（既存）                  | 個人環境の smoke |
| Org  | `gh-gantt-e2e/test-repo`（新規作成予定） | Org Project V2（新規作成予定、Issue Types 有効化） | Org 環境の smoke |

- 認証: **GitHub App**（Org にインストール）
- Org 作成: GitHub Free プランで無料作成（上限なし）

#### CI / ローカル実行戦略

| 実行トリガー        | 個人環境              | Org 環境         |
| ------------------- | --------------------- | ---------------- |
| CI（PR ごと）       | ✅                    | ❌               |
| CI（main マージ後） | ✅                    | ✅               |
| CI（月次 cron）     | ✅                    | ✅               |
| ローカル手動        | `pnpm smoke:personal` | `pnpm smoke:org` |

**設計判断**: PR ごとに両方走らせると GitHub GraphQL の rate limit と CI 時間が厳しい。
Org 検証は main マージ後 + 月次で十分。Org/個人差異は構造的で、個別 PR で頻繁に壊れる
ものではない。ローカル手動実行は CI が落ちたときの即時再現パスとして必須。

#### スモークテストのシナリオ（段階的に拡張）

**Tier 1（最小実装、Phase 1 の対象）**:

1. `gh-gantt init` を Org/個人それぞれで実行し、生成された `gantt.config.json` をスナップショット比較
2. `gh-gantt pull` を実行し、エラーなく完了することと `tasks.json` のスキーマ検証

**Tier 2（Phase 2 以降で追加）**:

3. `gh-gantt create` → `push` → 別ディレクトリで再 `init` + `pull` → 同じタスクが取得できる round-trip
4. `gh-gantt update` → `push` → 再 pull で一致確認
5. sub-issue 設定の round-trip（#153 の領域）
6. blocked-by 依存関係の round-trip
7. conflict 検知シナリオ

**正規化レイヤー**: スナップショット比較時は環境依存フィールド（Project ID、Custom Field Option ID、
`last_synced_at` タイムスタンプ）を smoke test スクリプト側で除外する。
本体コマンドにテスト専用フラグは入れない。

## Phase 計画

### Phase 0（〜2026-04-17）: 既存スケジュール維持

| Issue | 内容                       | 備考                                       |
| ----- | -------------------------- | ------------------------------------------ |
| #15   | Sprint 対応                | 既存予定                                   |
| #101  | Linked PR タイトル表示     | 既存予定                                   |
| #53   | PR 作成ワークフロースキル  | 既存予定                                   |
| ⭐    | `docs/roadmap.md` 初版作成 | 今回の grill-me 結果の文書化（本ファイル） |

### Phase 1（2026-04-18 〜 2026-04-30）: スモーク基盤最小実装

**完了時リリース**: `v0.1.0-alpha`

**Definition of Done（6 項目のみ）**:

1. `gh-gantt-e2e` Org が作成され、Issue Types が有効化されている
2. `gh-gantt-e2e/test-repo` と Org Project V2 が作成されている
3. GitHub App が作成・Org にインストールされ、CI から認証できる
4. スモーク Tier 1（init → pull → スナップショット比較）が **個人環境** で CI 緑
5. スモーク Tier 1 が **Org 環境** で CI 緑
6. ローカルから `pnpm smoke:personal` / `pnpm smoke:org` が実行可能

**DoD に含めない（Phase 1.5 として Phase 2 と並行で回収）**:

- `gh-gantt doctor` 最小実装（#140）
- 既存バグ retroactive リグレッションテスト（#146, #148, #149, #153, #154）
- `docs/regression-policy.md`, `tests/regressions/README.md` 整備
- release-please 導入 + `v0.1.0` 正式リリース
- スモークテストの flaky 検出ロジック

**判断根拠**: Phase 1 は見積もり過小評価リスクが高い（50% の確率で 3〜4 週間ぶれ込む見込み）。
完璧な v0.1.0 を目指すと Phase 2 が永遠に始まらない。`v0.1.0-alpha` で区切り、
正式版 `v0.1.0` は Phase 2 中の適切なタイミングで切る段階リリースとする。

### Phase 2（2026-05-01 〜 5 月末）: AI エージェント支援の核心

**完了時リリース**: Phase 2 前半で `v0.1.0` 正式、完了時に `v0.2.0`

**主タスク**:

- #138 [A-2] Acceptance criteria を first-class フィールド化
  - **事前条件**: 着手前に `tasks.json` のスキーマ migration 戦略を先行設計する
  - 旧形式を読める + 新形式を書くハイブリッド期間を意図的に設ける
- #139 [A-1] `gh-gantt context` コマンド（新規会話の初期コンテキスト取得）
- #141 [H-1] AC slots をタスクテンプレートに組み込む

**Phase 1.5 回収タスク**:

- `gh-gantt doctor` 最小実装（#140）— read-only な健全性チェック
- 既存 5 件のバグに対するリグレッションテスト追加
- `docs/regression-policy.md`, `tests/regressions/README.md` 整備
- release-please 導入 → `v0.1.0` 正式リリース
- `CLAUDE.md` と `.gantt-sync/workflow.md` にリグレッションテスト規律を明記

### Phase 3（2026-06 月）: テスト補強 + レビュー責任分離

**完了時リリース**: `v0.3.0`

**主タスク**:

- **D. テストカバレッジ補強**:
  - REST API テスト（FR-API-001..003 全て uncovered）
  - CLI コマンドテスト（show / update / create の AC 未カバー）
- **レビュー責任分離（#136 AI harness epic の残り）**:
  - #142 [B-1] Task role separation（実装者 / レビュアー）
  - #143 [B-2] Review required flag
  - #145 [C-2] Evidence-based task close

**設計方針**: レビュー責任分離は技術的強制ではなく **ワークフロー規律として実装** する。
`gh-gantt review` のようなレビュー専用コマンドを用意し、AI エージェントに
「実装セッションとレビューセッションを分ける」規律を課す構造。

### Phase 4（2026-07 月〜）: 可視化・UX

**完了時リリース**: `v0.4.0+`

- #19 Overdue auto-highlight
- #89 未スケジュール子タスクの親スケジュール下インライン表示
- #18 Critical path 可視化
- #20 SVG/PNG export

## クローズ対象（Phase 0 の時点で close する）

- **#22 Auto-scheduling**: スコープ過大、設計が曖昧、安定性志向と不整合
- **#21 Webhook/polling auto-sync**: pull pre-check (#157) で実用上代替可能
- **#86 Virtual scrolling**: 数千タスクに到達するまで不要

## 凍結対象

なし（2026-04-11 時点）。

> **注**: 初回の grill-me セッションでは #157 Pull pre-check を凍結対象としていたが、
> 別セッションで既に実装・マージ済み（commit `ad84be4`）であることが判明したため、
> 凍結対象から除外した。

## リリース規律

### バージョニング

- **release-please** を採用（Google 製のリリース自動化ツール）
- **統一バージョン**: 3 パッケージ（cli / shared / ui）を同期してバージョニングする
  - 理由: 密結合で `shared` の型変更が必ず `cli` と `ui` に波及するため
- **npm 公開はしない**: GitHub タグと CHANGELOG のみ
  - 兄さん + AI エージェント向けの用途では npm 公開は不要で、メンテナンスコストが見合わない

### コミット規約

- **Conventional Commits 厳密化**: commitlint + pre-commit フックで強制
- 既存のブラケット記法（例: `[E-1] ...`）は `feat(harness): ... (E-1)` のように body に移行
- Phase 2 で release-please 導入時に過去コミットから初回 CHANGELOG を手動で書き、
  以降は自動フローに乗せる

### 各 Phase とバージョンの対応

| Phase        | バージョン     | リリース時期         |
| ------------ | -------------- | -------------------- |
| Phase 1 完了 | `v0.1.0-alpha` | 2026-04-30 目標      |
| Phase 2 前半 | `v0.1.0`       | Phase 1.5 回収完了後 |
| Phase 2 完了 | `v0.2.0`       | 2026-05 月末         |
| Phase 3 完了 | `v0.3.0`       | 2026-06 月末         |
| Phase 4 完了 | `v0.4.0+`      | 2026-07 月以降       |

## 運用規律

### リグレッション規律

バグ修正時に **必ず** リグレッションテストを追加する。

- **配置**: `tests/regressions/issue-<N>-<slug>.test.ts` の形式
- **既知バグ台帳**: `tests/regressions/README.md` に過去のバグ一覧を維持
- **Phase 1.5 で retrofit**: 既存 5 件（#146, #148, #149, #153, #154）を遡及的に追加
- **ポリシー文書**: `docs/regression-policy.md` で規律を明文化
- **CLAUDE.md / workflow.md への組み込み**: `superpowers:test-driven-development` スキルと
  連携し、バグ修正 PR の完了条件として自動チェック

### スコープクリープ対策

新機能アイデアの受け皿と割り込みルール。

**アイデア捕捉（二段構え）**:

- **確信があるもの**: `gh-gantt create` で Issue 化し、Backlog ステータスで積む
- **曖昧なもの**: `docs/ideas.md` に自由記述で書き留める（純粋な Markdown）

**既存 Phase への割り込みルール**:

- **原則**: 現 Phase 中の新タスク追加は不可
- **例外（致命的欠落のみ）**: 以下に該当する場合は即座に対応
  - スモークテストが落ちる
  - 既存の同期データが破壊される
  - 曖昧な「使い勝手が悪い」は含めない

**月末レビュー儀式**:

- 毎月末の最終営業日に以下を実行
  1. `docs/ideas.md` を読み返し、昇格すべきものを Issue 化
  2. 現 Phase の進捗を確認
  3. 次月の Phase 内容を確定
  4. 本ドキュメント (`docs/roadmap.md`) を更新
- **トリガー**: `gh-gantt status` に「月末レビュー未実施」警告を仕込む（Phase 2 以降で実装）

## 認識しているリスク

| #   | リスク                                                             | 対策                                                                            |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1   | Phase 1 の見積もり過小評価（50% の確率で 3〜4 週間ぶれ込む）       | DoD を 6 項目に絞り、残りは Phase 1.5 として Phase 2 と並行で回収               |
| 2   | #138 AC first-class のデータ migration の複雑化                    | Phase 2 着手前にスキーマ移行戦略を先行設計                                      |
| 3   | レビュー責任分離の技術的強制の困難さ                               | 技術的強制ではなくワークフロー規律として実装                                    |
| 4   | スモークテストの flaky 化                                          | Phase 2 で flaky 検出ロジックを追加                                             |
| 5   | 想定外のスコープ追加（プロジェクトオーナー自身が認めた最大リスク） | `docs/ideas.md` + 月末レビュー儀式で吸収、現 Phase への割り込みは致命的欠落のみ |

## 改訂履歴

- 2026-04-11: 初版作成（grill-me セッション結果の文書化）
