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
import { getAuthToken, getEnvConfig, type SmokeEnv } from "./config.js";
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

  // 認証トークンを取得 (GITHUB_TOKEN / GH_TOKEN / gh CLI の順)
  // 取得できない場合は明示的に失敗させる (silent な成功扱いは不適切)
  const token = getAuthToken();
  if (token === null) {
    console.error(
      [
        "エラー: 認証トークンを取得できませんでした。",
        "",
        "以下のいずれかを実施してください:",
        "  - `gh auth login` を実行する (ローカル推奨)",
        "  - 環境変数 GITHUB_TOKEN または GH_TOKEN を設定する",
        "  - CI (workflow_dispatch) 実行時は repository secrets に",
        "    SMOKE_GITHUB_TOKEN (personal) / SMOKE_APP_ID + SMOKE_APP_PRIVATE_KEY (org) を設定する",
        "",
        "詳細: packages/smoke/README.md を参照してください。",
      ].join("\n"),
    );
    process.exit(1);
  }

  // CLI が参照できるよう GITHUB_TOKEN を現プロセスの環境に設定
  process.env["GITHUB_TOKEN"] = token;

  const config = getEnvConfig(env);

  console.log(`スモークテスト開始: ${config.description}`);

  const result = runTier1Smoke(env, config);
  reportResult(result);

  if (!result.success) {
    process.exit(1);
  }
}

main();
