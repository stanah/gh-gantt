import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * GitHub トークンを解決する。
 *
 * 優先順位: `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`。
 * gh CLI がないエフェメラル環境（CI / クラウドセッション）では
 * 環境変数でトークンを渡す。
 */
export async function getToken(): Promise<string> {
  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    return stdout.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GitHub トークンを取得できませんでした (${message})。` +
        "GITHUB_TOKEN 環境変数を設定するか、gh CLI で gh auth login してください。",
    );
  }
}
