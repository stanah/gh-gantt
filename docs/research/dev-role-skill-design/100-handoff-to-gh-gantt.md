# gh-gantt セッションへの委任メモ: dev-role skill 群の新設

> 発行元: iris プロジェクト codex-task-orchestration セッション (2026-05-08)
> 宛先: gh-gantt 側のClaude/Codexセッション
> 目的: gh-gantt 二次スキルとして「エージェント非依存・プロジェクト非依存の開発ロール skill 群」を新設するための設計引継ぎ

## 委任の背景

iris プロジェクトで「単一 Codex セッションが動作確認 (`pnpm check / test`) を尊重せず PR を merge してしまう」問題が頻発している。これを解決するために、ロール分離型のマルチエージェント開発フローを導入したい。

iris セッションで以下を調査・決定済み：

- 4ドメイン調査 (OSSフレームワーク / PR駆動エージェント / ロール設計パターン / iris環境統合経路)
- 既存 gh-gantt skill 群 (`gh-gantt-workflow` / `-decompose` / `-progress` / `-sync` / `-conflict-resolution` / `-dependencies`) の構造調査
- iris の既存自動化 (`pnpm pr:flow`, `pnpm check`, `pnpm test`, `.gantt-sync/workflow.md` の Skill Routing)

詳細は本ディレクトリ (`gh-gantt/docs/research/dev-role-skill-design/`) の全6ファイル (約 92KB) を参照（このメモが7ファイル目）：

- `README.md` — 索引と主要発見
- `01-multi-agent-frameworks.md` — CrewAI / AutoGen / LangGraph / MetaGPT / OpenAI Agents SDK / Claude Agent SDK
- `02-pr-driven-coding-agents.md` — OpenHands / SWE-agent / Devin / Factory.ai / claude-code-action / Codex Cloud 等12ツール
- `03-role-separation-patterns.md` — Anthropic / OpenAI公式 + MetaGPT / ChatDev / AutoGen / CAMEL / Reflexion 14文献
- `04-iris-integration-paths.md` — codex CLI 機能マップ + iris既存資産接続点
- `99-synthesis-and-recommendation.md` — 横断総括 (注: 当初は subagent + file scratchpad 案だったが、ユーザー指示で skill ベースに方針転換、本ドキュメントの方が新しい)

## 委任の方針確定 (iris セッションで合意済み)

1. **エージェント非依存**: Claude / Codex / Aider / その他、どの coding agent でも skill のreferenceファイルを読み込めばそのロールとして振る舞える
2. **プロジェクト非依存**: iris に閉じない汎用設計。プロジェクト固有の差異 (verify command, branch naming, rubric path) はプロジェクト側で吸収
3. **gh-gantt 二次スキルとして公式化**: gh-gantt repo (`/Users/stanah/work/github.com/stanah/gh-gantt`) にPRし、`gh-gantt-*` 命名規則で配布
4. **1 skill + role別 reference ファイル方式** (skill肥大化を避ける): ロールごとに別 skill を作るのではなく、1つの skill が引数で role を受け取り、対応する reference を読み込む
5. **5ロール**: `orchestrator` / `planner` / `implementer` / `executor` / `reviewer`
6. **既存 gh-gantt skill との共存**: `gh-gantt-workflow` 等は維持し、その「開発・検証」ステップで新 skill にチェーンする形
7. **HARD-GATE で動作確認を物理的に強制**: Reviewer や PR作成の前段に executor (verify) を必須化する skill 設計

## 新設する skill の仕様

### Skill 名 (候補)

`gh-gantt-dev-role` / `gh-gantt-role` のいずれか。`gh-gantt-` 命名規則に従う。**最終決定は gh-gantt セッションに委ねる**。

### ファイル構造

```
gh-gantt/skills/<skill-name>/
├── SKILL.md                 # 本体: 引数で role 名を受け取り、対応reference を読み込む指示
├── references/
│   ├── orchestrator.md      # PMロール: issueから始まり planner→impl→exec→reviewer→improvement loop→PR の指揮
│   ├── planner.md           # 計画ロール: issue+AC→plan.json
│   ├── implementer.md       # 実装ロール: plan.json→コード変更+impl-result.json
│   ├── executor.md          # 検証ロール: project定義 verify command を実行→verify-result.json
│   └── reviewer.md          # レビューロール: PR diff + plan を rubric採点→review.json
├── templates/
│   ├── plan.schema.json
│   ├── impl-result.schema.json
│   ├── verify-result.schema.json
│   └── review.schema.json
└── examples/
    └── <参考ケース.md>
```

### SKILL.md (本体) の最低要件

- frontmatter: `name`, `description` (gh-gantt skill 群と同じ書式)
- 引数: `role` (`orchestrator` / `planner` / `implementer` / `executor` / `reviewer` の5択)
- 動作: 「指定された role の reference ファイルを読み込み、そのロールとして振る舞え」と指示
- HARD-GATE 共通項目:
  - プロジェクト設定ファイル (例: `.dev-flow/config.json` または既存 `.gantt-sync/workflow.md` の `dev_role` セクション) が存在するか
  - role 名が valid か (5ロールのいずれか)
  - 入力 ($ARG2 等) が指定された場合のフォーマット検証

### 各 role reference の最低要件

各 reference は次の構造で書く（既存 gh-gantt skill と整合的に）：

```markdown
---
role: <role-name>
description: <この役割の責務 1行>
---

# <ロール名>

## 責務

<責務の説明>

<HARD-GATE>
このロールが作業を始める前に確認すべき必要条件。
チェック条件: <具体>
失敗時: <他skillへのチェーン or エラー>
Evidence: <何を提示するか>
</HARD-GATE>

## 手順

1. <ステップ1>
2. <ステップ2>
   ...

## 出力契約

このロールが次のロールに渡す成果物の形式。templates/\*.schema.json を参照。

## Red Flags

| やりがちなこと | 問題 |
| -------------- | ---- |
| ...            | ...  |

| 言い訳 | 現実 |
| ------ | ---- |
| ...    | ...  |

## エージェント別の留意点

- Claude (Sonnet/Opus): <注意点>
- Codex (codex exec): <注意点 e.g. --output-schema を指定>
- 他: <注意点>
```

### 5ロールそれぞれの責務 (詳細は references/\*.md に書き込み)

| Role             | 入力                                    | 出力                                                                                       | HARD-GATE                                                          | 主要手順                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **orchestrator** | GitHub Issue # + workspace path         | PR URL or BLOCKED report                                                                   | プロジェクト設定が存在 + Issue が open                             | 1. gh-gantt-sync(pull) → 2. planner呼出 → 3. implementer呼出 → 4. executor呼出 (fail→implementer再呼出 max 2回) → 5. reviewer呼出 → 6. improvement loop (max 3 iter) → 7. `pnpm pr:flow create` 等 → 8. gh-gantt-sync(push) |
| **planner**      | Issue 内容 + AC + workspace 構造        | `plan.json` (構造化計画: ファイル変更計画 / 検証手順 / AC / リスク / outOfScope)           | Issue が読める + AC が抽出可能                                     | 1. issue詳細取得 2. workspace ARCHITECTUREを把握 3. plan.schema.json に従い計画作成 4. validation                                                                                                                           |
| **implementer**  | `plan.json` + workspace path            | コード変更 + `impl-result.json` (変更ファイル一覧 / コミットSHA)                           | plan.json が schema検証pass + workspace clean                      | 1. plan を読む 2. agent別の実装フローを実行 (Claude→Edit/Write系tool, Codex→`codex exec --output-schema`等) 3. テスト追加 4. コミット                                                                                       |
| **executor**     | workspace path + project verify config  | `verify-result.json` (各stepのexit code / stdout抜粋 / pass-fail判定)                      | project の verify command が定義されている (config.verifyCommands) | 1. config から verify commands を読む (e.g. `pnpm check`, `pnpm test`, `pnpm smoke:*`) 2. 順次実行 3. 結果を集約                                                                                                            |
| **reviewer**     | PR diff + plan + verify-result + rubric | `review.json` (verdict: approve/request-changes/comment + scoreBreakdown + findings array) | rubric が定義されている + diff が空でない                          | 1. rubric読込 2. diff取得 3. plan vs 実装の整合性チェック 4. rubric採点 5. findings をseverity別に分類                                                                                                                      |

### Skill 間のファイルベース interface (エージェント非依存の通信)

```
.dev-flow/<issue-number>/         # プロジェクト固有 directory (gitignore か commit かはproject判断)
├── 00-input.json                 # orchestrator が書く: issue#, branch, workspace, agent
├── 01-plan.json                  # planner skill 出力 (plan.schema.json 準拠)
├── 02-impl-result.json           # implementer skill 出力
├── 03-verify-result.json         # executor skill 出力
├── 04-review-pass-1.json         # reviewer skill 出力 (improvement loop iter 1)
├── 05-impl-result-pass-2.json    # improvement loop iter 2 (implementer 再呼出)
├── 06-review-pass-2.json
├── ...
└── 99-orchestrator-decision.md   # orchestrator 最終判断ログ
```

### Project側で吸収する設定 (新形式 or 既存 workflow.md 拡張)

iris の場合 `.gantt-sync/workflow.md` 内に `## Dev-Role Config` セクション追加（または `.dev-flow/config.json` 別ファイル）：

```yaml
verifyCommands:
  - "pnpm check"
  - "pnpm test"
  - "pnpm smoke:desktop-pipeline-trace" # issueに応じた条件付き
reviewerRubricPath: "docs/orchestration/review-rubric.md"
branchNaming: "codex/issue-{number}-{slug}"
prCreator: "pnpm pr:flow create" # PR作成コマンドのテンプレ
prTemplate: ".github/pull_request_template.md"
maxImprovementIterations: 3
agentSelection:
  defaultImplementer: "codex" # codex / claude / aider など
  defaultReviewer1: "codex" # 1人目はcodex review (OpenAI系)
  defaultReviewer2: "claude" # 2人目はClaude (異モデルでバイアス排除)
```

## iris 側で並行して行うべき変更 (このセッションの責務外、別Issue化推奨)

1. **`scripts/pr-review-flow.mjs` に `pre-pr-gate` サブコマンド追加**
   - `pnpm pr:flow pre-pr-gate` = `pnpm check && pnpm test && pnpm smoke:<関連>`
   - `pnpm pr:flow create` の冒頭で `pre-pr-gate` を必須実行（`--skip-gate` でのみskip可、ただし強い警告）

2. **`.gantt-sync/workflow.md` の Skill Routing 拡張**

   ```
   | 完了宣言前の動作確認  | gh-gantt-dev-role role=executor (新)            |
   | 実装                  | gh-gantt-dev-role role=implementer (新)         |
   | PR pre-review verify  | gh-gantt-dev-role role=executor (新)            |
   | PR review (pre-merge) | gh-gantt-dev-role role=reviewer (新)            |
   | 開発全体オーケスト    | gh-gantt-dev-role role=orchestrator (新)        |
   ```

3. **`.gantt-sync/workflow.md` に `## Dev-Role Config` 追加** (上記の verifyCommands / rubric path 等)

4. **`docs/orchestration/review-rubric.md`** 新設 (reviewer skill が読み込むrubric)

5. **`docs/pr-review-merge-flow.md` 更新**: pre-pr-gate と新 skill 系の参照を追加

これら **iris 側変更は gh-gantt 側の skill 完成後に別 Issue 化** して進める。

## 既存 gh-gantt skill との関係

- **`gh-gantt-workflow`** は中核の「全体オーケストレーター」を維持。ただしステップ6「開発 & 検証」を改修：
  - workflow.md に dev-role が定義されていれば → `gh-gantt-dev-role role=orchestrator` を invoke
  - 定義がなければ → 従来通りのステップ
- **`gh-gantt-decompose` / `-progress` / `-sync` / `-conflict-resolution` / `-dependencies`** は**変更不要**。新skillから REQUIRED チェーンで呼ぶだけ
- `gh-gantt-decompose` の最後の sync(push) → `gh-gantt-dev-role role=orchestrator` への自然な繋ぎを考えても良い

## 推奨実装フェーズ (gh-gantt セッションでの)

### Phase α: skill scaffold (1日)

- skill ディレクトリ・ファイル骨格作成
- SKILL.md 本体 (引数解析+ reference 読み込み指示)
- 5つの reference (最初は最低限の責務記述だけでOK)
- templates/\*.schema.json (最低限、未確定なら TBD)
- gh-gantt repo に PR (Draft)

### Phase β: executor + reviewer (3〜5日)

最も価値の高い 2 ロールから本実装：

- `executor.md`: project の verifyCommands を順次実行する具体手順
- `reviewer.md`: rubric読込→diff取得→採点の具体手順 + Yes-Man回避の心得 (CAMEL論文参照)
- verify-result.schema.json と review.schema.json
- e2e テスト (gh-gantt repo の test 文化に合わせて)

### Phase γ: orchestrator + planner + implementer (1週間)

- 3ロールを揃え、5ロールパイプラインがフルに通るようにする
- iris での dogfooding (1 Issue を新skill経由で処理)

### Phase δ: ドキュメント・公開 (3日)

- gh-gantt README.md に dev-role 解説追加
- 利用例: iris 以外のproject (例: gh-gantt自身) でも使える例を1つ示す
- gh-gantt CHANGELOG.md にbreaking changeの有無を記録

## 未解決の論点 (gh-gantt セッションで決定すべき)

iris セッションで投げたかった8論点 + skill実装由来の論点：

1. **skill 名前の最終確定** (`gh-gantt-dev-role` / `gh-gantt-role` / 他)
2. **agent別の指示の書き方** (Claude / Codex / Aider 等の差をどこまでreference内で吸収するか)
3. **改善ループ (improver) の実装位置** — orchestrator reference に書く / 別 role にする / implementer の "iteration" として扱う
4. **Termination Judge の責任** — orchestrator が兼務 / 別 role / 単純な max-iter rule
5. **investigator ロール** — 5ロールに含めない方針 (iris決定済) を最終確認、必要に応じて orchestrator 内で `superpowers:dispatching-parallel-agents` 相当を呼び出す形で代替
6. **コスト予算管理** — iteration 数の他、トークン上限・時間制限をどこで定義
7. **失敗 Issue のリトライ戦略** — orchestrator の出力に BLOCKED/ESCALATED を含めるか
8. **`.dev-flow/<issue#>/` の扱い** — gitignore か commit か (推奨: gitignore + .dev-flow/.gitkeep)
9. **`.gantt-sync/workflow.md` の `Dev-Role Config` セクション仕様** — yaml frontmatter / 別 .json / 既存 workflow.md 内インライン
10. **rubric の標準テンプレ** — gh-gantt 側でデフォルト rubric を提供するか、project毎必須にするか
11. **複数のverify commandの並列実行** — 直列固定 / config で並列指定可能

## ベストプラクティス遵守チェック (iris セッションで確認済み)

| 公式指針                                              | 我々の設計が満たすか                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| 「過度な複雑化を避けよ」(Anthropic)                   | ✅ 5ロール、1 skill + reference化で skill肥大化回避                 |
| 「Evaluatorは独立モデル」(Anthropic)                  | ✅ reviewer #1=codex / #2=claude のモデル混合を config で指定可能に |
| 「Irreversible actionsはHuman checkpoint」(Anthropic) | ✅ Mergeは既存pr:flow を尊重 (人間 settle 必須)                     |
| 「LLM-as-judge + deterministic」(OpenAI)              | ✅ reviewer + executor (verify command)                             |
| 「Structured Output徹底」(MetaGPT)                    | ✅ JSON Schema強制 (templates/\*.schema.json)                       |
| 「テスト実行を独立工程に」(SWE-bench上位)             | ✅ executor ロール                                                  |
| 「Yes-Manを避ける」(CAMEL)                            | ✅ rubric強制 + モデル混合                                          |
| 「ループ終了条件を明示」(Reflexion)                   | ✅ orchestrator が max-iter / verdict合算で判定                     |
| 「最小権限の原則」(Anthropic SDK)                     | ✅ role別の sandbox / read-only指定をrefに記述                      |

## 委任先セッションへのお願い

1. このメモを最初に読み、本ディレクトリの 01〜04 と 99 にも目を通してください (特に `99-synthesis-and-recommendation.md` と `04-iris-integration-paths.md`)
2. 「未解決の論点」を順番に決めてから設計詳細に入ってください
3. PR を作る前に Phase α (scaffold) の段階で1度 iris 側に共有してください (skill のreferenceに iris で動かない指示が入っていないか確認のため)
4. Phase β 完了時点で iris で dogfooding テスト (1 Issue で executor + reviewer だけ通す) を実施したいので、その時点で連絡してください

## このメモへの参照方法

```bash
# gh-gantt repo 内
cat docs/research/dev-role-skill-design/100-handoff-to-gh-gantt.md
```

本ディレクトリは iris セッション (2026-05-08) で生成され、gh-gantt repo (main, working tree untracked) に移動された。**commit/PR 化は gh-gantt セッションの最初の判断**となる (例: 新ブランチ `docs/dev-role-skill-handoff` 等を切ってPR化)。
