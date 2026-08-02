import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const LefthookConfigSchema = z.object({
  "pre-push": z.object({
    jobs: z.array(
      z.object({
        name: z.string().min(1),
        run: z.string().min(1),
      }),
    ),
  }),
});

describe("[NFR-STABILITY-002-AC2] [Issue #331] pre-push test runner のタイムアウト回帰", () => {
  it("process/lock 系テストを Vite+ task wrapper で二重に包まず直接実行する", async () => {
    const lefthook = LefthookConfigSchema.parse(
      parse(await readFile(resolve(repoRoot, "lefthook.yml"), "utf-8")),
    );
    const testJob = lefthook["pre-push"].jobs.find((job) => job.name === "test");

    expect(testJob?.run).toBe("pnpm test:json < /dev/null");
  });
});
