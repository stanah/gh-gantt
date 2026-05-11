#!/usr/bin/env node
// gh-gantt serve が npm install 環境でも UI を配信できるよう、UI ビルド成果物を CLI dist 配下に複製する。
// 配置先は packages/cli/src/commands/serve.ts の探索パス（dist/ui/dist）と一致させる。
import { cp, access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const uiDist = join(cliRoot, "..", "ui", "dist");
const target = join(cliRoot, "dist", "ui", "dist");

try {
  await access(uiDist);
} catch {
  console.error(`[bundle-ui] UI dist が見つからない: ${uiDist}`);
  console.error("[bundle-ui] 先に 'pnpm --filter @gh-gantt/ui build' を実行すること。");
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(uiDist, target, { recursive: true });
console.log(`[bundle-ui] copied ${uiDist} -> ${target}`);
