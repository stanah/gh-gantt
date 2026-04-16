/**
 * スモークテストの環境設定
 *
 * ADR-008 に従い、個人リポジトリと Org リポジトリの 2 系統を定義する。
 * 環境変数で上書き可能にし、CI と ローカルの両方で利用できるようにする。
 */
import { execFileSync } from "node:child_process";

/** スモーク環境の種別 */
export type SmokeEnv = "personal" | "org";

/** 環境ごとの設定 */
export interface EnvConfig {
  /** GitHub リポジトリ (owner/repo 形式) */
  repo: string;
  /** GitHub Projects V2 の URL */
  projectUrl: string;
  /** 説明 */
  description: string;
}

/**
 * 環境設定を取得する
 *
 * 環境変数で上書き可能:
 * - SMOKE_PERSONAL_REPO / SMOKE_PERSONAL_PROJECT_URL
 * - SMOKE_ORG_REPO / SMOKE_ORG_PROJECT_URL
 */
export function getEnvConfig(env: SmokeEnv): EnvConfig {
  // 空文字列も未設定として扱うため `||` を使用 (CI の空 secrets 対策)
  if (env === "personal") {
    return {
      repo: process.env["SMOKE_PERSONAL_REPO"] || "stanah/gh-gantt-e2e-test",
      projectUrl:
        process.env["SMOKE_PERSONAL_PROJECT_URL"] || "https://github.com/users/stanah/projects/4",
      description: "個人リポジトリ (Labels フォールバック)",
    };
  }

  return {
    repo: process.env["SMOKE_ORG_REPO"] || "gh-gantt-e2e/test-repo",
    projectUrl:
      process.env["SMOKE_ORG_PROJECT_URL"] || "https://github.com/orgs/gh-gantt-e2e/projects/1",
    description: "Org リポジトリ (Issue Types 有効)",
  };
}

/**
 * GitHub 認証トークンを取得する
 *
 * 優先順:
 * 1. 環境変数 `GITHUB_TOKEN`
 * 2. 環境変数 `GH_TOKEN`
 * 3. gh CLI の `gh auth token` (ローカル実行で `gh auth login` 済みの場合)
 *
 * 取得できない場合は `null` を返す。
 * CI で secrets が未登録な状態では空文字列が渡されるため、空文字列も未設定として扱う。
 */
export function getAuthToken(): string | null {
  const githubToken = process.env["GITHUB_TOKEN"]?.trim();
  if (githubToken) return githubToken;

  const ghToken = process.env["GH_TOKEN"]?.trim();
  if (ghToken) return ghToken;

  // gh CLI にフォールバック (ローカル実行で gh auth login 済みの場合)
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * 認証トークンが取得可能か確認する
 *
 * 失敗時は run.ts 側で明示的に exit(1) される (silent success は不適切)。
 */
export function hasRequiredAuth(): boolean {
  return getAuthToken() !== null;
}
