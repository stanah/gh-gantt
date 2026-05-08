# Domain D: iris環境への統合経路調査

> 調査者: Claude (親セッション, Bash/Read 直接)
> 調査日: 2026-05-08
> ソース: 実機実行 (`codex --help`, `gh issue list`, `cat`, `ls`) + 公式docs

## 1. 既知の素材まとめ

### 1.1 Codex CLI (`/Users/stanah/.bun/bin/codex` v0.122.0)

サブコマンド: `exec` `review` `login` `mcp` `mcp-server` `app-server` `cloud` `apply` `resume` `fork` `sandbox` `debug`

### 1.2 Claude Code (本セッションが該当)

- skill / subagent / hook / MCP server サポート
- `~/.claude/settings.json` がユーザー設定 (今回 WebFetch ドメイン限定で更新済み)
- claude-code-action (GitHub Action)
- Claude Agent SDK (Python / TypeScript)

### 1.3 gh-gantt (skill plugin として既稼働)

- skill 一覧: `gh-gantt-workflow` `gh-gantt-decompose` `gh-gantt-progress` `gh-gantt-sync` `gh-gantt-conflict-resolution` `gh-gantt-dependencies`
- iris repo 内 `.gantt-sync/`:
  - `gantt.config.json` `sync-state.json` `tasks.json` `workflow.md`
- GitHub Project ID: `PVT_kwHOAF4cLM4BVpHF` (project_node_id) と issue を双方向同期

### 1.4 beads (skill plugin)

- バイナリ: `/Users/stanah/.local/bin/bd`
- skill: `ralph-tui-create-beads` (ralph-tui との連携でPRD→タスク)
- `br` (beads-rust) は **未インストール**

### 1.5 ralph-tui (skill plugin)

- skill: `ralph-tui-prd` `ralph-tui-create-beads` `ralph-tui-create-beads-rust` `ralph-tui-create-json`
- PRD → beads issues / prd.json への変換ワークフロー

### 1.6 iris repo の既存自動化

| 場所                                            | 役割                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `.github/workflows/ci.yml`                      | CI (build/lint/test)                                   |
| `.github/workflows/cd.yml`                      | CD                                                     |
| `scripts/pr-review-flow.mjs`                    | **PR管理CLI (create/status/sweep/poll/resolve/merge)** |
| `scripts/pr-review-flow.test.mjs`               | 上記のテスト                                           |
| `docs/pr-review-merge-flow.md`                  | **PR運用の正典** (Codex 用に明文化)                    |
| `scripts/adr/check.mjs`                         | ADR整合性検査                                          |
| `scripts/requirements/check.mjs` `generate.mjs` | 要件文書整合                                           |
| `scripts/desktop-*-smoke.mjs`                   | E2E smoke (motion-generator/vision-ipc/tts-playback)   |
| `scripts/run-local-model-e2e.mjs`               | local model E2E                                        |
| `package.json` `pnpm check`                     | ADR + requirements + 全パッケージ check                |
| `package.json` `pnpm test`                      | unit + smoke + Python pytest                           |

### 1.7 iris `.claude/settings.local.json` 既存allowlist (抜粋)

- `Bash(bd *)` (beadsコマンド)
- `Bash(pnpm nx:*)` `Bash(npx nx:*)` `Bash(pnpm run:*)`
- `Bash(git add:*)` `Bash(cd:*)`
- `WebSearch`, `WebFetch(domain:github.com|raw.githubusercontent.com|arxiv.org)`
- `mcp__plugin_playwright_*` (Playwright MCP)
- `mcp__plugin_context7_*` (Context7 MCP)
- `Read(//Users/stanah/work/github.com/Tencent-Hunyuan/HY-Motion-1.0/**)`

## 2. codex CLI 機能マップ（PMから呼び出す視点）

| サブコマンド                               | 用途                                                                                                                                                                                                                                                                       | 非対話 | 入出力                                | 承認モデル                                                | 適合する役割                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `codex exec [PROMPT]`                      | 任意プロンプトで非対話タスク。stdin読込可 (`-`)。`--output-schema <FILE>` でJSON Schema出力強制。`-s read-only/workspace-write/danger-full-access` でsandbox段階指定。`--full-auto` (=workspace-write)。`-C <DIR>` で作業ディレクトリ指定。`--ephemeral` でsession非永続化 | ✅     | stdin/argv → stdout (JSON Schema化可) | `--dangerously-bypass-approvals-and-sandbox` 以外は段階的 | **implementer / investigator**                  |
| `codex exec resume`                        | 既存sessionを再開 (`--last` で最新)                                                                                                                                                                                                                                        | ✅     | session id                            | あり                                                      | implementerの継続                               |
| `codex review [PROMPT]`                    | **コードレビュー専用**。`--base <BRANCH>` `--commit <SHA>` `--uncommitted` `--title <TITLE>` でレビュー対象指定                                                                                                                                                            | ✅     | argv/stdin → review output            | あり                                                      | **reviewer (専用CLI)** ⭐                       |
| `codex cloud exec --env <ENV_ID> [QUERY]`  | Codex Cloud にタスク投入。**`--attempts N` で best-of-N**。`--branch` で対象指定                                                                                                                                                                                           | ✅     | クラウド非同期                        | クラウドsandbox                                           | **implementer (並列)**                          |
| `codex cloud list / status / diff / apply` | クラウドタスクの一覧・状態・差分・取込                                                                                                                                                                                                                                     | ✅     | task_id操作                           | –                                                         | 結果取り込み                                    |
| `codex mcp-server`                         | Codex を MCP server として起動 (stdio)                                                                                                                                                                                                                                     | ✅     | MCP protocol                          | あり                                                      | **Claude Code から MCP tool として呼び出し** ⭐ |
| `codex app-server`                         | JSON-RPC 2.0 (stdio/ws)。`--listen ws://127.0.0.1:4500` 等                                                                                                                                                                                                                 | ✅     | JSON-RPC                              | あり                                                      | リッチクライアント統合                          |
| `codex apply`                              | Codex agent が出した最新diffを git apply                                                                                                                                                                                                                                   | ✅     | working tree                          | –                                                         | implementerの結果適用                           |
| `codex sandbox`                            | Codex提供 sandbox 内でコマンド実行                                                                                                                                                                                                                                         | ✅     | shell                                 | sandbox                                                   | executor的用途                                  |

### 重要オプション解説

- **`--output-schema <FILE>`** (codex exec): **MetaGPT流のartifact駆動handoffを実現可能**。implementerが構造化JSON出力 → plannerやreviewerが安心して入力にできる
- **`--attempts N`** (codex cloud exec): **best-of-N サンプリング**。improverロジックをCodex側に押し出せる。実装の品質バリエーションを Cloud で並列生成し、reviewerが選別
- **`-s read-only/workspace-write/danger-full-access`**: 役割ごとにsandbox強度を分けられる。investigator → read-only、implementer → workspace-write
- **`--add-dir <DIR>`**: 主workspace以外も書き込み可能に (multi-package モノレポに有用)
- **`-C <DIR>`**: 作業ディレクトリ指定 → worktreeごとに別実行が容易
- **`--ephemeral`**: sessionを永続化しない → 並列起動時のセッション衝突回避

## 3. iris の既存ワークフローとの接続点

### 3.1 `pnpm pr:flow` (`scripts/pr-review-flow.mjs`) のサブコマンド

```
pr:flow create   --title --issue --close-issue --repo --summary --change --verification --base --draft --skip-sweep
pr:flow status   --pr --repo --include-outdated --fail-on-unresolved
pr:flow sweep    --repo --include-outdated --fix-codex-branches --json --fail-on-action-needed
pr:flow poll     --pr --interval-seconds --timeout-minutes
pr:flow resolve  --pr --yes --include-outdated --dry-run
pr:flow merge    --pr --yes --repo --include-outdated --settle-minutes --interval-seconds
                 --timeout-minutes --method --delete-branch --auto --skip-sweep
```

これは **既に「PM × reviewer 連携CLI」**として動作している。

### 3.2 `docs/pr-review-merge-flow.md` の「Agent手順」(現行運用)

1. 作業 Issue を `In Review` に更新し、`gh-gantt push --yes`
2. `git pull --rebase` 後に commit / push
3. `pnpm pr:flow sweep --include-outdated` で既存 open PR を確認
4. `pnpm pr:flow create` で日本語 PR を作る
5. `pnpm pr:flow poll` で自動レビューを待つ
6. `pnpm pr:flow status` で未解決 thread を確認、コードを修正
7. 修正 commit / push 後、対応 thread を `pnpm pr:flow resolve --include-outdated --yes` で resolve
8. `pnpm pr:flow merge --include-outdated --yes` で settle 待機後 merge
9. merge 後の sweep 結果を見て残り PR の conflict / unresolved 処理

→ **「Agentが手順 5-8 の途中で止まらないこと」を要求** している。我々の reviewer ロールはここに差し込む。

### 3.3 reviewer/executor を差し込める箇所

| 既存フェーズ           | 差し込みポイント                                                               | 提案ロール                        |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| PR作成前               | `pnpm pr:flow create` の **前段** に `pnpm check && pnpm test` を強制          | **Executor (deterministic gate)** |
| PR作成直後             | `pnpm pr:flow poll` の **代わりに**、自前 reviewer subagent が即時 PR レビュー | **Reviewer #1 (Claude独立判断)**  |
| 既存自動レビューと並列 | CodeRabbit 等の自動レビューと並行で `codex review --base main`                 | **Reviewer #2 (Codex独立判断)**   |
| thread resolve前       | improver subagent が修正案をまとめて `pnpm pr:flow resolve` を発火             | **Improver**                      |
| settle/merge前         | Termination Judge が「もうレビューループ十分」を判定                           | **Termination Judge**             |

## 4. 構築アーキテクチャ3案

### 案1: Claude PM + Codex tool (Bash経由) ⭐ 本命

```
                ┌─────────────────────────────────────┐
                │ Claude Code session (PM)            │
                │  - skill: gh-gantt-* / pr-review    │
                │  - subagent: planner / reviewer-cl  │
                │      / improver / termination       │
                │  - Bash tool: codex / pnpm / gh     │
                │  - file scratchpad: docs/pipeline/  │
                └────────┬────────────────────────────┘
                         │ Bash invoke
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  ┌──────────┐    ┌────────────┐    ┌──────────────┐
  │codex exec│    │codex review│    │pnpm check &  │
  │ (impl)   │    │ (review #1)│    │  pnpm test   │
  │ --output-│    │            │    │ (executor    │
  │  schema  │    │            │    │  gate)       │
  └──────────┘    └────────────┘    └──────────────┘
        │
        ▼
   ┌──────────────────┐
   │pnpm pr:flow      │
   │  create/poll/... │
   └──────────────────┘
```

**長所**:

- 新規ライブラリ導入不要
- iris 既存資産 (`pnpm pr:flow`, `pnpm check`, `pnpm test`) をそのまま利用
- subagent で複数 Claude ロールを分離 (Yes-Man回避)
- Codex CLI を tool として直接呼ぶ
- 段階的に導入可能 (まず executor gate だけ追加、次に reviewer 追加…)

**短所**:

- 親 Claude Code セッションを長時間保持する必要 (ただし背景タスクで分離可)
- TypeScript SDK での再実装は別途必要 (CI/Actions駆動にしたい場合)

**コスト**: Anthropic API + OpenAI API。中程度

### 案2: codex app-server + Claude Agent SDK (長時間プロセス)

```
[Python/TS service]
  Claude Agent SDK (PM)
    │
    │ JSON-RPC 2.0 (stdio or ws://127.0.0.1:4500)
    ▼
  codex app-server (long-running)
    - thread/start, turn/start, item/agentMessage/delta ストリーム
    - 承認フロー、スキル呼び出し
```

**長所**:

- ストリーム応答ハンドリング、承認フローを綿密に制御可
- 長時間タスク (1Issue → multiple PR) を1プロセスで管理
- PythonかTSで PM ロジックを表現できる

**短所**:

- 実装コスト高 (JSON-RPC client, 承認ハンドラ実装)
- app-server は experimental
- 学習曲線急
- デバッグ難

**コスト**: 実装工数大 + Anthropic + OpenAI API

### 案3: GitHub Actions駆動 (event-driven)

```
GitHub Issue opened
  ↓
GitHub Actions:
  - Step 1: gh-gantt-decompose で Issue 分解
  - Step 2: codex cloud exec --env <ENV> でクラウド実装
  - Step 3: codex review --base main で codex review
  - Step 4: claude-code-action @claude /review で Claude review
  - Step 5: pnpm check && pnpm test (matrix)
  - Step 6: gh pr create or pnpm pr:flow create
```

**長所**:

- stateless、再現性高
- GitHub Webhook駆動なので人間不在でも動く
- セキュリティモデルが明確 (Secrets管理)
- 監査ログがGHA上に残る

**短所**:

- Actions実行時間制限 (6h)
- 状態を持つループ (improver修正等) が組みにくい
- ローカル開発環境との挙動差
- 起動コスト (GHA spinup) で待ち時間増

**コスト**: GHA分 + OpenAI API + Anthropic API (相対的に安いケース多い)

## 5. 推奨案と最初の最小プロト

### 推奨: **案1 (Claude PM + Codex tool)** で MVP, 後日に応じて案3を追加

理由:

- iris の既存資産との接続が最良
- 学習・実装コスト最小
- ロール分離 (subagent) と動作確認ゲート (`pnpm check && pnpm test`) の差し込みが直感的
- 段階導入が可能

### MVP スコープ: 「1 Issue を新パイプラインで処理し PR が立つまで」

**ステップ**:

1. **gh-gantt-decompose** で Issue を子タスクに分解 (既存skill)
2. **planner subagent (Sonnet)**: 子タスクを構造化計画に (出力 JSON: ファイル変更計画 + AC + 検証手順)
3. **implementer**: `codex exec --output-schema plan.schema.json --full-auto -C <worktree>` で実装
4. **executor gate**: `pnpm check && pnpm test` を実行。**fail なら implementer に戻す**
5. **reviewer #1**: `codex review --uncommitted --title "..."`
6. **reviewer-claude subagent (Sonnet)**: PR diff を別文脈で独立評価 (rubric付き)
7. **improver subagent**: reviewer #1/#2 の指摘を統合して implementer に再パス
8. **Termination Judge** (PM自身): improvement loop の終了判定 (max 3 iter or all reviewers OK)
9. **PR作成**: `pnpm pr:flow create --title ... --issue <num> --summary ... --change ... --verification "pnpm check && pnpm test"`
10. **その後の merge ループ** は既存の `pnpm pr:flow poll/resolve/merge` をそのまま PM が呼ぶ

### 既存資産で再利用するもの

| 用途                           | 使うもの                                      |
| ------------------------------ | --------------------------------------------- |
| Issue 分解                     | `gh-gantt-decompose` skill                    |
| Issue → PR連携                 | `pnpm pr:flow`                                |
| PR Project sync                | `gh-gantt-sync` skill / `gh-gantt push --yes` |
| 動作確認ゲート                 | `pnpm check && pnpm test`                     |
| smoke E2E                      | `pnpm smoke:desktop-*`                        |
| 自動レビュー (人間/CodeRabbit) | `pnpm pr:flow poll` (既存)                    |

### 必要な新規実装

| 用途                         | 必要なもの                                               |
| ---------------------------- | -------------------------------------------------------- |
| PMオーケストレータ本体       | スクリプト or Skill (`/orchestrate <issue#>` のような形) |
| planner subagent定義         | `~/.claude/agents/iris-planner.md` (Markdown agent)      |
| reviewer-claude subagent定義 | `~/.claude/agents/iris-reviewer.md`                      |
| improver subagent定義        | `~/.claude/agents/iris-improver.md`                      |
| executor 統合点              | (既存scriptを呼ぶラッパー)                               |
| 構造化計画スキーマ           | `docs/orchestration/plan.schema.json`                    |
| 構造化レビュー結果スキーマ   | `docs/orchestration/review.schema.json`                  |
| pre-pr-gate サブコマンド     | `pnpm pr:flow pre-pr-gate` の追加                        |

## 6. リスク・落とし穴

### R-1: Codex CLI の認証スコープ

- iris の `gh` は macOS keyring 認証 → Codex sandbox 外で実行が必要
- `pnpm pr:flow` も同じ前提
- 解決: 親 Claude Code (sandboxなし) から Bash tool で叩く構成なら問題なし

### R-2: subagent の context 継承

- subagent は親の context を継承しない (これは仕様)
- 渡すコンテキスト (issue 内容, 計画文書) を都度 prompt に明示
- 構造化スキーマに沿った渡し方を徹底 (MetaGPT流)

### R-3: 並列 Codex CLI 実行時の session 衝突

- 同一 `~/.codex/sessions/` を共有
- `--ephemeral` フラグで session永続化を抑止
- worktree ごとに `-C <DIR>` で実行ディレクトリを分ける

### R-4: gh-gantt の sync 競合

- 並列タスクで `.gantt-sync/*.json` が変更されると pull/push 競合
- 解決: gh-gantt-conflict-resolution skill が既にある
- もしくは PMが排他制御 (1 issue ずつ処理)

### R-5: reviewer の Yes-Man化 (CAMEL論文警告)

- 同一 Claude モデル (Sonnet) が implementer + reviewer を兼ねるとバイアス
- 解決: reviewer #1 = Codex (`codex review`)、reviewer #2 = Claude (subagent) で **モデル混合**
- さらに rubric を強制し、「○問題を指摘せよ」型のプロンプト

### R-6: Improvement loop の発散

- 解決: max iteration 3、quality score threshold、PM (Termination Judge) の決定権

### R-7: PR説明と実装の乖離

- 解決: `--output-schema` で構造化出力 → PRテンプレへ機械的反映

### R-8: 動作確認の偽陽性

- `pnpm check && pnpm test` が pass しても実際の動作不良は残りうる
- 解決: smoke E2E (`pnpm smoke:*`) も executor gate に含める
- さらに `pnpm pr:flow merge --settle-minutes 10` の人間確認フェーズを尊重

### R-9: コスト爆発

- ロール5+ × iteration 3 = 15 LLM呼び出し/タスク
- 解決: planner / reviewer は Sonnet、implementer は codex、PM は Opus or Sonnet と段階的にモデル選択
- 1タスクあたりトークン消費を計測してフィードバック
