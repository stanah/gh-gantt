import { Command } from "commander";
import express from "express";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "../server/api.js";
import { DEFAULT_PORT } from "@gh-gantt/shared";

export function resolveUiDistPath(moduleUrl = import.meta.url): string | null {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDir, "ui", "dist"),
    join(moduleDir, "..", "ui", "dist"),
    join(moduleDir, "..", "..", "ui", "dist"),
    join(moduleDir, "..", "..", "..", "ui", "dist"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export const serveCommand = new Command("serve")
  .description("Start the Gantt chart UI server")
  .option("-p, --port <port>", "Port number", String(DEFAULT_PORT))
  .option("--api-only", "Only start the API server (no UI)")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const port = parseInt(opts.port, 10);

    const app = express();

    // 開発時は Vite dev server が別ポートで動くため CORS を許可する。
    app.use((_req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type");
      if (_req.method === "OPTIONS") {
        res.sendStatus(200);
        return;
      }
      next();
    });

    // API は gh-gantt を実行したプロジェクトの同期データを読む。
    const apiRouter = createApiRouter(projectRoot);
    app.use(apiRouter);

    if (!opts.apiOnly) {
      const uiDistPath = resolveUiDistPath();
      if (uiDistPath) {
        app.use(express.static(uiDistPath));
        // SPA ルーティングは静的配信後に index.html へ戻す。
        app.get("*", (_req, res) => {
          res.sendFile(join(uiDistPath, "index.html"));
        });
        console.log(`Serving UI from ${uiDistPath}`);
      } else {
        console.log(
          `No built UI found in the gh-gantt installation. Run 'pnpm --filter @gh-gantt/ui build' first.`,
        );
        console.log(`For development, use 'pnpm dev' to start Vite dev server alongside.`);
      }
    }

    app.listen(port, () => {
      console.log(`gh-gantt server running on http://localhost:${port}`);
    });
  });
