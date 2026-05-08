# Domain C: ロール分離型マルチエージェント設計パターン調査

> 調査者: subagent (Sonnet, トレーニングデータ カットオフ 2025-08)
> 調査日: 2026-05-08
> 注記: WebSearch/WebFetch権限denyのためトレーニングデータベース。一次URLは別途確認推奨。

## 主要文献ダイジェスト

### 1. Anthropic「Building Effective Agents」(2024年12月)

**URL**: https://www.anthropic.com/research/building-effective-agents

**要点**:

- 「エージェント」は大きく「ワークフロー（事前定義フロー）」と「自律エージェント（動的判断）」に分類
- 5つの基本ワークフロー: **Prompt chaining / Routing / Parallelization / Orchestrator-subagents / Evaluator-optimizer**
- オーケストレーターはサブエージェントに委譲し結果を統合、サブエージェントはツールを実行
- **重要警告**: "Don't build multi-agent systems when single agents suffice"（過度な複雑化を避けよ）
- 人間へのエスカレーション（HITL）を設計段階で組み込め
- 検証エージェント（Evaluator）は **独立したモデルインスタンス** で実行、バイアスを排除

**我々の用途への意味**: Evaluator-optimizerパターンが reviewer/improver ロールの理論的根拠

### 2. Anthropic「How We Built Our Multi-Agent Research System」(2025年)

**URL**: https://www.anthropic.com/engineering/claude-research-system （推定URL）

**要点**:

- Claude内部のリサーチシステムは **オーケストレーター1体＋並列サブエージェント多数** の構成
- オーケストレーターが研究計画を立案、並列サブエージェントが独立Webサーチ・ドキュメント解析
- **サブエージェント間の直接通信はない**、全結果がオーケストレーターに集約 (Hub-and-spoke)
- コンテキストウィンドウ管理が最大の課題：長い研究では情報の圧縮・要約が必要
- 並列化により単一エージェントの数倍の速度
- サブエージェントは **ステートレス設計**

**我々の用途への意味**: investigatorロールのステートレス並列実行の根拠

### 3. Anthropic Claude Agent SDK 設計思想

**URL**: https://docs.anthropic.com/ja/docs/build-with-claude/agents

**要点**:

- **4種のメモリ**: In-context（一時）/ External DB / In-weights（学習済）/ In-cache（KVキャッシュ）
- **5種のアクション**: ストレージ操作 / プロセス実行 / UI操作 / サービス呼び出し / エージェント間通信
- マルチエージェントではエージェントが「ツール」として他エージェントを呼び出す設計
- 信頼レベル（trust levels）: オーケストレーターはサブエージェントより高権限
- **最小権限の原則** を適用

**我々の用途への意味**: investigatorにread-only、implementerにwrite権限という設計の根拠

### 4. OpenAI「A Practical Guide to Building Agents」(2025年)

**URL**: https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf

**要点**:

- **Single-agent loop**: Planning → Tool selection → Execution → Observation のループが基本単位
- **Multi-agent**: Handoffs（タスクを別エージェントに渡す）/ Routines（一連のステップ定義）が核
- ガードレール（input/output filtering）を全エージェントに装備することを必須とする
- エージェントが「判断不能」と判断した時の Human escalation フロー
- 評価は **LLM-as-judge + deterministic checks**（テスト実行）の組み合わせを推奨

**我々の用途への意味**: ガードレールとhandoff設計、LLM-as-judge + sandbox実行の組み合わせ

### 5. MetaGPT (arXiv: 2308.00352)

**URL**: https://arxiv.org/abs/2308.00352

**要点**:

- **ロール構成**: Product Manager → Architect → Project Manager → Engineer × n → QA Engineer
- 各ロールの出力が形式化された **成果物（artifact）** として次ロールへ
- 共有メッセージプール（blackboard）で全エージェントが購読・発行
- HumanEval・SWE-benchで従来手法を上回る
- **重要知見**: 成果物の形式化（structured output）がエラー伝播を防ぐ最重要因子

| ロール          | 責務                   | 出力成果物         |
| --------------- | ---------------------- | ------------------ |
| Product Manager | 要求分析・PRD作成      | PRD文書            |
| Architect       | 技術設計・システム構成 | 設計文書・クラス図 |
| Project Manager | タスク分解・工数見積   | タスクリスト       |
| Engineer        | コード実装             | コードファイル     |
| QA Engineer     | テスト設計・実行       | テストレポート     |

### 6. ChatDev (arXiv: 2307.07924)

**URL**: https://arxiv.org/abs/2307.07924

**要点**:

- **フェーズ構成**: Designing → Coding → Testing → Documenting
- **ロール**: CEO（要求）/ CTO（技術方針）/ Programmer（実装）/ Reviewer（コードレビュー）/ Tester（テスト）
- **Chat Chain**: 各フェーズ内でロールペアが対話を繰り返し品質を高める
- **重要知見**: レビュアーとプログラマーが **対話ループ** を持つことで一方通行より品質向上

```
CEO ─→ 要求確定 → CTO ─→ 技術設計 → Programmer ─→ 実装
                          └─ Reviewer ←→ Programmer（ループ）
                                  └─ Tester → テスト報告 → Programmer（バグ修正）
```

### 7. AutoGen (arXiv: 2308.08155)

**URL**: https://arxiv.org/abs/2308.08155

**要点**:

- **ConversableAgent**: 任意エージェントが会話参加者になれる汎用設計
- **GroupChat**: 複数エージェントが1つの会話に参加、司会（GroupChatManager）が発言権制御
- **2エージェントパターン**: UserProxy（人間代理）+ Assistant（LLM）が最小単位
- コード実行エージェント（code_executor）を独立させて安全なサンドボックスを実現
- **重要知見**: 会話がメモリ代わり。長い会話では圧縮必要

### 8. CAMEL (arXiv: 2303.17760)

**URL**: https://arxiv.org/abs/2303.17760

**要点**:

- **役割対**: Instructor（指示者）→ Assistant（実行者）の非対称ペア
- **Inception prompting**: 役割を強制するシステムプロンプトで役割崩壊（role drifting）を防ぐ
- **重要問題発見**: ロールプレイングの **「Yes, and...」現象（相槌エージェント）** —両エージェントが合意しすぎて批判的検討がなくなる
- 2エージェント構成は単純だが多段タスクには不向き

**我々の用途への意味**: reviewer が「相槌エージェント」化するアンチパターンの文献的根拠

### 9. Reflexion (arXiv: 2303.11366)

**URL**: https://arxiv.org/abs/2303.11366

**要点**:

- **3層構造**: Actor（行動）→ Evaluator（評価）→ Self-Reflection（反省文生成）
- 反省文をEpisodicメモリに蓄積し、次イテレーションのシステムプロンプトに注入
- HumanEvalでpass@1大幅改善
- **重要知見**: Evaluatorが外部検証（テスト実行）を持つ場合、純粋にLLM評価のみより精度大幅向上
- ループ終了条件を明示しないと無限ループ

### 10. Self-Refine (arXiv: 2303.17651)

**要点**:

- 単一モデルが生成→批評→改善を繰り返す
- **重要な限界**: 同じモデルが評価と実行を兼ねると系統的バイアスが残る
- 数回イテレーション（3〜5回）後に改善が飽和
- コード生成タスクは外部テスト実行と組み合わせると効果大幅向上

**我々の用途への意味**: reviewer/improverを **同一モデル・同一インスタンスにしてはならない** 根拠

### 11. Voyager (arXiv: 2305.16291)

**要点**:

- **3コンポーネント**: Automatic curriculum / Skill library（コードDB）/ Iterative prompting
- スキルはベクトルDB（embedding）で管理、類似タスクで検索・再利用
- コード実行環境（JS sandbox）で **検証後のみスキルをライブラリに追加するGate機構**
- 検証失敗時は最大3回自動リトライ、それ以降は人間にエスカレーション

**我々の用途への意味**: 実行検証→承認→ライブラリ化のGateパターン

### 12. Generative Agents (arXiv: 2304.03442)

**要点**:

- **記憶アーキテクチャ**: Memory stream → Retrieval（重要度・新鮮度・関連性スコアリング）→ Reflection → Planning
- 重要度スコア付き記憶を優先的に参照

### 13. Lilian Weng「LLM Powered Autonomous Agents」(2023年)

**URL**: https://lilianweng.github.io/posts/2023-06-23-agent/

**要点**:

- エージェントを Planning / Memory / Tool Use の3要素で体系整理
- **Memory**: Sensory / Short-term / Long-term（外部DB）/ Episodic の4種
- **重要指摘**: "The reliability of the system is bounded by the least reliable component"（最弱リンク問題）
- 長期タスクのコンテキスト制限とエラー累積が実用上の最大障壁

### 14. SWE-bench / SWE-agent (2024年)

**要点**:

- **Agentless手法（2024年）**: Planning→実装→テスト実行の線形パイプラインで複雑マルチエージェントを上回るケース
- **重要知見**: 複雑なロール構成より **コンテキスト設計とツールインターフェースの質** が性能を左右
- Resolvedレート上位手法はいずれも「テスト実行」を必須の自己検証ステップとして持つ

## ロール分離パターン分類

### Pattern A: SOPベース線形パイプライン（MetaGPT型）

```
PM/PO → Architect → Project Manager → Engineer(s) → QA
  ↓          ↓             ↓              ↓           ↓
 PRD    設計文書      タスクリスト      コード      テストレポート
```

**特徴**: 各ロールの成果物が形式化、次ロールへの入力が明確
**メモリ**: Shared message pool（blackboard）
**検証**: QAエージェントによるテスト実行
**強み**: 人間プロセスに近く説明可能性が高い
**弱み**: フィードバックループが遅い（差し戻し重い）

### Pattern B: Chat Chainループ型（ChatDev型）

```
各フェーズ内でインストラクター↔アシスタントの対話ループ
Design Phase:  CEO ↔ CTO
Coding Phase:  CTO ↔ Programmer
Review Phase:  Reviewer ↔ Programmer
Test Phase:    Tester ↔ Programmer
```

**特徴**: 同一フェーズ内の品質向上ループを持つ
**強み**: ロールペア内のフィードバックが速い
**弱み**: チャット履歴の肥大化リスク

### Pattern C: オーケストレーター＋並列サブエージェント（Anthropic型）

```
Orchestrator
├── Subagent-A（独立タスクA）
├── Subagent-B（独立タスクB）  ← 並列実行
├── Subagent-C（独立タスクC）
└── Evaluator（結果検証）
```

**特徴**: 独立タスクを並列実行、オーケストレーターが統合・評価
**強み**: 高速化・スケーラブル
**弱み**: タスク間依存があると並列化困難

### Pattern D: グループチャット型（AutoGen型）

```
GroupChatManager（司会）
├── Planner / Coder / Critic / Executor (sandboxed) / Human（HITL）
```

**強み**: 動的な役割追加が容易
**弱み**: GroupChatManager のスケジューリング複雑化

### Pattern E: Reflexionループ型（自己改善）

```
Actor → 実行 → Evaluator → スコア → Self-Reflector → 反省文
                                          ↓
                                      (Episodic Memory)
                                          ↓
                                       Actor（次イテレーション）
```

**強み**: テスト実行と組み合わせで高精度
**弱み**: 終了条件設計が難しい

### パターン比較表

| パターン      | 役割数         | 同期/非同期              | 検証方法         | 強み                         | 弱み                 |
| ------------- | -------------- | ------------------------ | ---------------- | ---------------------------- | -------------------- |
| A: SOP線形    | 5-6            | 同期（順次）             | QAテスト実行     | 説明可能・人間プロセスに近い | フィードバック遅い   |
| B: Chat Chain | 5-6 + ペア対話 | 同期（フェーズ内ループ） | 実コード実行     | フェーズ内品質高             | コンテキスト肥大     |
| C: Orch+並列  | 1+N            | 非同期（並列）           | 独立Evaluator    | 高速・スケーラブル           | 依存関係処理難       |
| D: GroupChat  | 4-6            | 準同期                   | Executor sandbox | 柔軟・動的                   | スケジューリング複雑 |
| E: Reflexion  | 3              | 同期（反復）             | 外部テスト判定   | 収束性高                     | 無限ループリスク     |

## アンチパターン集 ⚠️

### AP-1: 相槌エージェント（Yes-Man Reviewer）

**症状**: ReviewerがImplementerの出力をほぼ無条件で承認、批判的評価機能が死亡
**原因**: 同一ベースモデルで評価・実行を行うと self-consistency bias
**対策**: Reviewerに **独立した評価rubric** を与え、「N個の問題を見つけること」を明示的タスクに。**別モデル使用** が望ましい

### AP-2: 役割境界の曖昧化（Role Drift）

**症状**: Plannerが実装を始める、Implementerが要件を勝手に変更
**対策**: Inception prompting（役割を毎ターン再確認）、ツール権限を役割に応じて制限

### AP-3: エラー伝播（Cascading Errors）

**症状**: 上流ロールの誤りが下流に伝播、QAで発覚するまで修正コスト爆発
**対策**: フェーズ間に軽量な構造化バリデーション（JSONスキーマ検証）

### AP-4: コンテキスト爆発（Context Overflow）

**症状**: チャット履歴・中間成果物が膨大、後半エージェントがコンテキスト超過
**対策**: フェーズ区切りでの圧縮サマリー、外部ファイルへの成果物書き出し

### AP-5: 無限改善ループ（Unbound Refinement）

**症状**: Improverが延々と改善を提案、完了条件を満たさない
**対策**: 最大イテレーション数・品質スコア閾値・時間制限のいずれかを必須化 → **Termination Judge ロール**

### AP-6: ツール権限の過剰付与

**症状**: ReviewerがコードDELETE可、InvestigatorがDB書き込み可
**対策**: 役割ごとに read-only / write の権限レベルを明示定義

### AP-7: 過剰分割によるオーバーヘッド爆発 ⚠️ Anthropic公式警告

**症状**: 7ロール以上に細分化、handoffオーバーヘッドがタスクコストを上回る
**対策**: まず最小構成（3ロール程度）で実装、ボトルネック箇所のみ分割

## 「動作確認なしマージ」を防ぐ実効的な手法（重要）

### 手法1: サンドボックス実行ゲート（Voyager / AutoGen型）

```python
# Executorエージェントのツール定義例
def run_tests_in_sandbox(code_path: str, test_path: str) -> dict:
    result = subprocess.run(
        ["docker", "run", "--rm", "--network=none",
         "-v", f"{code_path}:/app",
         "python:3.12-slim",
         "pytest", test_path, "--json-report"],
        capture_output=True, timeout=60
    )
    return json.loads(result.stdout)
```

**信頼性**: 高（決定論的）
**オーバーヘッド**: 中〜高（コンテナ起動コスト）

### 手法2: Golden Artefact Diff（回帰検証）

既知の正解出力（golden artefact）とdiff比較。差分が許容範囲外ならエスカレーション

**信頼性**: 中、**オーバーヘッド**: 低
**適用場面**: APIレスポンス形式、生成コードのスケルトン

### 手法3: LLM-as-Judge with Rubric

```
Rubric例（コードレビュー）:
1. 要件との整合性 (0-3点): PRDの要件を全て満たしているか
2. テスト可能性 (0-2点): 単体テストが存在し実行可能か
3. エラーハンドリング (0-2点): 例外が適切に処理されているか
4. セキュリティ (0-3点): インジェクション・認証漏れがないか
合計10点満点、7点未満はreject
```

**重要**: OpenAI実用ガイドは「LLM-as-judgeは決定論的テストと組み合わせてこそ有効」と強調

### 手法4: Human-in-the-Loop チェックポイント

**Anthropic推奨**: "Irreversible actions（PR merge, deploy, DB write）は必ずHuman checkpointを設置せよ"

### 手法5: Pre-commit Hook / CI ゲート統合

```bash
# implementerエージェントのツール実行フロー
1. git add <changed_files>
2. pre-commit run --all-files  # 失敗したら実装に戻る
3. pytest tests/ -x            # 失敗したら実装に戻る
4. gh pr create --draft        # 全pass後のみ
```

**iris適用**: `pnpm check && pnpm test && pnpm pr:flow create` の順を強制

## メモリ・通信設計の選択肢

### Option 1: Shared File System（ファイルベース）

```
/workspace/
  ├── prd.md              # PMが作成、全員が読む
  ├── design.md           # Plannerが作成
  ├── tasks.json          # タスクキュー
  ├── implementation/     # Implementerが書く
  ├── review_notes.md     # Reviewerが書く
  └── test_results.json   # Executorが書く
```

シンプル・永続的・ツール不要・gitと相性が良い。**iris での採用候補No.1**

### Option 2: Blackboard Pattern（共有メッセージプール、MetaGPT型）

中央構造化ストア（JSON DB or Redis）に全ロールが発行・購読

### Option 3: 会話履歴（AutoGen型）

GroupChatの発言履歴をそのままメモリに

### Option 4: Episodic Memory with Embedding（Reflexion + Generative Agents型）

ベクトルDB + セマンティック検索

### Option 5: Memory MCP（Anthropic推奨の新アプローチ）

MCPサーバーとして記憶管理を外部化、エージェントが`memory_store` / `memory_retrieve` で読み書き

## 我々のロール構成 (PM / planner / implementer / reviewer / improver / investigator) への評価

### 妥当な点

1. **PM と planner の分離は正しい**: MetaGPT・ChatDevともに「要求定義（Why/What）」と「技術設計（How）」を別ロールに
2. **reviewer と improver の分離**: Self-Refine論文「評価者と改善者が同一だとバイアスが残る」根拠
3. **investigator の独立**: Anthropic並列サブエージェントパターンと一致

### 統合した方がよい役割

- **reviewer + improver の統合検討**: ChatDev「Reviewer↔Programmer対話ループ」を単一フェーズに統合する選択肢あり。ただしreviewerの独立性を保つために分離する価値はある
- **investigator は PM 配下のサブエージェント** として実装可。頻繁に使うなら独立ロールとして常設

### ⚠️ 抜けている役割（追加候補）

#### 1. Executor / Sandbox Runner ⭐⭐⭐ 最重要

現構成に **実行・検証を担う独立エージェントが明示されていない**。SWE-bench上位手法・AutoGen・Voyagerのいずれも実行検証エージェントを独立。implementerがテストを走らせると「自分で書いて自分でテスト」になりバイアス。

**推奨追加**: `executor` ロール（read-only on codebase, execute-only on test runner）

iris での具体形: `pnpm check && pnpm test` を実行して結果JSONを返す独立 subagent / tool。

#### 2. Architect / Tech Lead（必要に応じて）

plannerが技術設計とタスク分解を兼ねている場合、大きなタスクで品質低下リスク（推測）。規模次第で分離

#### 3. Termination Judge（終了判断エージェント）

improver↔reviewer のループを終了させる独立判断者。Reflexion警告通り終了条件評価が必要

## 追加深堀ポイント

1. **SWE-bench Resolvedレートとロール構成の相関**: Devin/SWE-agent/OpenHandsの内部アーキ比較。Agentlessのシンプルパイプラインが複雑マルチエージェントを上回るケースは示唆的
2. **コスト対効果の実測**: ロール数増加 → LLM呼び出し回数線形以上に増加。1タスクあたりトークンコストをロール数の関数として測定
3. **エージェント間の信頼レベル設計**: PMが高権限、サブエージェントは原則低権限。implementerが直接git pushできるかは重要判断点
4. **Structured Output の徹底**: MetaGPT最重要知見。planner→implementerのhandoffデータ構造をJSONスキーマで形式化することで品質大幅向上
5. **非同期 vs 同期**: investigator並列実行時、部分結果でplannerが判断を始めるか（非同期）、バリア待ちか。Anthropic研究システムは **バリア同期** 採用

---

> **注記**: WebSearch・WebFetch の実行権限が本セッションで拒否されたため、本レポートは学習データ（カットオフ: 2025年8月）の知識ベース。URLの一部（特にAnthropicのEngineering blog）は正確なパスが確認できていない可能性。実装判断前に一次URL確認推奨。
