/**
 * スモークテストの環境設定
 *
 * ADR-008 に従い、個人リポジトリと Org リポジトリの 2 系統を定義する。
 * 環境変数で上書き可能にし、CI と ローカルの両方で利用できるようにする。
 */

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
  if (env === "personal") {
    return {
      repo: process.env["SMOKE_PERSONAL_REPO"] ?? "stanah/gh-gantt-e2e-test",
      projectUrl:
        process.env["SMOKE_PERSONAL_PROJECT_URL"] ?? "https://github.com/users/stanah/projects/4",
      description: "個人リポジトリ (Labels フォールバック)",
    };
  }

  return {
    repo: process.env["SMOKE_ORG_REPO"] ?? "gh-gantt-e2e/test-repo",
    projectUrl:
      process.env["SMOKE_ORG_PROJECT_URL"] ?? "https://github.com/orgs/gh-gantt-e2e/projects/1",
    description: "Org リポジトリ (Issue Types 有効)",
  };
}
