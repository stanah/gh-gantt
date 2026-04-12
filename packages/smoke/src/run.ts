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
import { getEnvConfig, type SmokeEnv } from "./config.js";
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
  const config = getEnvConfig(env);

  console.log(`スモークテスト開始: ${config.description}`);

  const result = runTier1Smoke(env, config);
  reportResult(result);

  if (!result.success) {
    process.exit(1);
  }
}

main();
