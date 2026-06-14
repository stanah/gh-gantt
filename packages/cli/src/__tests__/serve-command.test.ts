import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => {
  const staticMiddleware = Symbol("staticMiddleware");
  const apiRouter = Symbol("apiRouter");
  const rateLimitMiddleware = Symbol("rateLimitMiddleware");
  const app = {
    use: vi.fn(),
    get: vi.fn(),
    listen: vi.fn((_port: number, callback?: () => void) => {
      callback?.();
      return { close: vi.fn() };
    }),
  };
  const express = vi.fn(() => app) as unknown as ReturnType<typeof vi.fn> & {
    static: ReturnType<typeof vi.fn>;
  };
  express.static = vi.fn(() => staticMiddleware);
  const rateLimit = vi.fn(() => rateLimitMiddleware);

  return {
    apiRouter,
    app,
    createApiRouter: vi.fn(() => apiRouter),
    existsSync: vi.fn(),
    express,
    rateLimit,
    rateLimitMiddleware,
    staticMiddleware,
  };
});

vi.mock("express", () => ({
  default: mocks.express,
}));

vi.mock("express-rate-limit", () => ({
  default: mocks.rateLimit,
}));

vi.mock("node:fs", async (importOriginal: () => Promise<typeof import("node:fs")>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: mocks.existsSync,
  };
});

vi.mock("../server/api.js", () => ({
  createApiRouter: mocks.createApiRouter,
}));

describe("serve コマンド", () => {
  let projectRoot: string;
  let originalCwd: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gh-gantt-serve-project-")));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    consoleLog.mockRestore();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("実行中のプロジェクトではなく CLI 側の UI ビルド成果物を配信する", async () => {
    const { serveCommand } = await import("../commands/serve.js");
    const testDir = dirname(fileURLToPath(import.meta.url));
    const cliUiDistPath = join(testDir, "..", "..", "..", "ui", "dist");
    const projectUiDistPath = join(projectRoot, "packages", "ui", "dist");

    mocks.existsSync.mockImplementation((path: unknown) => path === cliUiDistPath);

    await serveCommand.parseAsync(["serve", "--port", "0"], { from: "user" });

    expect(mocks.existsSync).not.toHaveBeenCalledWith(projectUiDistPath);
    expect(mocks.express.static).toHaveBeenCalledWith(cliUiDistPath);
    expect(mocks.app.use).toHaveBeenCalledWith(mocks.staticMiddleware);
    expect(mocks.createApiRouter).toHaveBeenCalledWith(projectRoot);
  });

  it("/api 配下の未定義パスは SPA fallback ではなく API 側へ委譲する", async () => {
    const { serveCommand } = await import("../commands/serve.js");
    const testDir = dirname(fileURLToPath(import.meta.url));
    const cliUiDistPath = join(testDir, "..", "..", "..", "ui", "dist");

    mocks.existsSync.mockImplementation((path: unknown) => path === cliUiDistPath);

    await serveCommand.parseAsync(["serve", "--port", "0"], { from: "user" });

    const fallbackHandler = mocks.app.get.mock.calls.find(([path]) => path === "*")?.[1] as
      | ((
          req: { path: string },
          res: { sendFile: ReturnType<typeof vi.fn> },
          next: () => void,
        ) => void)
      | undefined;
    if (!fallbackHandler) throw new Error("SPA fallback handler not found");

    const sendFile = vi.fn();
    const next = vi.fn();

    fallbackHandler({ path: "/api/missing" }, { sendFile }, next);

    expect(next).toHaveBeenCalledOnce();
    expect(sendFile).not.toHaveBeenCalled();
  });

  describe("[NFR-STABILITY-011-AC2] rate limiter 登録順序", () => {
    it("API router の前に rate limiter を登録する", async () => {
      const { serveCommand } = await import("../commands/serve.js");

      await serveCommand.parseAsync(["serve", "--port", "0", "--api-only"], { from: "user" });

      expect(mocks.rateLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          windowMs: 60_000,
          limit: 120,
          standardHeaders: true,
          legacyHeaders: false,
        }),
      );
      const middlewares = mocks.app.use.mock.calls.map(([middleware]) => middleware);
      expect(middlewares.indexOf(mocks.rateLimitMiddleware)).toBeGreaterThanOrEqual(0);
      expect(middlewares.indexOf(mocks.apiRouter)).toBeGreaterThan(
        middlewares.indexOf(mocks.rateLimitMiddleware),
      );
    });
  });
});
