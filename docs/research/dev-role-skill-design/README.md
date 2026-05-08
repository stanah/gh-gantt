# Codex × Claude Multi-Agent Orchestration: 調査サマリー

> 作成日: 2026-05-08
> 目的: 「PMエージェント (Claude) が planner / implementer (Codex CLI) / reviewer / improver / investigator を指揮するマルチエージェント基盤」の構築方針を決めるための事前調査。

## 背景と問題設定

iris プロジェクトでは、現状 1つの Codex セッションが Issue → 実装 → PR → マージまで一気通貫で実行している。これにより:

- **動作確認 (`pnpm check` / `pnpm test`) を尊重せずマージしてしまう**ことがある
- **計画・実装・レビューが同一エージェント**のため、Self-Refine 系の "self-bias" が掛かり、批判的な検討がスキップされる
- **デバッグ・調査・改善** が単独エージェントの都度判断に委ねられ、再現性・説明可能性が低い

これを解決するために、**ロール分離されたマルチエージェント基盤** を導入する。

## 調査ドメイン

| #   | ドメイン                                                                                                               | 担当                                  | 状態 | ファイル                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---- | -------------------------------------------------------------------------- |
| A   | マルチエージェントOSSフレームワーク (CrewAI/AutoGen/LangGraph/MetaGPT/OpenAI Agents SDK/Claude Agent SDK 等)           | Claude(親, WebFetch)                  | ✅   | [01-multi-agent-frameworks.md](./01-multi-agent-frameworks.md)             |
| B   | PR/Issue駆動の自律コーディングエージェント (OpenHands/SWE-agent/Devin/Factory.ai/claude-code-action/Codex Cloud 等)    | subagent (Sonnet, トレーニングデータ) | ✅   | [02-pr-driven-coding-agents.md](./02-pr-driven-coding-agents.md)           |
| C   | ロール分離型マルチエージェント設計パターン (Anthropic/OpenAI公式ガイド + MetaGPT/ChatDev/AutoGen/CAMEL/Reflexion 論文) | subagent (Sonnet, トレーニングデータ) | ✅   | [03-role-separation-patterns.md](./03-role-separation-patterns.md)         |
| D   | iris環境の既存資産との統合経路 (codex CLI / Claude Code / gh-gantt / beads / pnpm pr:flow / GitHub Actions)            | Claude(親, Bash/Read)                 | ✅   | [04-iris-integration-paths.md](./04-iris-integration-paths.md)             |
| -   | 横断総括と推奨アーキテクチャ (当初案: subagent + scratchpad)                                                           | Claude(親)                            | ✅   | [99-synthesis-and-recommendation.md](./99-synthesis-and-recommendation.md) |
| -   | **gh-gantt セッションへの委任メモ (最新方針: dev-role skill 群)**                                                      | Claude(親)                            | ✅   | [100-handoff-to-gh-gantt.md](./100-handoff-to-gh-gantt.md) ⭐              |

## 主要な発見ハイライト

1. **iris にはすでに大半の素材がある**: `pnpm pr:flow`(create/sweep/poll/resolve/merge) + `pnpm check` + `pnpm test` + `.gantt-sync` という基盤は既にPM風システム。**不足しているのは「動作確認なしマージを物理的に防ぐReviewer/Executorロールの差し込み」だけ**。
2. **`codex review` が既に存在**: Codex CLI に reviewer 専用サブコマンドがある (`--base <branch>` `--commit <SHA>` `--uncommitted`)。reviewer の素地はゼロから書かなくてよい。
3. **`codex exec --output-schema <FILE>`** で構造化artifact出力を強制できる → MetaGPT流のartifact handoffが自然に書ける。
4. **`codex cloud exec --attempts N`** で best-of-N サンプリングが標準サポート → improver/improvement loop の素地。
5. **`codex mcp-server`** で Codex を Claude Code から MCP tool として呼べる → 「Claude PM が codex を tool 化」案がきれいに成立。
6. **Anthropic 公式の警告**: "Don't build multi-agent systems when single agents suffice" (Building Effective Agents)。3-4ロールから始めるのが安全。
7. **我々の現ロール分割への重要指摘**: 現状の (PM/planner/implementer/reviewer/improver/investigator) には **Executor/Sandbox Runner ロールが欠落**。SWE-bench 上位手法はすべてテスト実行を独立工程として分離している。
8. **AutoGen は maintenance mode**, MS は **Microsoft Agent Framework (MAF)** に移行中。新規採用はLangGraph / OpenAI Agents SDK / Claude Agent SDK が筋。

## 推奨アーキテクチャ (詳細は [99-synthesis-and-recommendation.md](./99-synthesis-and-recommendation.md))

**「`pnpm pr:flow` 拡張 + Claude Code subagent + codex tool化」のハイブリッド3層**:

```
[Claude Code 本セッション = PM]
    ├─ subagent: planner (Sonnet)         ロール: Issue→計画文書(JSON)
    ├─ tool: codex exec (workspace-write) ロール: implementer (構造化出力)
    ├─ tool: pnpm check / pnpm test       ロール: Executor (deterministic gate)
    ├─ tool: codex review --base main     ロール: reviewer #1 (Codex Sonnet系)
    ├─ subagent: reviewer-claude (Sonnet) ロール: reviewer #2 (Claude独立判断)
    ├─ subagent: improver (Sonnet)        ロール: 修正合議
    └─ tool: pnpm pr:flow {create/poll/resolve/merge}  ロール: GitHub連携
```

要点:

- **Executor ゲートを Reviewer の前段に必須化** (`pnpm check && pnpm test` がパスしないと PR を上げない)
- **Reviewer を 2系統独立** (Codex判定 + Claude判定) → 単一モデルバイアス排除
- **既存 `pnpm pr:flow` を拡張**: `pre-pr-gate` (check+test+codex review) サブコマンドを追加
- **PM (Claude) は `Termination Judge` も兼ねる** → 改善ループ無限化を抑止

## 次のステップ (2026-05-08 時点で更新)

iris セッションでの brainstorming で設計方針が確定:

1. **Team機能は使わない** (Claude依存を避ける)
2. **エージェント非依存** (Claude / Codex / 他)
3. **Skill ベース**: 1 skill + 5 role別referenceファイル方式
4. **5ロール**: orchestrator / planner / implementer / executor / reviewer
5. **gh-gantt 二次スキルとして公式化**: gh-gantt repo にPR

→ **iris セッションでの作業はここで終了**。続きは [100-handoff-to-gh-gantt.md](./100-handoff-to-gh-gantt.md) を **gh-gantt 側のセッション** で読み、そちらで設計詳細・実装を進める。

iris 側で並行して必要な変更（gh-gantt skill完成後に別Issue化）:

- `scripts/pr-review-flow.mjs` に `pre-pr-gate` サブコマンド追加
- `.gantt-sync/workflow.md` の Skill Routing 拡張
- `.gantt-sync/workflow.md` に `Dev-Role Config` セクション追加
- `docs/orchestration/review-rubric.md` 新設

## 注記

- Agent #2 と #3 の調査は実行環境の制約により **トレーニングデータ (カットオフ 2025-08)** ベース。一次URLの確認は未実施項目あり。
- Agent #1 (OSSフレームワーク) は当初失敗、後に Claude(親) が WebFetch で再調査。
- 集約は本ファイル ([99-synthesis-and-recommendation.md](./99-synthesis-and-recommendation.md))。
