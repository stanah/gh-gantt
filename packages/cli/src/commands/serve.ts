import { Command } from "commander";
import express from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createApiRouter } from "../server/api.js";
import { DEFAULT_PORT } from "@gh-gantt/shared";

export const serveCommand = new Command("serve")
  .description("Start the Gantt chart UI server")
  .option("-p, --port <port>", "Port number", String(DEFAULT_PORT))
  .option("--api-only", "Only start the API server (no UI)")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const port = parseInt(opts.port, 10);

    const app = express();

    // CORS for dev mode (Vite dev server on different port)
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

    // Mount API routes
    const apiRouter = createApiRouter(projectRoot);
    app.use(apiRouter);

    if (!opts.apiOnly) {
      // Serve built UI if available
      const uiDistPath = join(projectRoot, "packages", "ui", "dist");
      if (existsSync(uiDistPath)) {
        app.use(express.static(uiDistPath));
        // SPA fallback
        app.get("*", (_req, res) => {
          res.sendFile(join(uiDistPath, "index.html"));
        });
        console.log(`Serving UI from ${uiDistPath}`);
      } else {
        console.log(`No built UI found. Run 'pnpm --filter @gh-gantt/ui build' first.`);
        console.log(`For development, use 'pnpm dev' to start Vite dev server alongside.`);
      }
    }

    app.listen(port, () => {
      console.log(`gh-gantt server running on http://localhost:${port}`);
    });
  });
