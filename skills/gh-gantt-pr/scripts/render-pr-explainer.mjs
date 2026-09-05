#!/usr/bin/env node
// PR 説明資料（単一 HTML）を PNG にレンダリングする helper。
// `gh pr create --attach` は画像・動画しか受け付けないため、HTML 自体は git 管理外に置き、
// PNG だけを PR body に添付する（skills/gh-gantt-pr/references/pr-explainer.md）。
//
// 使い方:
//   node skills/gh-gantt-pr/scripts/render-pr-explainer.mjs <input.html> <output.png> [--width <px>] [--scale <n>]
//
// playwright は実行 project の依存関係から解決する（`playwright` または `@playwright/test`）。
// browser 実行ファイルは PLAYWRIGHT_CHROMIUM_EXECUTABLE で上書きできる。
import { createRequire } from "node:module";
import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE =
  "使い方: node skills/gh-gantt-pr/scripts/render-pr-explainer.mjs <input.html> <output.png> [--width <px>] [--scale <n>]";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const options = { width: 1280, scale: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--width" || arg === "--scale") {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value <= 0) {
        fail(`${arg} は正の整数で指定してください: ${raw ?? "(未指定)"}\n${USAGE}`);
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`不明なオプションです: ${arg}\n${USAGE}`);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    fail(`入力 HTML と出力 PNG の 2 引数が必要です\n${USAGE}`);
  }
  const [input, output] = positional;
  if (!/\.html?$/i.test(input)) {
    fail(`入力は .html ファイルを指定してください: ${input}\n${USAGE}`);
  }
  if (!/\.png$/i.test(output)) {
    fail(`出力は .png ファイルを指定してください: ${output}\n${USAGE}`);
  }
  return { input: resolve(input), output: resolve(output), ...options };
}

function loadChromium() {
  const require = createRequire(resolve(process.cwd(), "package.json"));
  for (const name of ["playwright", "@playwright/test"]) {
    try {
      const mod = require(name);
      if (mod?.chromium) return mod.chromium;
    } catch {
      // 次の候補を試す
    }
  }
  fail(
    "playwright が見つかりません。実行 project に `playwright` または `@playwright/test` をインストールしてから再実行してください",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await access(args.input);
  } catch {
    fail(`入力 HTML が存在しません: ${args.input}`);
  }

  const chromium = loadChromium();
  await mkdir(dirname(args.output), { recursive: true });

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  let browser;
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  } catch (error) {
    fail(
      `Chromium を起動できません。\`npx playwright install chromium\` を実行するか、PLAYWRIGHT_CHROMIUM_EXECUTABLE を設定してください: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const page = await browser.newPage({
      viewport: { width: args.width, height: 720 },
      deviceScaleFactor: args.scale,
    });
    await page.goto(pathToFileURL(args.input).href, { waitUntil: "load" });
    // 外部リソース禁止の単一 HTML を前提とするが、Web font 等の遅延描画に備えて短く待つ
    await page.waitForTimeout(200);
    await page.screenshot({ path: args.output, fullPage: true });
  } finally {
    await browser.close();
  }

  process.stdout.write(
    `${JSON.stringify({ input: args.input, output: args.output, width: args.width, scale: args.scale })}\n`,
  );
}

main().catch((error) => {
  fail(`レンダリングに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
});
