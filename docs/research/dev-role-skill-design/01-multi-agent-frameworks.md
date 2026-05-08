# Domain A: マルチエージェントOSSフレームワーク調査

> 調査者: Claude (親セッション, WebFetch ドメイン限定)
> 調査日: 2026-05-08
> ソース: GitHub README + 各公式docs (一次情報)

## サマリー比較表

| ツール                          | Stars | License       | アーキテクチャ                                           | ロール定義                                           | 並列実行                        | 言語                          | 外部CLI連携                            | 我々の用途への適合度                   |
| ------------------------------- | ----- | ------------- | -------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- | ----------------------------- | -------------------------------------- | -------------------------------------- |
| **CrewAI**                      | 50.9k | MIT           | Crews (autonomous) + Flows (event-driven)                | YAML/decorator (`@agent` `@task` `@crew`)            | ✅ Sequential/Hierarchical      | Python専用                    | ⚠️ 任意CLI連携が公式に明記なし         | △                                      |
| **Microsoft AutoGen**           | 57.8k | MIT (CC-BY)   | Core API + AgentChat API + Extensions, AgentTool wrapper | `AssistantAgent` `UserProxyAgent` `GroupChatManager` | ✅ async/await                  | Python                        | ✅ MCP統合あり                         | ✕ **maintenance mode**, MAF へ移行推奨 |
| **LangGraph**                   | 31.5k | MIT           | State + Graph (Node/Edge) state machine                  | Node = エージェント単位                              | ✅ parallel edges + conditional | Python + **TypeScript版あり** | ✅ Tool wrap自由                       | **◎ Well-suited**                      |
| **MetaGPT**                     | 67.8k | MIT           | SOPベース waterfall: PM→Architect→PM→Engineer→QA         | Role classes + shared message pool                   | ✅ artifact-driven              | Python (97.5%)                | ✅ tool wrap可                         | ◯ ただし研究プロトタイプ寄り           |
| **OpenAI Agents SDK** (旧Swarm) | 26.1k | MIT           | Agent + Handoff + Guardrail + Tool + Tracing             | `Agent` クラス + handoff/agent-as-tool               | ✅ async + handoff              | Python + **TypeScript版あり** | ✅ Function calls / MCP / hosted tools | **◎ Moderate effort で実装可**         |
| **Anthropic Claude Agent SDK**  | –     | – (Anthropic) | Tool-use + Subagent + Hook + MCP                         | プログラム的Agent + named subagents                  | ✅ subagent並列                 | Python + TypeScript           | ✅ Bash/MCPで自由                      | **◎ Claude Code互換でPM最適**          |

凡例: ◎=最適 / ◯=適合 / △=条件付き / ✕=非推奨

## 各ツール詳細

### 1. CrewAI

- **公式**: https://github.com/crewAIInc/crewAI / https://docs.crewai.com
- **概要**: "Lean, lightning-fast Python framework, completely independent of LangChain"
- **アーキテクチャ**:
  - **Crews**: 自律的な協働 (autonomous)
  - **Flows**: イベント駆動でstart/listen/router、state管理、pause/resume
- **ロール定義**: `agents.yaml` / `tasks.yaml` または `@agent` `@task` `@crew` デコレータ。`role` `goal` `backstory` でキャラ付け
- **並列**: Sequential / Hierarchical / Hybrid 各process対応
- **メモリ**: Built-in memory + knowledge bases
- **エンタープライズ機能**: Gmail/Slack/Salesforce統合、role-based access control
- **活発さ**: v1.14.4 (Apr 30, 2026), 186 releases, 100k+ certified developers
- **弱点**:
  - **Python専用**。他言語との統合はAPI経由のみ
  - **任意のCLIツール統合パターンが公式に明記なし** ← 我々の用途で致命的
  - LLM接続設定が必須
- **Codex+Claude組み合わせの評価**: △ Pythonラッパー経由で実装は可能だが、ネイティブサポートなし

### 2. Microsoft AutoGen v0.4

- **公式**: https://github.com/microsoft/autogen
- **重要**: **現在 maintenance mode**。Microsoftは新規開発に **Microsoft Agent Framework (MAF)** を推奨
- **アーキテクチャ**: 3層 (Core API / AgentChat API / Extensions API)
- **コンポーネント**:
  - `AssistantAgent`: AI agent
  - `UserProxyAgent`: human-in-the-loop
  - `GroupChatManager`: 多者会話司会
  - `AgentTool` wrapper: agentを別agentのtoolとして公開可能 (階層構造)
- **特徴**:
  - async/await first
  - **MCP server統合** ("Only connect to trusted MCP servers" 警告あり)
  - `max_tool_iterations` パラメータ
  - streaming support
- **AutoGen Studio**: GUI prototyping、ただし "not meant to be a production-ready app"
- **活発さ**: 57.8k★, 8.7k forks, community-managed
- **AG2との関係**: フォーク関係。AG2は別コミュニティ管理
- **Codex+Claude組み合わせの評価**: ✕ maintenance modeのため新規採用非推奨。既存資産があればMAFへの移行を視野

### 3. LangGraph

- **公式**: https://github.com/langchain-ai/langgraph + LangGraph.js
- **概要**: "Low-level orchestration framework for building, managing, and deploying long-running, stateful agents"
- **アーキテクチャ**: **State + Graph (Node + Edge) の state machine**
  - Node = 計算単位 (エージェント or 関数)
  - Edge = 遷移定義
  - State = nodeを跨ぐデータ
  - Conditional edges で動的ルーティング
- **マルチロール対応**:
  - 各ロールを別 Node に配置 (PM node, implementer node, reviewer node ...)
  - sequential / conditional / parallel をエッジで表現
- **特徴**:
  - **Parallel execution** via conditional edges + edge parallelization
  - **Checkpointing/persistence** で中断再開
  - **Human-in-the-loop** で stateを途中で人間がいじれる
- **言語**: Python + **TypeScript (LangGraph.js)** の双方完備
- **活発さ**: 31.5k★, 528 releases, 活発
- **弱点**: 学習曲線がやや急 (state管理を明示する必要)
- **Codex+Claude組み合わせの評価**: **◎** node-basedで PM/planner/implementer/reviewer/improver を素直にgraphに書ける。state checkpointが長時間タスクに強い。TypeScript版があるのでirisリポジトリ内に直接同居可能

### 4. MetaGPT

- **公式**: https://github.com/FoundationAgents/MetaGPT (ICLR 2025受理)
- **概要**: "Code = SOP(Team)" — 人間ソフトウェア会社のSOPをそのままエージェントロール化
- **ロール構成**:
  - Product Manager (PM) → PRD
  - Architect → 設計文書
  - Project Manager → タスクリスト
  - Engineer → コード
  - QA Engineer → テストレポート
- **特徴**:
  - **Artifact-driven handoffs** (各ロールの出力が形式化された成果物)
  - **Shared message pool** (blackboard) で全ロールが購読
  - 並列タスク実行
  - 外部CLIラップ可能
- **新展開**: MGX (MetaGPT X) という自然言語プログラミング製品をローンチ
- **活発さ**: 67.8k★, 8.6k forks
- **弱点**:
  - Python 97.5%
  - 研究プロトタイプ寄り。**プロダクション用Issue→PR運用の事例がドキュメント上明確でない**
  - SOPが固定的でカスタムロールに合わせるのは要工夫
- **Codex+Claude組み合わせの評価**: ◯ ロール思想は最適だがPython前提で、irisがTS主体である点と齟齬

### 5. OpenAI Agents SDK (旧 Swarm)

- **公式**: https://github.com/openai/openai-agents-python (Python) + TypeScript版
- **概要**: "Lightweight yet powerful framework for building multi-agent workflows"
- **プリミティブ**:
  - **Agent**: 命令 + tools + guardrails + handoffs
  - **Handoff**: agent間の委譲 (3パターン: routine sequence / direct handoff / agent-as-tool)
  - **Tool**: function call / MCP / hosted tools
  - **Guardrail**: 入出力 validation
  - **Tracing**: 内蔵
  - **Sandbox Agents**: コンテナ内で長時間タスク
- **LLM対応**: OpenAI + 100+他LLM (Anthropic Claude含む)
- **言語**: Python 3.10+ / TypeScript-JavaScript
- **活発さ**: 26.1k★, 4k forks, 97 releases (v0.17.0), 47 open issues
- **Codex+Claude組み合わせの評価**: **◎ Moderate effort** で PM→implementer→reviewer pipeline を実装可。`agent-as-tool` で reviewer を簡単に呼べる
- **注意点**: OpenAI主導だがLLMはマルチプロバイダ対応で実用的

### 6. Anthropic Claude Agent SDK

- **公式**: https://docs.claude.com/en/docs/agent-sdk/overview
- **概要**: Claude Code と同じプリミティブをプログラム的に呼び出すSDK
- **特徴** (一般知識補完):
  - Python + TypeScript SDK
  - Tool定義: 組み込み (Bash/Read/Write/Edit/Grep/Glob/WebFetch等) + MCP
  - **Subagent**: 名前付きで呼び出せる、別コンテキストで実行
  - **Hook**: PreToolUse/PostToolUse/UserPromptSubmit/SessionStart 等
  - メモリ: コンテキスト内 + 外部 (file/MCP)
- **想定構成 ("Claude PM が codex CLI を tool 化")**:
  - 親 Claude session が Bash tool で `codex exec` `codex review` を呼ぶ (ただしホスト側で codex CLI auth 済が必要)
  - subagent で reviewer / planner を分離
  - hooks でログ・通知
- **強み**:
  - **既に Claude Code そのもの** が PM 役のリファレンス実装になっている
  - permissions と sandbox が公式に統合済み
  - MCP で codex MCP server とも繋げる (codex mcp-server サブコマンド)
- **弱点**:
  - SDK は比較的新しい
  - 価格は Anthropic API 課金
- **Codex+Claude組み合わせの評価**: **◎** 「親=PM (Claude Code/SDK)、子tool=codex CLI、子subagent=reviewer/planner」が最も自然

## 推奨ショートリスト (上位3つ)

### 🥇 第1位: Claude Agent SDK + 既存 Claude Code subagent + Bash tool

**理由**:

- 親が Claude (本セッション) なので**何も新規導入せず始められる**
- iris の `pnpm pr:flow` を Bash でそのまま叩ける
- subagent (Sonnet) で reviewer / planner を分離 → 既に動いている
- 学習コスト最小

**弱点**: 「Anthropicロックイン」。ただし implementer は codex CLI なので OpenAI も併用していて、ベンダーロック度は中程度

### 🥈 第2位: LangGraph (TypeScript版)

**理由**:

- iris は TS主体なので同居可能
- State machine が **PM/planner/implementer/reviewer/improver/Termination** を綺麗に表現
- checkpoint で長時間タスクに強い
- HITLが標準

**弱点**: 学習コスト中。LangChainエコシステムへの依存

### 🥉 第3位: OpenAI Agents SDK (TypeScript版)

**理由**:

- agent-as-tool / handoff のプリミティブが我々の設計に直接マップする
- 100+LLM対応で Claude も使える
- Tracing内蔵でデバッグ容易

**弱点**: OpenAIブランドだが他社LLM混在は若干違和感、コミュニティはまだ発展途上

## 我々のスタックでの結論

**第1位 (Claude Agent SDK / Claude Code 直叩き)** が最有力。理由:

- **新規ライブラリ導入不要**: 親 Claude Code が既に PM として動作可能
- **iris の既存スクリプト (`pnpm pr:flow`) を Bash tool として直接呼べる**
- **codex CLI も Bash tool として直接呼べる** (codex exec / codex review / codex cloud exec)
- **subagent で reviewer / planner を分離** → ロールバイアス排除
- **MCP で codex mcp-server を組み込む拡張余地もある** (将来)

ただし設計が安定してきたら、第2位 LangGraph を「複雑な state machine 部分」だけに使うハイブリッドも視野。

## 追加で深堀すべき論点

1. **AutoGen v0.4 → MAF (Microsoft Agent Framework) への移行**: 既に AutoGen を使う場合の移行コスト。新規には採用しない。
2. **Claude Agent SDK の subagent の並列度上限**: 同時何並列まで実用的か (要実測)
3. **LangGraph.js (TS版) の安定度**: Python版との機能差
4. **OpenAI Agents SDK の `Sandbox Agents`**: 長時間タスクのコンテナ仕様詳細
5. **CrewAI の Custom Tool で `subprocess.run("codex exec ...")` ラッパー** を作るコスト見積もり (もし第2案として必要なら)
