/**
 * スモークテストランナー
 *
 * gh-gantt CLI コマンドを順番に実行し、各ステップの成否を記録する。
 * ワークスペース内の CLI バイナリを直接参照し、グローバルインストールに依存しない。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EnvConfig, SmokeEnv } from "./config.js";

/** 個別ステップの結果 */
export interface StepResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/** スモーク全体の結果 */
export interface SmokeResult {
  env: SmokeEnv;
  config: EnvConfig;
  steps: StepResult[];
  totalDurationMs: number;
  success: boolean;
}

/** CLI バイナリのパス (ワークスペース内) */
const CLI_BIN = resolve(import.meta.dirname, "../../cli/dist/index.js");

/**
 * gh-gantt CLI コマンドを実行する
 *
 * 一時ディレクトリで実行し、テスト対象プロジェクトへの副作用を最小化する。
 */
function execCli(args: string[], options: { cwd: string; env?: Record<string, string> }): string {
  const result = execFileSync("node", [CLI_BIN, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result;
}

/**
 * 単一ステップを実行し、結果を記録する
 */
function runStep(name: string, fn: () => void): StepResult {
  const start = performance.now();
  try {
    fn();
    return {
      name,
      success: true,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    // execFileSync 例外には stderr/stdout が付与されるため、CI ログ追跡のため保持する
    const parts: string[] = [];
    if (err instanceof Error) {
      parts.push(err.message);
      const withStreams = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
      if (withStreams.stderr) {
        parts.push(`stderr: ${String(withStreams.stderr).trim()}`);
      }
      if (withStreams.stdout) {
        parts.push(`stdout: ${String(withStreams.stdout).trim()}`);
      }
    } else {
      parts.push(String(err));
    }
    return {
      name,
      success: false,
      durationMs: Math.round(performance.now() - start),
      error: parts.join("\n"),
    };
  }
}

/**
 * Tier 1 スモークシナリオを実行する
 *
 * ADR-008 の Tier 1: init → pull → status → push (read-only 確認)
 * push は --dry-run で実行し、実際の書き込みは行わない。
 */
export function runTier1Smoke(env: SmokeEnv, config: EnvConfig): SmokeResult {
  const totalStart = performance.now();
  const steps: StepResult[] = [];

  // 一時ディレクトリを作成
  const workDir = mkdtempSync(join(tmpdir(), "gh-gantt-smoke-"));

  try {
    // Step 1: init
    steps.push(
      runStep("init", () => {
        execCli(["init", "--repo", config.repo, "--project-url", config.projectUrl], {
          cwd: workDir,
        });
      }),
    );

    // init が失敗したら以降のステップはスキップ
    if (!steps[0]!.success) {
      return buildResult(env, config, steps, totalStart);
    }

    // Step 2: pull
    steps.push(
      runStep("pull", () => {
        execCli(["pull"], { cwd: workDir });
      }),
    );

    if (!steps[1]!.success) {
      return buildResult(env, config, steps, totalStart);
    }

    // Step 3: status
    steps.push(
      runStep("status", () => {
        execCli(["status"], { cwd: workDir });
      }),
    );

    // status が失敗した場合は push を実行しない（前ステップが壊れている状態で書き込み操作を試みるのは危険）
    if (!steps[2]!.success) {
      return buildResult(env, config, steps, totalStart);
    }

    // Step 4: push --dry-run (書き込み操作の検証だが実際には書き込まない)
    steps.push(
      runStep("push --dry-run", () => {
        execCli(["push", "--dry-run"], { cwd: workDir });
      }),
    );
  } finally {
    // 一時ディレクトリを削除
    rmSync(workDir, { recursive: true, force: true });
  }

  return buildResult(env, config, steps, totalStart);
}

function buildResult(
  env: SmokeEnv,
  config: EnvConfig,
  steps: StepResult[],
  totalStart: number,
): SmokeResult {
  return {
    env,
    config,
    steps,
    totalDurationMs: Math.round(performance.now() - totalStart),
    success: steps.every((s) => s.success),
  };
}
