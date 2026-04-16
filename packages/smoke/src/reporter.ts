/**
 * スモークテスト結果のレポーター
 *
 * 結果を人間が読みやすい形式でコンソールに出力する。
 * CI では終了コードで成否を判定するため、出力はログ用途。
 */
import type { SmokeResult, StepResult } from "./runner.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function formatStep(step: StepResult): string {
  const icon = step.success ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const duration = `${YELLOW}${step.durationMs}ms${RESET}`;
  let line = `  ${icon} ${step.name} (${duration})`;
  if (step.error) {
    // エラーメッセージの最初の行だけ表示
    const firstLine = step.error.split("\n")[0] ?? "";
    line += `\n       ${RED}${firstLine}${RESET}`;
  }
  return line;
}

/**
 * スモーク結果をコンソールに出力する
 */
export function reportResult(result: SmokeResult): void {
  const header = result.success
    ? `${GREEN}${BOLD}SMOKE PASSED${RESET}`
    : `${RED}${BOLD}SMOKE FAILED${RESET}`;

  console.log("");
  console.log(`${BOLD}--- Smoke Test: ${result.config.description} (${result.env}) ---${RESET}`);
  console.log(`リポジトリ: ${result.config.repo}`);
  console.log(`プロジェクト: ${result.config.projectUrl}`);
  console.log("");

  for (const step of result.steps) {
    console.log(formatStep(step));
  }

  console.log("");
  console.log(`${header}  合計: ${YELLOW}${result.totalDurationMs}ms${RESET}`);
  console.log("");
}
