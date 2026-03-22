# gh-gantt スキル再設計 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gh-gantt の monolithic なワークフロースキルを、責務ごとに分離された 7 つのスキルに再構成する

**Architecture:** 各スキルは `skills/<name>/SKILL.md` に配置。共通のコマンドリファレンスは `references/commands.md` に集約し、各スキルからシンボリックリンクまたはパス参照する。スキル間は REQUIRED/OPTIONAL チェーンで接続。

**Tech Stack:** Markdown (skill files), gh-gantt CLI

**Spec:** `docs/superpowers/specs/2026-03-22-gh-gantt-skills-redesign.md`

---

### Task 1: ファイル命名規約の統一とディレクトリ準備

**Files:**
- Rename: `.claude/skills/conflict-resolution/SKILL.md` → `skills/gh-gantt-conflict-resolution/SKILL.md`
- Rename: `skills/gh-gantt-workflow/SKILL.md`（実際は配置変更済み）
- Create: `skills/gh-gantt-sync/`
- Create: `skills/gh-gantt-decompose/`
- Create: `skills/gh-gantt-triage/`
- Create: `skills/gh-gantt-dependencies/`
- Create: `skills/gh-gantt-progress/`

- [ ] **Step 1: conflict-resolution のリネーム**

```bash
# (run from project root)
git mv .claude/skills/conflict-resolution/SKILL.md skills/gh-gantt-conflict-resolution/SKILL.md
```

- [ ] **Step 2: gh-gantt-workflow のリネーム**

macOS のファイルシステムは case-insensitive のため、一時ファイル経由でリネーム:

```bash
git mv .claude/skills/gh-gantt-workflow/SKILL.md skills/gh-gantt-workflow/SKILL.md
```

- [ ] **Step 3: 新スキルのディレクトリ作成**

```bash
mkdir -p skills/gh-gantt-sync
mkdir -p skills/gh-gantt-decompose
mkdir -p skills/gh-gantt-triage
mkdir -p skills/gh-gantt-dependencies
mkdir -p skills/gh-gantt-progress
```

- [ ] **Step 4: コミット**

```bash
git add skills/
git commit -m "chore: スキルファイル命名規約の統一と新スキルディレクトリ作成"
```

---

### Task 2: `gh-gantt-workflow` の書き換え

**Files:**
- Modify: `skills/gh-gantt-workflow/SKILL.md`

- [ ] **Step 1: skill.md を書き換え**

spec の `gh-gantt-workflow` セクションに基づいて書き換え。以下の構造:

```markdown
---
name: gh-gantt-workflow
description: gh-gantt の開発サイクル全体を回すオーケストレーター。「作業を始めたい」「次に何をすべき？」「開発サイクルを回して」で使用。特定の要望のタスク化は gh-gantt-decompose、進捗確認のみは gh-gantt-progress、同期のみは gh-gantt-sync を使うこと。
---

# gh-gantt 開発ワークフロー

gh-gantt CLI でタスクを管理しながら開発を進めるためのオーケストレーター。

<HARD-GATE>
ステップ 1（sync pull）の完了を evidence で確認するまで、ステップ 3 以降に進んではならない。

チェック条件: `gh-gantt status` を実行し、出力を確認する。
失敗時: `gh-gantt-sync` スキルを invoke して pull を実行する。
Evidence: `gh-gantt status` または `gh-gantt pull` の出力をそのまま提示する。
</HARD-GATE>

## プロセスフロー

[graphviz diagram from spec]

## デフォルトフロー

1. **REQUIRED:** `gh-gantt-sync`（pull）を invoke
2. **OPTIONAL:** `gh-gantt-triage` でタスクの衛生状態を確認
3. タスク確認・選択
4. ブランチ作成
5. 開発 & 検証（workflow.md に指定があればそのスキルを使用）
6. コミット & PR
7. **REQUIRED:** `gh-gantt-sync`（タスク更新 + push）を invoke

## ワークフロー定義ファイル

`.gantt-sync/workflow.md` が存在すれば読み、プロジェクトのコンテキストとして参照する。
存在しない場合はデフォルトフローで動作する。

## Red Flags / Common Rationalizations

[tables from spec]

## リファレンス

- コマンド詳細: [references/commands.md](references/commands.md)
```

- [ ] **Step 2: 検証 — スキルの description が他スキルと重複しないことを目視確認**

- [ ] **Step 3: コミット**

```bash
git add skills/gh-gantt-workflow/SKILL.md
git commit -m "refactor: gh-gantt-workflow をオーケストレーターとして再設計"
```

---

### Task 3: `gh-gantt-sync` の作成

**Files:**
- Create: `skills/gh-gantt-sync/SKILL.md`

- [ ] **Step 1: skill.md を作成**

spec の `gh-gantt-sync` セクションに基づいて作成。以下の構造:

```markdown
---
name: gh-gantt-sync
description: gh-gantt の pull/push 同期を実行する。「同期して」「pull して」「push して」で使用。コンフリクト発生時は conflict-resolution にチェーンする。作業前の pull、作業後のタスク更新 + push を強制する。
---

# gh-gantt Sync

<HARD-GATE>
コンフリクトがある状態で作業を開始してはならない。

チェック条件: `gh-gantt conflicts` を実行し、コンフリクトが 0 件であること。
失敗時: `conflict-resolution` スキルを invoke する。
Evidence: `gh-gantt conflicts` の出力が "No conflicts." であること。
</HARD-GATE>

## プロセス（pull）
[from spec, with evidence requirements]

## プロセス（push）
[from spec, including Issue body/title 整合性確認]

## Red Flags
[table from spec]

## リファレンス

- コマンド詳細: [references/commands.md](../gh-gantt-workflow/references/commands.md)
```

- [ ] **Step 2: コミット**

```bash
git add skills/gh-gantt-sync/
git commit -m "feat: gh-gantt-sync スキルを作成（pull/push の規律と検証）"
```

---

### Task 4: `gh-gantt-decompose` の作成

**Files:**
- Create: `skills/gh-gantt-decompose/SKILL.md`

- [ ] **Step 1: skill.md を作成**

spec の `gh-gantt-decompose` セクションに基づいて作成。以下の構造:

```markdown
---
name: gh-gantt-decompose
description: 要望を調査・分解して適切な粒度で Issue 化する。「X を実装して」「タスク化して」「Issue を作って」で使用。既存タスクとの重複・矛盾チェック、粒度の判断、親子/依存関係の設定を行う。
---

# gh-gantt Decompose

要望をそのまま Issue にせず、調査・分析してから適切な粒度でタスク化する。

<HARD-GATE>
既存タスクとの重複・矛盾チェックなしに Issue を作成してはならない。

チェック条件: `gh-gantt task list` で既存タスクを調査する。
失敗時: 重複・類似タスクがある場合、ユーザーに提示して方針を確認する。
Evidence: `gh-gantt task list` の出力と、重複なしの判断根拠を提示する。
</HARD-GATE>

## プロセス
[8 steps from spec, with evidence at step 2 and 7]

## Red Flags / Common Rationalizations
[tables from spec]

## リファレンス

- コマンド詳細: [references/commands.md](../gh-gantt-workflow/references/commands.md)
```

- [ ] **Step 2: コミット**

```bash
git add skills/gh-gantt-decompose/
git commit -m "feat: gh-gantt-decompose スキルを作成（要望の調査・分解・Issue 化）"
```

---

### Task 5: `gh-gantt-triage` の作成

**Files:**
- Create: `skills/gh-gantt-triage/SKILL.md`

- [ ] **Step 1: skill.md を作成**

spec の `gh-gantt-triage` セクションに基づいて作成。以下の構造:

```markdown
---
name: gh-gantt-triage
description: 既存タスクの衛生管理。親なし・日程なし・body 空・閉じ忘れ等の問題を検出して修正する。「タスクを整理して」「バックログを整理」で使用。
---

# gh-gantt Triage

既存タスクの健康状態を検査し、問題を修正する。

## 検査項目
[table from spec]

## プロセス
[6 steps from spec, including sync chain and priority-based presentation]

## リファレンス

- コマンド詳細: [references/commands.md](../gh-gantt-workflow/references/commands.md)
```

- [ ] **Step 2: コミット**

```bash
git add skills/gh-gantt-triage/
git commit -m "feat: gh-gantt-triage スキルを作成（タスクの衛生管理）"
```

---

### Task 6: `gh-gantt-dependencies` の作成

**Files:**
- Create: `skills/gh-gantt-dependencies/SKILL.md`

- [ ] **Step 1: skill.md を作成**

spec の `gh-gantt-dependencies` セクションに基づいて作成。以下の構造:

```markdown
---
name: gh-gantt-dependencies
description: タスク間の依存関係を設定・検証する。循環依存の検出、ブロッカー分析、クリティカルパスの特定を行う。「依存関係を設定して」「ブロッカーは？」で使用。
---

# gh-gantt Dependencies

タスク間の依存関係（blocked_by）の設定・検証・問題検出を行う。

## 検査項目
[from spec]

## プロセス
[5 steps from spec, with evidence]

## リファレンス

- コマンド詳細: [references/commands.md](../gh-gantt-workflow/references/commands.md)
```

- [ ] **Step 2: コミット**

```bash
git add skills/gh-gantt-dependencies/
git commit -m "feat: gh-gantt-dependencies スキルを作成（依存関係の設定・検証）"
```

---

### Task 7: `gh-gantt-progress` の作成

**Files:**
- Create: `skills/gh-gantt-progress/SKILL.md`

- [ ] **Step 1: skill.md を作成**

spec の `gh-gantt-progress` セクションに基づいて作成。以下の構造:

```markdown
---
name: gh-gantt-progress
description: プロジェクトの進捗を評価しアクションを提案する。エピック進捗、遅延検出、リスク評価、次タスクの提案。「進捗は？」「プロジェクトの状態は？」「遅れてるタスクは？」で使用。
---

# gh-gantt Progress

プロジェクト全体の進捗を評価し、アクションを提案する。

## 分析項目
[from spec]

## プロセス
[4 steps from spec, sync chain for pull]

## リファレンス

- コマンド詳細: [references/commands.md](../gh-gantt-workflow/references/commands.md)
```

- [ ] **Step 2: コミット**

```bash
git add skills/gh-gantt-progress/
git commit -m "feat: gh-gantt-progress スキルを作成（進捗追跡・リスク評価）"
```

---

### Task 8: CLAUDE.md のスキル一覧を更新

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: スキルセクションを更新**

CLAUDE.md の `## スキル` セクションを新しいスキル構成に合わせて更新:

```markdown
## スキル

`skills/` 配下のスキルは **gh-gantt ツール自体の使い方** を記述したもの。
このプロジェクト固有の運用ではなく、gh-gantt を使う任意のプロジェクトで適用できる汎用的な知識。

- **`gh-gantt-workflow`** — 開発サイクル全体のオーケストレーター
- **`gh-gantt-sync`** — pull/push の同期規律
- **`gh-gantt-decompose`** — 要望の調査・分解・Issue 化
- **`gh-gantt-triage`** — 既存タスクの衛生管理
- **`gh-gantt-dependencies`** — 依存関係の設定・検証
- **`gh-gantt-progress`** — 進捗追跡・リスク評価
- **`gh-gantt-conflict-resolution`** — pull 後のコンフリクト解決手順
```

- [ ] **Step 2: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md のスキル一覧を新構成に更新"
```

---

### Task 9: ワークフロー定義ファイルのサンプル作成（gh-gantt プロジェクト用）

**Files:**
- Create: `.gantt-sync/workflow.md`

- [ ] **Step 1: gh-gantt プロジェクト自体のワークフロー定義を作成**

```markdown
# 開発ワークフロー（gh-gantt プロジェクト）

## 作業開始
- gh-gantt pull → タスク確認 → タスク選択 → ブランチ作成

## タスク化
- 機能追加・改善の要望はまず gh-gantt issue を作成し、直接コードを修正しない
- 既存の CLI オプションを --help で確認してから作業する

## 開発
- pnpm typecheck && pnpm test && pnpm build で検証

## 完了
- gh-gantt task update <number> --state closed
- gh-gantt push
```

- [ ] **Step 2: .gitignore に workflow.md の除外設定がないことを確認**

`.gantt-sync/` 全体が gitignore されているため、`workflow.md` もリポジトリに含まれない。これはプロジェクト固有の設定なので問題ない。

- [ ] **Step 3: コミットは不要**（gitignore 対象のため）

---

### Task 10: セルフテスト

- [ ] **Step 1: 全スキルの description を確認**

```bash
grep -r "^description:" skills/*/SKILL.md
```

トリガー条件に重複がないことを目視確認。

- [ ] **Step 2: スキルチェーンの整合性確認**

各スキルの REQUIRED/OPTIONAL チェーン先が実在するスキル名であることを確認:

```bash
grep -r "REQUIRED.*invoke\|OPTIONAL.*invoke" skills/*/SKILL.md
```

- [ ] **Step 3: references/commands.md へのパス参照が有効であることを確認**

```bash
grep -r "references/commands.md" skills/*/SKILL.md
```

参照先ファイルが存在することを確認。

- [ ] **Step 4: gh-gantt-workflow を実際に invoke してデフォルトフローが動作することを確認**

- [ ] **Step 5: コミット（修正があれば）**

```bash
git add skills/ CLAUDE.md
git commit -m "fix: セルフテストで発見した問題を修正"
```
