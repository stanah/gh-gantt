# Vite Plus 対応（全パッケージ統合）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tsup/Vite 5/Vitest 2 ベースのモノレポを Vite Plus (`vp`) に統合移行し、ビルド・テスト・リントを単一ツールチェーンに統一する。

**Architecture:** shared/cli の tsup → tsdown 移行、ui の Vite 5 → 8 アップグレード、全パッケージへの vite-plus 導入、Oxlint による lint 追加の 4 段階で進める。各段階でテストが通ることを確認してから次に進む。

**Tech Stack:** vite-plus 0.1.x, tsdown, Vite 8, Vitest 4.1, Oxlint, pnpm workspaces

---

## File Structure

### 変更対象ファイル

| File                               | Action | Responsibility                    |
| ---------------------------------- | ------ | --------------------------------- |
| `packages/shared/package.json`     | Modify | tsup → tsdown, vitest → vite-plus |
| `packages/shared/tsdown.config.ts` | Create | tsdown ビルド設定                 |
| `packages/cli/package.json`        | Modify | tsup → tsdown, vitest → vite-plus |
| `packages/cli/tsdown.config.ts`    | Create | tsdown ビルド設定                 |
| `packages/ui/package.json`         | Modify | vite 5 → vite-plus                |
| `packages/ui/vite.config.ts`       | Modify | vite → vite-plus import           |
| `package.json` (root)              | Modify | scripts を `vp` コマンドに統一    |
| `tsconfig.base.json`               | Modify | `isolatedDeclarations: true` 追加 |

### 削除対象

| File/Dep                    | Reason                                     |
| --------------------------- | ------------------------------------------ |
| `tsup` (shared, cli)        | tsdown に置換                              |
| `vite` (ui)                 | vite-plus に包含                           |
| `vitest` (all)              | vite-plus に包含                           |
| `@vitejs/plugin-react` (ui) | vite-plus に包含（要確認、未包含なら残す） |

---

## Task 1: tsconfig.base.json に isolatedDeclarations を追加

tsdown の高速 DTS 生成に必要。全パッケージに影響するため最初に対応する。

**Files:**

- Modify: `tsconfig.base.json`
- Modify: 型エラーが出るエクスポート（必要に応じて）

- [ ] **Step 1: isolatedDeclarations を有効化**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "isolatedDeclarations": true
  }
}
```

- [ ] **Step 2: 型チェックを実行して isolatedDeclarations エラーを修正**

Run: `pnpm typecheck`
Expected: エクスポートに明示的な型注釈がない箇所でエラーが出る可能性あり。各エラーに型注釈を追加して修正する。

- [ ] **Step 3: 既存テストが通ることを確認**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: コミット**

```bash
git add tsconfig.base.json packages/*/src/**
git commit -m "chore: enable isolatedDeclarations in tsconfig for tsdown migration"
```

---

## Task 2: shared パッケージの tsup → tsdown 移行

**Files:**

- Modify: `packages/shared/package.json`
- Create: `packages/shared/tsdown.config.ts`

- [ ] **Step 1: tsdown をインストール、tsup を削除**

```bash
pnpm --filter @gh-gantt/shared add -D tsdown
pnpm --filter @gh-gantt/shared remove tsup
```

- [ ] **Step 2: tsdown.config.ts を作成**

```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
});
```

- [ ] **Step 3: package.json の build/dev スクリプトを更新**

```json
{
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 4: ビルドが通ることを確認**

Run: `pnpm --filter @gh-gantt/shared build`
Expected: `dist/index.js` と `dist/index.d.ts` が生成される

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/shared test`
Expected: ALL PASS

- [ ] **Step 6: コミット**

```bash
git add packages/shared/package.json packages/shared/tsdown.config.ts pnpm-lock.yaml
git commit -m "chore(shared): migrate tsup to tsdown"
```

---

## Task 3: cli パッケージの tsup → tsdown 移行

**Files:**

- Modify: `packages/cli/package.json`
- Create: `packages/cli/tsdown.config.ts`

- [ ] **Step 1: tsdown をインストール、tsup を削除**

```bash
pnpm --filter @gh-gantt/cli add -D tsdown
pnpm --filter @gh-gantt/cli remove tsup
```

- [ ] **Step 2: tsdown.config.ts を作成**

CLI は bin ツールなので `dts: false`。shebang を banner で明示的に保持する。

```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
```

- [ ] **Step 3: package.json の build/dev スクリプトを更新**

CLI の dev スクリプトには onSuccess フックがあるため注意。tsdown の `--onSuccess` サポートを確認し、未対応なら別途 watch スクリプトにする。

```json
{
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch --onSuccess 'cd ../.. && node packages/cli/dist/index.js serve --api-only'",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Note: tsdown が `--onSuccess` をサポートしない場合は `"dev": "tsdown --watch"` にフォールバックし、API サーバーは別ターミナルで起動する。

- [ ] **Step 4: ビルドが通ることを確認**

Run: `pnpm --filter @gh-gantt/cli build`
Expected: `dist/index.js` が生成される

- [ ] **Step 5: shebang が保持されていることを確認**

Run: `head -1 packages/cli/dist/index.js`
Expected: `#!/usr/bin/env node`

- [ ] **Step 6: CLI が動作することを確認**

Run: `node packages/cli/dist/index.js --version`
Expected: バージョン番号が表示される

- [ ] **Step 7: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/cli test`
Expected: ALL PASS

- [ ] **Step 8: コミット**

```bash
git add packages/cli/package.json packages/cli/tsdown.config.ts pnpm-lock.yaml
git commit -m "chore(cli): migrate tsup to tsdown"
```

---

## Task 4: vite-plus の導入と全パッケージ統合

`vp` CLI のインストールと vite-plus パッケージの導入。ui は Vite 5→8 (vite-plus 同梱) にアップグレード。

**Files:**

- Modify: `packages/ui/package.json`
- Modify: `packages/ui/vite.config.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/cli/package.json`
- Modify: `package.json` (root)

- [ ] **Step 1: vp CLI がインストールされているか確認**

```bash
vp --version || echo "vp not installed"
```

未インストールなら: `curl -fsSL https://vite.plus | bash`

- [ ] **Step 2: ui パッケージに vite-plus を導入**

```bash
pnpm --filter @gh-gantt/ui remove vite vitest @vitejs/plugin-react
pnpm --filter @gh-gantt/ui add -D vite-plus
```

- [ ] **Step 3: vite-plus が React プラグインを re-export しているか確認**

```bash
node -e "import('vite-plus/react').then(m => console.log('OK', Object.keys(m))).catch(e => console.log('NOT FOUND'))"
```

- 「OK」の場合: `import react from "vite-plus/react"` を使用
- 「NOT FOUND」の場合: `@vitejs/plugin-react` を再インストールし `import react from "@vitejs/plugin-react"` を維持

- [ ] **Step 4: vite.config.ts を vite-plus 対応に更新**

React プラグインの import は Step 3 の結果に応じて決定する。

```typescript
// vite-plus に React plugin が同梱されている場合:
import { defineConfig } from "vite-plus";
import react from "vite-plus/react";

// 同梱されていない場合:
// import { defineConfig } from "vite-plus";
// import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
```

- [ ] **Step 5: ui の build/dev/preview スクリプトを確認・更新**

vite-plus が `vite` バイナリを提供するか確認:

```bash
pnpm --filter @gh-gantt/ui exec which vite || echo "vite binary not available"
```

- `vite` バイナリが利用可能: scripts はそのまま（`"build": "vite build"`, `"dev": "vite"`）
- 利用不可: `vp` コマンドに更新（`"build": "vp build"`, `"dev": "vp dev"`, `"preview": "vp preview"`）

- [ ] **Step 6: shared/cli から vitest を削除し vite-plus に統一**

```bash
pnpm --filter @gh-gantt/shared remove vitest
pnpm --filter @gh-gantt/shared add -D vite-plus
pnpm --filter @gh-gantt/cli remove vitest
pnpm --filter @gh-gantt/cli add -D vite-plus
```

- [ ] **Step 7: 全パッケージの test スクリプトを vp test に更新**

各 package.json の `"test": "vitest run"` → `"test": "vp test run"`

- [ ] **Step 8: root package.json の scripts を更新**

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev",
    "lint": "vp check",
    "test": "pnpm -r test",
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:ui": "playwright test --ui",
    "typecheck": "pnpm -r typecheck"
  }
}
```

- [ ] **Step 9: ビルド確認**

Run: `pnpm build`
Expected: 全パッケージビルド成功

- [ ] **Step 10: テスト確認**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 11: UI dev server の動作確認**

Run: `pnpm --filter @gh-gantt/ui dev`
Expected: Vite 8 dev server が起動、ブラウザでアクセス可能

- [ ] **Step 12: コミット**

```bash
git add package.json packages/*/package.json packages/ui/vite.config.ts pnpm-lock.yaml
git commit -m "feat: migrate to vite-plus for unified toolchain"
```

---

## Task 5: Oxlint 導入（vp check）

vite-plus 同梱の Oxlint を有効化する。

**Files:**

- Modify: `package.json` (root) — lint スクリプトは Task 4 で更新済み

- [ ] **Step 1: vp check を実行して現状を確認**

Run: `vp check`
Expected: Oxlint の lint 結果 + 型チェック結果が出力される。初回は多数の警告が出る可能性あり。

- [ ] **Step 2: 致命的なエラーを修正**

error レベルの問題のみ修正する。warning は段階的に対応。

- [ ] **Step 3: auto-fix を実行**

Run: `vp check --fix`
Expected: フォーマット・自動修正可能な lint エラーが修正される

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ src/
git commit -m "chore: fix lint errors reported by oxlint via vp check"
```

---

## Task 6: E2E テスト・最終検証

Playwright E2E テストと CLI 動作の最終確認。

**Files:**

- Modify: `playwright.config.ts` — webServer command の更新（必要に応じて）

- [ ] **Step 1: playwright.config.ts の webServer を確認**

現在 `pnpm --filter @gh-gantt/ui dev` を使用。vite-plus でも `vite dev` が動くので変更不要のはず。確認する。

- [ ] **Step 2: E2E テストを実行**

Run: `pnpm test:e2e`
Expected: ALL PASS

- [ ] **Step 3: CLI のグローバルリンクを更新**

```bash
pnpm build && pnpm --filter @gh-gantt/cli exec pnpm link --global
```

- [ ] **Step 4: gh-gantt CLI の動作確認**

```bash
gh-gantt --version
gh-gantt task list --state open | head -5
```

Expected: 正常動作

- [ ] **Step 5: コミット（必要な場合のみ）**

```bash
git add playwright.config.ts
git commit -m "chore: update playwright config for vite-plus"
```

---

## ロールバック

各タスクはコミット単位。問題が発生した場合:

```bash
git revert <commit-hash>
pnpm install
```

## 注意事項

- Vite+ は alpha (v0.1.12)。API や設定形式が変わる可能性がある
- `vite-plus` の React プラグイン re-export は未確認。Task 4 Step 3 で検証する
- tsdown の `--onSuccess` サポートはドキュメントで要確認
- `vp test` が `vitest run` と同等に動くか各ステップで検証する
- 問題が発生した場合は該当タスクで止め、旧ツールにロールバック可能な状態を維持する
