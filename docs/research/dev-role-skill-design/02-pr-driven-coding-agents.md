# Domain B: PR/Issue駆動 自律コーディングエージェント調査

> 調査者: subagent (Sonnet, トレーニングデータ カットオフ 2025-08)
> 調査日: 2026-05-08
> 注記: WebSearch/WebFetch権限denyのためトレーニングデータベース。一次情報の確認は別途必要。

## 目的

「PMエージェントが Issue を分解→ planner エージェントに渡す→ implementer (Codex CLI) が PR 化 → reviewer エージェントが動作確認 → merge」というパイプラインを作るための既存事例の収集。

## サマリー比較表

| ツール                   | ライセンス            | トリガー                                    | ロール構成                         | レビューエージェント分離   | モデル                        | 導入コスト感          | 我々への適合度 |
| ------------------------ | --------------------- | ------------------------------------------- | ---------------------------------- | -------------------------- | ----------------------------- | --------------------- | -------------- |
| OpenHands                | Apache 2.0            | Issue mention / PR comment / Webhook / 手動 | マルチ (PM・実装・ブラウザ操作)    | △ 人間レビュー必須設定可   | Anthropic / OpenAI / ローカル | 中〜高 (GPU or API費) | ★★★★☆          |
| SWE-agent                | MIT                   | 手動 / GitHub Actions                       | シングル (REACTループ)             | × 標準なし                 | OpenAI / Anthropic / ローカル | 低〜中 (OSS)          | ★★★☆☆          |
| AutoCodeRover            | MIT                   | 手動 / CLI / GitHub Actions                 | シングル (コンテキスト探索+パッチ) | × 標準なし                 | OpenAI / Anthropic            | 低〜中                | ★★☆☆☆          |
| Aider                    | Apache 2.0            | 手動 CLI / Git hook                         | シングル (co-pilot型)              | × (人間がレビュー)         | OpenAI / Anthropic / ローカル | 低                    | ★★☆☆☆          |
| claude-code-action       | MIT                   | PR/Issue comment (GitHub Actions)           | シングル実装                       | △ PRのみ、マージ不可       | Anthropic Claude              | 低 (Actions費のみ)    | ★★★☆☆          |
| Codex Cloud (OpenAI)     | 商用                  | Issue / PR comment / Webhook                | マルチ (cloud orchestration)       | △ 人間承認ゲート設定可     | GPT-4o / o3 系                | 高 (OpenAI有料)       | ★★★☆☆          |
| Devin                    | 商用 (Cognition)      | Slack / Web UI / GitHub Issue               | マルチ (計画+実装+テスト)          | ○ 人間確認ステップ組み込み | 独自 (非公開)                 | 高 ($500+/月)         | ★★★★☆          |
| Factory.ai / Droid       | 商用                  | GitHub Issue / PR / Slack                   | マルチ (Droids=専任エージェント群) | ○ レビュードロイド分離     | 独自+外部                     | 高 (エンタープライズ) | ★★★★★          |
| Sweep AI                 | Apache 2.0 (archived) | Issue comment / PR review                   | シングル                           | △ PR作成→人間merge         | OpenAI                        | 低 (ただしarchived)   | ★★☆☆☆          |
| gpt-engineer / gpt-pilot | MIT                   | 手動 CLI                                    | シングル (scaffolding寄り)         | ×                          | OpenAI / Anthropic            | 低                    | ★☆☆☆☆          |
| Bolt.diy / bolt.new      | MIT / 商用            | Web UI                                      | シングル (フロントエンド特化)      | ×                          | OpenAI / Anthropic / ローカル | 低〜中                | ★☆☆☆☆          |
| Codeium Forge            | 商用                  | PR / Issue                                  | シングル〜マルチ (推測)            | △                          | 独自                          | 中〜高                | ★★★☆☆          |

## ツール別詳細

### 1. OpenHands (旧 OpenDevin)

- **リポジトリ**: https://github.com/All-Hands-AI/OpenHands
- **ライセンス**: Apache 2.0
- **活発さ**: 2024〜2025年で最も活発なOSS自律コーディングエージェントの1つ。Star数 40k超

**アーキテクチャ**:

- コアは「Controller + Agent + Runtime」の3層構成
- Runtime は Docker コンテナ内でコードを実行（サンドボックス）
- デフォルトエージェント `CodeActAgent` が主力: LLMにコードを直接実行させ、標準出力を観察するループ
- マルチエージェント拡張あり: `ManagerAgent` が子エージェントを生成する階層構造が実験的に存在
- GitHub Actions 向け `openhands-resolver` が別パッケージ化されており、Issue に `@openhands-agent` とコメントすると自動でPRを作成

**トリガー方式**: Issue / PR comment での mention / GitHub Actions Workflow / Web UI / OpenHands Cloud Webhook

**対応モデル**: LiteLLM経由で100+ モデル (Claude 3.x / GPT-4o / Gemini / ローカルOllama 等)。推奨は Claude Sonnet 系

**レビュー・マージ制御**:

- PR を作成するまでが自動、マージは人間が行う設定が標準
- `openhands-resolver` の設定で「Draft PR のみ作成」も可能
- レビュー専任エージェントは標準では存在しないが、カスタムエージェントで差し込み可能
- 「動作確認なしマージ」問題: コンテナ内でテストを実行する仕組みがあるが、テストが存在しない・壊れている場合は素通りするリスク

**セキュリティ**: Docker コンテナ内に完全隔離

**コスト**: OSS自己ホスト (インフラ + Claude API $0.5〜$10/タスク) or OpenHands Cloud (クレジット制)

**制約・落とし穴**:

- 長い実行時間（複雑タスクで30分超）
- コンテキスト長を超えるとループが崩壊する
- ブラウザ操作エージェントは不安定
- SWE-bench スコアは高いが、実世界タスクでの成功率は体感的に低い (30〜50%)
- マルチエージェントの階層構造はまだ実験的

### 2. SWE-agent

- **リポジトリ**: https://github.com/princeton-nlp/SWE-agent
- **ライセンス**: MIT

**アーキテクチャ**: `Agent + Environment` の2層。AgentComputer Interface (ACI) を通じてファイル操作・コマンド実行。シングルエージェントが ReAct ループでリポジトリを探索しパッチを生成。SWE-agent Enterprise はマルチエージェント対応、Slack/Jira連携、テスト自動化を追加

**トリガー**: 主に CLI手動実行 / GitHub Actions, Enterprise版は Issue / Webhook

**対応モデル**: GPT-4 / Claude / LiteLLM経由でローカルモデル

**レビュー**: OSS版はパッチ生成のみ、マージは手動。Enterprise版は不明（推測）

**セキュリティ**: Docker コンテナ内実行を推奨、直接ホスト実行も可能だが非推奨

**制約**: exploration フェーズが長くトークン消費大、複数ファイル/サービス跨ぎが苦手

### 3. AutoCodeRover

- **リポジトリ**: https://github.com/AutoCodeRoverSG/auto-code-rover
- **ライセンス**: MIT

**アーキテクチャ**: 「コンテキスト収集エージェント」+「パッチ生成エージェント」の2フェーズ。**AST 解析でリポジトリ構造を把握**するのが特徴

**制約**: Python プロジェクトに最適化されており、他言語は対応薄い。大規模モノレポには向かない

### 4. Aider

- **リポジトリ**: https://github.com/paul-gauthier/aider
- **ライセンス**: Apache 2.0

**アーキテクチャ**: CLI ベースの co-pilot 型。シングルエージェント。`architect` モードで「計画LLM + 実装LLM」の2ステップが可能。`--watch` モードで AI-comment を検知して自動実行

**コスト**: 最も低コスト。OSS + API費のみ。単純タスクなら $0.1 以下

**制約**:

- Issue → PR の完全自動化には自前の接着剤が必要
- セキュリティ境界なし（ホスト実行）
- レビューエージェントの概念がない

### 5. claude-code-action (Anthropic公式)

- **リポジトリ**: https://github.com/anthropics/claude-code-action
- **ライセンス**: MIT

**アーキテクチャ**: GitHub Actions Workflow として動作。Issue / PR comment で `@claude` とメンションするとトリガー。Claude Code CLI が Actions 内で実行され、コードを編集しPRを作成。**シングルエージェント (Claude 単体)**

**対応モデル**: Anthropic Claude のみ (Sonnet / Opus)。Bedrock / Vertex AI プロキシ可

**レビュー**: PR 作成まで自動、マージは人間。Draft PR 作成設定あり。レビュー専任エージェントは分離されていない

**コスト**: GitHub Actions費 + Anthropic API費。低コスト

**制約**:

- Anthropic モデル専用 (ベンダーロックイン)
- Actions の実行時間制限 (6h)
- マルチエージェント構成は自前で組む必要あり
- テスト実行・動作確認の仕組みは自前設定必須

### 6. Codex Cloud (OpenAI) + Codex CLI

- **プロダクト**: https://openai.com/codex (商用)
- **Codex CLI**: https://github.com/openai/codex (OSS, MIT)

**アーキテクチャ**:

- **Codex CLI**: ローカルで動作するコーディングエージェント CLI
- **Codex Cloud**: OpenAI インフラ上でコードエージェントを並列実行
- マルチタスク並列実行が可能

**対応モデル**: OpenAI 独自モデル (o3, codex-1 等)。外部モデルは基本非対応

**レビュー**: PR 作成まで自動、マージは人間。「承認ゲート」設定は Codex Cloud で提供（推測）

**コスト**: 有料 (API使用量ベース)。`codex cloud exec` は2025年時点ベータ

**制約**: OpenAI ベンダーロックイン

**注**: 我々の implementer 役の最有力候補。`codex exec --output-schema`、`codex review`、`codex cloud exec --attempts N` などの強力なフラグが揃っている (詳細は [04-iris-integration-paths.md](./04-iris-integration-paths.md) 参照)

### 7. Devin (Cognition Labs)

- **プロダクト**: https://cognition.ai/devin
- **ライセンス**: 商用のみ

**アーキテクチャ**: 完全クラウドサービス、内部非公開。計画・実装・テスト・デバッグのループを1エージェントが統合実行。Web ブラウザ操作・ターミナル・コードエディタを仮想マシン内で操作。Slack 連携で人間と非同期コミュニケーション

**対応モデル**: 独自モデル (cognition-1 等)。外部モデル非対応

**コスト**: Team プラン: 約 $500〜$2,000+/月。**個人開発には高コスト**

**制約**: 非常に高コスト、モデル独自のためチューニング不可、実際の成功率は宣伝より低いという報告多数

### 8. Factory.ai / Droid CLI ⭐ 注目

- **プロダクト**: https://factory.ai
- **ライセンス**: 商用 (エンタープライズ向け)

**アーキテクチャ**: **「Droids」という専任エージェントを複数組み合わせる設計**

- `dev-droid`: 実装担当
- `review-droid`: **レビュー担当 (コードレビューに特化)** ← 我々の reviewer 役の最完成形
- `test-droid`: テスト担当 (推測)

GitHub / Jira / Linear と深く統合。Issue → 計画 → 実装 → レビュー → PR というパイプラインが製品として提供

**レビュー**: `review-droid` がコードレビューを自動実行するのが最大の特徴。**「動作確認なしマージ」問題に最も直接的に対処している商用ツール**

**コスト**: 高価格帯 (エンタープライズ契約)。個人開発には適さない

**示唆**: アーキテクチャは我々の参考になるが、製品としての導入は難しい

### 9. Sweep AI (事実上 archived)

公式は別サービスへ移行。**本番採用は非推奨**

### 10. gpt-engineer / gpt-pilot

新規プロジェクト生成 (scaffolding) が主目的。既存リポジトリへのパッチ適用には向かない。**我々のユースケースには不向き**

### 11. Bolt.diy / bolt.new

WebContainer (ブラウザ内 Node.js 実行環境) + LLM でフロントエンドを生成。Issue → PR の概念なし。**完全に異なるユースケース**

### 12. その他注目

- **Codeium Forge** (推測): GitHub Issue → PR の自動化。詳細非公開
- **Cursor Background agents**: IDE 依存のためパイプライン外利用は困難
- **JetBrains AI Agent**: 同上、IDE依存
- **Agentless** (https://github.com/OpenAutoCoder/Agentless): シンプルなエージェントレスアプローチでSWE-bench高スコア。**パイプライン組み込みのライブラリとして参考**

## 「reviewer/動作確認エージェントを差し込めるか」観点でのランキング

1. **Factory.ai** — `review-droid` 専任レビューエージェントが製品設計に組み込み済み (高コスト)
2. **OpenHands** — マルチエージェント階層が実験的、`ManagerAgent` → `CodeActAgent` → カスタム ReviewAgent 構成可能
3. **Devin** — 人間確認ステップを Slack/UI で挟める
4. **Codex Cloud** — 承認ゲート (詳細非公開)
5. **claude-code-action** — GitHub Actions ワークフロー設計で reviewer ジョブを `needs:` で後続させれば接続可能
6. **SWE-agent Enterprise** — レビューステップ統合を謳う (詳細不明)
7. **Aider** — CLIツールのため自前スクリプトで全て繋ぐ必要

## 推奨パターン3つ

### A) 既存ツールで満たせるパターン: OpenHands + ReviewAgent

```
GitHub Issue
  → openhands-resolver (Issue mention)
  → ManagerAgent が CodeActAgent を生成・実装
  → PR Draft 作成
  → 後続Actions: ReviewAgent (別 OpenHands or Claude Action) が PR をレビュー
  → CI (テスト) 必須
  → 人間が最終 Approve & Merge
```

### B) 部分採用 + 自前接着: Codex CLI + claude-code-action + GitHub Actions ⭐ 我々の有力候補

```
GitHub Issue
  → GitHub Actions (issues opened)
  → Step 1: Codex CLI でタスク分解・実装 (codex cloud exec)
  → Step 2: PR 自動作成 (gh pr create)
  → Step 3: claude-code-action が PR をレビュー (@claude /review)
  → Step 4: CI (テスト・lint) が必須パス
  → Step 5: 人間が最終 Approve
  → Merge
```

**コスト**: OpenAI API + Anthropic API + GitHub Actions

### C) 自前構築 + ライブラリ流用 ⭐ 我々の本命候補

```
GitHub Issue (Webhook)
  → PM エージェント (Claude Opus): Issue 分解
  → Planner (Claude Sonnet): 実装計画
  → Implementer (Codex CLI): 各サブタスクを並列実装
  → Executor: pnpm check && pnpm test (deterministic gate)
  → PR 作成 (gh CLI / pnpm pr:flow create)
  → Reviewer (Codex review + Claude Sonnet 独立): PR diff レビュー
  → Improver: 修正合議
  → 人間が最終 merge
```

**強み**: iris の既存資産 (`pnpm check / test / pr:flow`) と完全に統合。完全に我々の設計に最適化、ベンダーロック最小化

## 「動作確認なしマージ」問題の防止機構まとめ

| 手法                    | 説明                                                        | 実現難易度 |
| ----------------------- | ----------------------------------------------------------- | ---------- |
| CI 必須化               | GitHub Branch Protection で `required status checks` を設定 | 低         |
| PR Draft 強制           | エージェントは必ず Draft PR を作成                          | 低         |
| Reviewer エージェント   | 別エージェントが PR diff + テスト結果を確認                 | 中         |
| Sandbox テスト実行      | Docker コンテナ内で実行し、結果をマージ条件に               | 中         |
| 人間 Approve 必須ルール | CODEOWNERS + Branch Protection で必須化                     | 低         |

## 追加深堀ポイント

1. **OpenHands の MicroAgent 機能**: 特定リポジトリ向けの指示ファイル (`.openhands/microagents/`) を作成すると、エージェントの動作をリポジトリ固有にチューニングできる。**iris への適用を検討すべき**
2. **SWE-bench スコアの信頼性**: 各ツールのスコアはベンチマーク専用チューニングの可能性。実世界タスクとの乖離を念頭に
3. **Codex CLI の `--provider` フラグ**: OpenAI 以外のプロバイダ指定の可能性 (将来注視)
4. **GitHub Models + Actions**: API キー管理を簡略化できるオプション
5. **PR レビュー自動化のリスク**: エージェント自動 Approve は脆弱性を見逃す可能性。**人間の最終 Approve を組織ポリシーとして定める** ことが必須

---

> **免責**: WebSearch / WebFetch の権限が本セッションで拒否されたため、一次情報の確認ができていません。料金・Star数・最新機能については各ツールの公式サイト・GitHubで必ず確認してください。特に Factory.ai・Devin・Codex Cloud は商用製品のため料金体系が頻繁に変わります。
