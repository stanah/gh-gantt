#!/usr/bin/env tsx
/**
 * スモークテストのエントリポイント
 *
 * 使い方:
 *   tsx src/run.ts --env personal   # 個人リポジトリ
 *   tsx src/run.ts --env org        # Org リポジトリ
 *
 * 終了コード:
 *   0: 全ステップ成功
 *   1: いずれかのステップが失敗
 */
import { getEnvConfig, hasRequiredAuth, type SmokeEnv } from "./config.js";
import { reportResult } from "./reporter.js";
import { runTier1Smoke } from "./runner.js";

function parseArgs(): SmokeEnv {
  const envIndex = process.argv.indexOf("--env");
  if (envIndex === -1 || envIndex + 1 >= process.argv.length) {
    console.error("使い方: tsx src/run.ts --env <personal|org>");
    process.exit(2);
  }

  const env = process.argv[envIndex + 1];
  if (env !== "personal" && env !== "org") {
    console.error(`無効な環境: ${env} (personal または org を指定してください)`);
    process.exit(2);
  }

  return env;
}

function main(): void {
  const env = parseArgs();

  // 認証トークンが未設定なら明示的に失敗させる (silent な成功扱いは不適切)
  if (!hasRequiredAuth()) {
    console.error(
      [
        "エラー: GITHUB_TOKEN が設定されていません。",
        "",
        "ローカル実行の場合: `gh auth login` 済みの状態で `GITHUB_TOKEN=$(gh auth token) pnpm smoke:personal` のように渡してください。",
        "CI 実行の場合 (workflow_dispatch): repository secrets に SMOKE_GITHUB_TOKEN (personal) / SMOKE_APP_ID + SMOKE_APP_PRIVATE_KEY (org) を設定してください。",
        "",
        "設定手順: packages/smoke/README.md を参照してください。",
      ].join("\n"),
    );
    process.exit(1);
  }

  const config = getEnvConfig(env);

  console.log(`スモークテスト開始: ${config.description}`);

  const result = runTier1Smoke(env, config);
  reportResult(result);

  if (!result.success) {
    process.exit(1);
  }
}

main();
