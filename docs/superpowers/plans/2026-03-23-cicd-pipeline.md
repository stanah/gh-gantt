# CI/CD パイプライン構築 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actions で lint, test, build, E2E テストを自動化する CI/CD パイプラインを構築する。

**Architecture:** 単一ワークフローファイル `.github/workflows/ci.yml` に ci ジョブと e2e ジョブを定義。`voidzero-dev/setup-vp` で環境セットアップを簡略化し、`vp check` で format/lint/type check を統合実行する。

**Tech Stack:** GitHub Actions, vite-plus (vp), pnpm, Playwright

**Spec:** `docs/superpowers/specs/2026-03-23-cicd-pipeline-design.md`

---

## ファイル構成

| 操作   | パス                       | 責務                              |
| ------ | -------------------------- | --------------------------------- |
| Create | `.github/workflows/ci.yml` | CI/CD ワークフロー定義            |
| Update | `package.json`             | `packageManager` フィールドの追加 |

---

### Task 1: ci ジョブの作成

**Files:**

- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: フィーチャーブランチを作成**

```bash
git checkout -b feat/cicd-pipeline
```

- [ ] **Step 2: ディレクトリ作成**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 3: ci ジョブを含むワークフローファイルを作成**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: voidzero-dev/setup-vp@v1
        with:
          node-version: "22"
          cache: true

      - run: vp install
      - run: vp check
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 4: ローカルで lint/test/build が通ることを確認**

```bash
vp check && pnpm test && pnpm build
```

Expected: すべて成功

- [ ] **Step 5: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add CI workflow with lint, test, and build"
```

---

### Task 2: e2e ジョブの追加

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: e2e ジョブを追加**

`.github/workflows/ci.yml` の `jobs:` セクションに追加:

```yaml
e2e:
  runs-on: ubuntu-latest
  needs: ci
  if: github.ref == 'refs/heads/main'
  steps:
    - uses: actions/checkout@v4

    - uses: voidzero-dev/setup-vp@v1
      with:
        node-version: "22"
        cache: true

    - run: vp install
    - run: pnpm build
    - run: npx playwright install chromium --with-deps
    - run: pnpm test:e2e

    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: playwright-report
        path: playwright-report/
        retention-days: 30
```

- [ ] **Step 2: ワークフローの YAML 構文を検証**

```bash
cat .github/workflows/ci.yml | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin); print('Valid YAML')"
```

Expected: `Valid YAML`

- [ ] **Step 3: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add E2E test job on main push"
```

---

### Task 3: PR で動作確認

- [ ] **Step 1: リモートに push**

```bash
git push -u origin feat/cicd-pipeline
```

- [ ] **Step 2: PR を作成**

```bash
gh pr create --title "ci: CI/CD パイプライン構築" --body "$(cat <<'EOF'
## Summary
- GitHub Actions で lint, test, build を自動化する ci ジョブを追加
- main push 時に Playwright E2E テストを実行する e2e ジョブを追加
- voidzero-dev/setup-vp で環境セットアップを簡略化

## Test plan
- [ ] PR の CI ジョブ (ci) が成功すること
- [ ] main マージ後に e2e ジョブが実行されること

Closes #3

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: CI ジョブの実行結果を確認**

```bash
gh run list --limit 1
gh run view <run-id>
```

Expected: ci ジョブが成功

- [ ] **Step 4: main にマージ後、e2e ジョブの実行を確認**

```bash
gh pr merge --squash
gh run list --limit 1
```

Expected: ci + e2e ジョブが両方成功
