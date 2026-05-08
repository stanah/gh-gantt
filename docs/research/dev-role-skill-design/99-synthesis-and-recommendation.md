# 横断総括と推奨アーキテクチャ

> 作成日: 2026-05-08
> 4つの調査ドメインを統合した最終提案

## TL;DR

1. **新フレームワーク導入は必要ない**。iris の既存資産 (`pnpm pr:flow`, `pnpm check`, `pnpm test`, `gh-gantt`, `codex CLI`) と Claude Code の subagent 機能だけで、ロール分離型オーケストレーションは構築可能。
2. **ロール分割は 5 種で開始**: PM (Claude本セッション) / planner / implementer (codex) / **executor** / reviewer。当初構想にはなかった **executor (deterministic gate)** の追加が最重要。
3. **「動作確認なしマージ」問題の根治**は: implementer が PR を作る **前段** に `pnpm check && pnpm test` を強制する `executor` ロールを物理的に挟むこと。これが第一歩で、reviewer 強化は第二歩。
4. **Reviewer は 2 系統独立必須**: codex review (Codex モデル) + reviewer-claude (Claude subagent) のモデル混合で Yes-Man バイアス除去。
5. **段階導入が可能**: MVP は 1 Issue × 1 PR の最小フローから。1週間でプロト、1ヶ月で実運用試験。

## 4ドメイン横断の発見

### 発見1: 我々のロール分割に「Executor」が欠落していた

**Domain C** (ロール設計パターン調査) の最重要指摘:

> 現構成に実行・検証を担う独立エージェントが明示されていない。SWE-bench 上位手法・AutoGen・Voyager のいずれも実行検証エージェントを独立させている。implementer がテストを走らせると「自分で書いて自分でテスト」になりバイアスが残る。

これは **当初構想 (PM/planner/implementer/reviewer/improver/investigator) では完全に見落とされていたロール**。SWE-bench Resolved Rate 上位手法の共通点である「テスト実行を独立工程化」を踏襲する必要がある。

**iris での具体形**: `pnpm check && pnpm test` (および smoke tests) を独立 subagent or 単純なBash実行ゲートとして PR 作成前に必須化。

### 発見2: iris 既存資産で 7 割が満たされている

**Domain D** で確認したように、iris には:

- `pnpm pr:flow create/sweep/poll/resolve/merge` — PR管理CLI (PM風挙動を既に内包)
- `pnpm check` — ADR + requirements + 全パッケージ check (Executorゲートとして使える)
- `pnpm test` — unit + smoke + Python pytest
- `pnpm smoke:desktop-*` — E2E smoke
- `.gantt-sync/` + gh-gantt skill — Issue ⇄ Project の双方向同期
- `docs/pr-review-merge-flow.md` — Codex運用の正典
- `.claude/settings.local.json` — 既存allowlist

これら全てが揃っている。**「動作確認なしマージ」問題の根本原因は仕組みの不在ではなく、Codex セッションが既存ゲートを尊重せず素通りしてしまう運用の弱さ** にある。

### 発見3: codex CLI に「reviewer 専用サブコマンド」がある

**Domain D** での発見:

```
codex review [PROMPT]
  --base <BRANCH>     # 比較対象ブランチ
  --commit <SHA>      # 特定 commit のレビュー
  --uncommitted       # staged/unstaged/untracked をレビュー
  --title <TITLE>     # レビューサマリ用タイトル
```

これは reviewer ロールの素地。我々が新規に「Codex reviewer agent」を書く必要がない。

### 発見4: codex exec --output-schema で artifact 駆動 handoff が成立

**Domain D** + **Domain C** (MetaGPT 流):

```
codex exec --output-schema plan.schema.json [PROMPT]
```

→ implementer が **構造化JSONで結果を返す** ことを強制可能。MetaGPT が示した「成果物の形式化がエラー伝播を防ぐ最重要因子」に直接対応する仕組み。

### 発見5: codex cloud exec --attempts N で improver の素地

**Domain D**:

```
codex cloud exec --env <ENV_ID> --attempts N
```

→ best-of-N サンプリング標準サポート。improver の「複数案から最良選択」ロジックの素地。

### 発見6: Yes-Man バイアスを避けるには「異モデルの reviewer 2人」

**Domain C** の CAMEL論文 / Self-Refine論文 の警告から:

> 同じモデルが評価と実行を兼ねると系統的なバイアスが除去されない

→ Claude (Anthropic) 一辺倒も、Codex (OpenAI) 一辺倒もダメ。**reviewer = Codex review + Claude subagent の2系統独立** がベストプラクティス。

### 発見7: 過剰分割への警告

**Domain C** の Anthropic「Building Effective Agents」公式警告:

> Don't build multi-agent systems when single agents suffice
> 7ロール以上に細分化、handoffオーバーヘッドがタスクコストを上回る

→ 当初の 6 ロール (PM/planner/implementer/reviewer/improver/investigator) はやや過剰。**最初は 5 ロールに圧縮、必要なら段階的に増やす**。

具体的な圧縮:

- **investigator** は plannerの「調査フェーズ」または PM が必要時に dispatching-parallel-agents で別 subagent 起動 → 常設しない
- **improver** は reviewer の指摘を受けた **implementer の再実行** で代用可能 → 専任化しない

→ 圧縮後: **PM / planner / implementer / executor / reviewer ×2** の 5 ロール (executor とreviewer×2 を追加してもなお 5)

## 推奨アーキテクチャ (最終形)

### コアの ASCII 図

```
                ┌──────────────────────────────────────────────────────┐
                │  Claude Code session (PM + Termination Judge)        │
                │                                                      │
                │  - skill: gh-gantt-* / pr-review-flow                │
                │  - subagent: planner / reviewer-claude / improver    │
                │  - Bash tool: codex / pnpm / gh / git                │
                │  - file scratchpad: docs/orchestration/<issue#>/     │
                └────────┬─────────────────────────────────────────────┘
                         │
       ╔═════════════════╪═══════════════════════════════════╗
       ║                 ▼                                   ║
       ║        ┌─────────────────┐                          ║
       ║        │ planner (subagent)                         ║
       ║        │ Sonnet         │                          ║
       ║        │ Issue → JSON   │                          ║
       ║        │ 計画文書       │                          ║
       ║        └────────┬────────┘                          ║
       ║                 │ plan.json                         ║
       ║                 ▼                                   ║
       ║        ┌─────────────────────────┐                  ║
       ║        │ implementer (Bash tool) │                  ║
       ║        │ codex exec --output-    │                  ║
       ║        │  schema plan.schema     │                  ║
       ║        │  --full-auto -C <wt>    │                  ║
       ║        └────────┬────────────────┘                  ║
       ║                 │                                   ║
       ║                 ▼                                   ║
       ║        ┌─────────────────────────┐                  ║
       ║        │ executor (Bash gate)    │ ← deterministic  ║
       ║        │ pnpm check &&           │                  ║
       ║        │ pnpm test &&            │                  ║
       ║        │ pnpm smoke:relevant     │                  ║
       ║        └────────┬────────────────┘                  ║
       ║                 │ pass? ────fail────► (back to impl)║
       ║                 ▼ pass                              ║
       ║        ┌────────┴────────────┐                      ║
       ║        │ reviewer #1 (Codex) │ reviewer #2 (Claude) ║
       ║        │ codex review        │ subagent rubric付き  ║
       ║        │  --uncommitted      │                      ║
       ║        └────────┬────────────┴───────┬──────────────╝
       ║                 ▼                    ▼
       ║        ┌─────────────────────────────────┐
       ║        │ improver = implementer 再呼出   │
       ║        │ (PMが指摘を統合してretry)        │
       ║        └────────┬────────────────────────┘
       ║                 │ all OK or max-iter
       ║                 ▼
       ║        ┌─────────────────────────┐
       ║        │ pnpm pr:flow create     │
       ║        │  --issue --summary --   │
       ║        │  change --verification  │
       ║        └────────┬────────────────┘
       ║                 ▼
       ║        ┌─────────────────────────┐
       ║        │ 既存の poll/resolve/    │
       ║        │ merge フロー (人間混在)  │
       ║        └─────────────────────────┘
       ╚═════════════════════════════════════════════════════╝
```

### ロール別責務

| ロール                | 実体                               | モデル                    | 権限                                  | 入力                               | 出力                              |
| --------------------- | ---------------------------------- | ------------------------- | ------------------------------------- | ---------------------------------- | --------------------------------- |
| **PM**                | 本Claude session                   | Opus 4.7 (本タスクと同じ) | フル                                  | Issue #                            | 全工程の指揮 + 最終 merge 判断    |
| **planner**           | named subagent                     | Sonnet                    | read-only on repo                     | Issue内容 + AC                     | `plan.json` (構造化計画)          |
| **implementer**       | `codex exec` Bash tool             | Codex (OpenAI)            | workspace-write on dedicated worktree | `plan.json`                        | コード変更 + `result.json`        |
| **executor**          | Bash gate (subagent ではない)      | –                         | execute on test runner                | working tree                       | exit code + test result JSON      |
| **reviewer #1**       | `codex review` Bash tool           | Codex (OpenAI)            | read-only on diff                     | working diff                       | `review-codex.json`               |
| **reviewer #2**       | named subagent                     | Sonnet                    | read-only on diff                     | working diff + plan + review-codex | `review-claude.json` (rubric付き) |
| **improver**          | implementer 再実行 (PM が呼び直す) | Codex                     | workspace-write                       | reviewer 統合指摘                  | コード変更 (再)                   |
| **Termination Judge** | PM 自身の判断                      | Opus                      | –                                     | review履歴 + iter数                | 「完了/再ループ/PR化」            |

### 通信・メモリ設計

**Domain C** の Option 1 (Shared File System) を採用:

```
docs/orchestration/<issue-number>/
  ├── 00-issue.md            # Issue原文と PMメモ
  ├── 01-plan.json           # planner成果物
  ├── 02-implementation/     # implementer 出力 (codex exec output)
  │     └── result.json
  ├── 03-executor.json       # pnpm check/test 結果
  ├── 04-review-codex.json   # codex review 結果
  ├── 05-review-claude.json  # reviewer-claude 結果
  ├── 06-improver-loop/
  │     ├── iter-1/...
  │     └── iter-2/...
  └── 99-pm-decision.md      # 最終判断ログ
```

**理由**:

- gitと相性がよく、デバッグ可能
- PM が file scratchpad で状態を保持できる
- 並列実行時の競合リスク低 (issue#でnamespace分離)

### スキーマ定義

#### plan.schema.json (planner → implementer)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema",
  "type": "object",
  "required": ["issueNumber", "summary", "fileChanges", "verificationSteps", "acceptanceCriteria"],
  "properties": {
    "issueNumber": { "type": "integer" },
    "summary": { "type": "string", "description": "1-2文の変更サマリ" },
    "rationale": { "type": "string", "description": "技術判断の根拠" },
    "fileChanges": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["path", "action", "description"],
        "properties": {
          "path": { "type": "string" },
          "action": { "enum": ["create", "modify", "delete"] },
          "description": { "type": "string" }
        }
      }
    },
    "newTests": {
      "type": "array",
      "items": { "type": "string", "description": "新規テストファイルのパスと範囲" }
    },
    "verificationSteps": {
      "type": "array",
      "items": { "type": "string", "description": "pnpm check, pnpm test, smoke コマンドなど" },
      "minItems": 1
    },
    "acceptanceCriteria": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "outOfScope": {
      "type": "array",
      "items": { "type": "string", "description": "意図的にやらないこと" }
    },
    "risks": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

#### review.schema.json (reviewer 共通)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema",
  "type": "object",
  "required": ["verdict", "scoreBreakdown", "findings"],
  "properties": {
    "verdict": { "enum": ["approve", "request-changes", "comment"] },
    "scoreBreakdown": {
      "type": "object",
      "properties": {
        "requirementsAlignment": { "type": "integer", "minimum": 0, "maximum": 3 },
        "testability": { "type": "integer", "minimum": 0, "maximum": 2 },
        "errorHandling": { "type": "integer", "minimum": 0, "maximum": 2 },
        "security": { "type": "integer", "minimum": 0, "maximum": 3 }
      }
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "location", "issue", "suggestion"],
        "properties": {
          "severity": { "enum": ["critical", "major", "minor", "nit"] },
          "location": { "type": "string", "description": "file:line or scope" },
          "issue": { "type": "string" },
          "suggestion": { "type": "string" }
        }
      }
    }
  }
}
```

### 終了条件 (Termination Judge ロジック)

PM (本セッション) が以下のいずれかで loop を抜ける:

1. **両 reviewer (Codex + Claude) が `verdict: approve`** → PR化へ
2. **iter 数 ≥ 3** → 残課題を PR description に明示してPR化 (人間レビューに委ねる)
3. **executor が連続 2 回 fail** → タスクを ISSUE_BLOCKED として人間にエスカレーション
4. **重大な findings (severity: critical) が一定数 → 人間にエスカレーション**

## MVP 開発ロードマップ

### Phase 1: 動作確認ゲート強制 (1日)

**最小の改善 = 最大の効果**: implementer が PR 作成前に必ず executor を通る仕組み。

実装:

- `scripts/pr-review-flow.mjs` に `pre-pr-gate` サブコマンド追加
- `pnpm pr:flow pre-pr-gate` = `pnpm check && pnpm test && pnpm smoke:<関連>`
- `pnpm pr:flow create` の冒頭で `pre-pr-gate` を必須実行 (`--skip-gate` でのみskip可、明示)
- `docs/pr-review-merge-flow.md` の Agent手順に明文化

**期待効果**: 「動作確認なしマージ」問題の 8 割を即座に解消

### Phase 2: planner / implementer / executor の3ロール最小プロト (3〜5日)

実装:

- `~/.claude/agents/iris-planner.md` (subagent定義)
- `docs/orchestration/plan.schema.json`
- `scripts/orchestrate.mjs` (PMエントリ): Issue # を引数に Phase 2フローを実行
- `pnpm orchestrate <issue#>` で 1 Issue を planner → implementer (codex) → executor → 手動 PR レビュー

### Phase 3: reviewer 2系統 + improver loop (1週間)

実装:

- `~/.claude/agents/iris-reviewer.md` (Claude rubric reviewer)
- `docs/orchestration/review.schema.json`
- `scripts/orchestrate.mjs` に reviewer ステップ + improvement loop 追加
- Termination Judge ロジック (max-iter / verdict合算)

### Phase 4: gh-gantt 連携と PR運用統合 (3〜5日)

実装:

- `gh-gantt-decompose` skill との接続 (Issue→子タスク自動分解)
- `pnpm pr:flow create` 後の自動 poll / resolve / merge ループに繋ぐ
- `.gantt-sync` の競合検知

### Phase 5: 並列タスク + 監視 (1週間〜)

実装:

- 複数 Issue を並列処理する PM 拡張
- worktree自動作成 + cleanup
- メトリクス: 1タスクあたりトークンコスト、reviewer pass率、improvement iteration数

## 設計判断のサマリ

| 判断                  | 結論                                                           | 根拠                                                                 |
| --------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| 新フレームワーク導入? | **しない (Claude Code直叩き)**                                 | 既存資産で7割充足、学習コスト最小、段階導入容易                      |
| Python移行?           | しない (TypeScript + Bash + Skill)                             | iris は TS主体、PMはClaude Code session                              |
| ロール数              | **5 (PM/planner/implementer/executor/reviewer×2)**             | 過剰分割を避ける Anthropic推奨。investigator/improver は別形態に圧縮 |
| メモリ                | **File scratchpad** (`docs/orchestration/<issue#>/`)           | gitと相性、デバッグ容易                                              |
| handoffデータ         | **JSON Schema強制** (`plan.schema.json`, `review.schema.json`) | MetaGPT「artifact駆動」最重要知見                                    |
| Reviewer モデル       | **Codex + Claude の2系統独立**                                 | CAMEL/Self-Refine警告: Yes-Man回避                                   |
| Executor の置き場     | **PR作成 _前_ の必須ゲート**                                   | "動作確認なしマージ" 問題の根治                                      |
| 終了条件              | **PM=Termination Judge** が判定 (max iter 3)                   | Reflexion警告: 無限loop防止                                          |
| Improver              | **専任ロールにせず implementer 再呼出**                        | 5ロール超過の回避                                                    |
| Investigator          | **常設せず PM が必要時 dispatching-parallel-agents**           | 6ロール超過の回避                                                    |
| 一次オーケストレータ  | **Claude Code subagent + Bash tool**                           | 案1                                                                  |
| 二次パス (将来)       | **GitHub Actions駆動**                                         | 案3 (CIで完全自動化したい時)                                         |

## ベストプラクティス遵守チェック

| Anthropic / OpenAI / 学術界の指針                         | 我々の設計                                     |
| --------------------------------------------------------- | ---------------------------------------------- |
| 「過度な複雑化を避けよ」 (Anthropic)                      | ✅ 5ロール、段階導入                           |
| 「Evaluatorは独立モデル」 (Anthropic)                     | ✅ Codex + Claude 2系統                        |
| 「Irreversible actionsはHuman checkpoint」 (Anthropic)    | ✅ Mergeは既存pr:flowを尊重 (人間 settle 必須) |
| 「LLM-as-judge + deterministic」 (OpenAI)                 | ✅ reviewer + executor (pnpm check/test)       |
| 「Structured Output徹底」 (MetaGPT)                       | ✅ JSON Schema強制                             |
| 「テスト実行を独立工程に」 (SWE-bench上位)                | ✅ executor ロール                             |
| 「Yes-Manを避ける」 (CAMEL)                               | ✅ モデル混合 + rubric                         |
| 「ループ終了条件を明示」 (Reflexion)                      | ✅ Termination Judge                           |
| 「最小権限の原則」 (Anthropic SDK)                        | ✅ 役割別 sandbox / read-only指定              |
| 「contextオーバーフローへの圧縮」 (Anthropic Engineering) | ✅ file scratchpad で状態外出し                |

## 残された未解決論点 (brainstormingで議論したい)

1. **Issue → 子タスク自動分解の粒度**: 1 PR = 1 issue か、子タスクごとに別PRを作るか
2. **並列度の上限**: 同時に何 Issue まで並列処理する? worktree何本まで?
3. **コスト予算管理**: 1タスクあたりトークン予算、超過時の挙動
4. **既存 Codex セッションとの共存**: 現在 main worktree で動いているCodex session (avatar-drag-resize-runtime-fix 等) との衝突回避
5. **失敗 Issue のリトライ戦略**: ISSUE_BLOCKED ラベル付与 + 人間レビュー後のリトライ手順
6. **`.gantt-sync` の同期タイミング**: 各フェーズ完了時に push? 最後にまとめて?
7. **本セッションを長時間保持する手段**: 親 Claude Code を `nohup` 風に走らせるか、定期 `/loop` で起動するか
8. **Termination Judge を別 subagent に切り出すか**: Self-Refine回避のため Termination も独立判断者にするか

## 次のアクション

1. 本レポートをユーザーが review (現在地)
2. **brainstorming スキル** で上記「残された未解決論点」を議論
3. 議論結果を **PRD化** (`write-a-prd` または `to-prd` skill)
4. **prd-to-plan / prd-to-issues** で tracer-bullet 分解
5. **Phase 1 (executor gate強制) を最初の MVP として実装**
