# CI/CD パイプライン設計

## 概要

GitHub Actions で lint, test, build, E2E テストを自動化する。
vite-plus (`vp`) の CI 統合を活用し、最小構成で実現する。

## トリガー

| イベント       | ブランチ                                         | 実行内容        |
| -------------- | ------------------------------------------------ | --------------- |
| `pull_request` | `branches: [main]`（main をターゲットとする PR） | ci ジョブ       |
| `push`         | `branches: [main]`（main へのマージ）            | ci + e2e ジョブ |

## ワークフロー構成

単一ファイル `.github/workflows/ci.yml`。

### ci ジョブ（PR + main push）

1. `actions/checkout@v4`
2. `voidzero-dev/setup-vp@v1` — Node 22 + pnpm + store キャッシュを一括セットアップ
3. `vp install` — 依存インストール
4. `vp check` — format + lint + type check（monorepo 全体を対象）
5. `pnpm test` — 全パッケージのユニットテスト（`pnpm -r test` で各パッケージの除外設定を尊重）
6. `pnpm build` — 全パッケージのビルド（`pnpm -r build` で依存順に実行）

### e2e ジョブ（main push のみ）

`needs: ci` + `if: github.ref == 'refs/heads/main'` で制御。

1. `actions/checkout@v4`
2. `voidzero-dev/setup-vp@v1`
3. `vp install`
4. `pnpm build`
5. `npx playwright install chromium --with-deps`
6. `pnpm test:e2e`
7. `actions/upload-artifact@v4` — `playwright-report/` を保存（`if: always()` で成否に関わらず保存）

## 設計判断

- **setup-vp**: `actions/setup-node` + `pnpm/action-setup` + キャッシュ設定を1ステップに統合
- **Node 22**: vp 推奨バージョン。`engines: >=20` と互換
- **vp check**: Oxlint + Oxfmt + tsc を統合。monorepo ルートで実行すると全パッケージを対象にする
- **pnpm test / pnpm build**: `vp test` はルートで実行すると E2E スペックも巻き込むため、各パッケージの test script を尊重する `pnpm -r test` を使用。build も同様
- **単一ワークフロー**: ジョブ数が少なく1ファイルで十分見通せる
- **E2E は main のみ**: PR では実行せず CI 時間を節約。main マージ後に検証
- **E2E は API モック済み**: `e2e/helpers.ts` で全 API をルートレベルでモックしているため、API サーバーの起動は不要。webServer は UI dev server のみ
- **Playwright 設定**: 既存の `playwright.config.ts` が `process.env.CI` を考慮済み（retries: 2, workers: 1）
- **matrix 不要**: 単一 Node バージョン、単一 OS で十分
- **アーティファクト**: `if: always()` で常にアップロード。失敗時のデバッグに加え、成功時のレポートも参照可能
