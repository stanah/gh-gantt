import { describe, expect, it } from "vitest";

import { getEnvConfig } from "../config.js";

describe("[NFR-STABILITY-003-AC1] 個人リポジトリのスモーク設定", () => {
  it("個人環境のデフォルト設定が正しい", () => {
    const config = getEnvConfig("personal");
    expect(config.repo).toBe("stanah/gh-gantt-e2e-test");
    expect(config.projectUrl).toBe("https://github.com/users/stanah/projects/4");
    expect(config.description).toContain("個人");
  });

  it("環境変数で個人環境の設定を上書きできる", () => {
    const origRepo = process.env["SMOKE_PERSONAL_REPO"];
    const origUrl = process.env["SMOKE_PERSONAL_PROJECT_URL"];

    try {
      process.env["SMOKE_PERSONAL_REPO"] = "test-user/test-repo";
      process.env["SMOKE_PERSONAL_PROJECT_URL"] = "https://github.com/users/test-user/projects/1";

      const config = getEnvConfig("personal");
      expect(config.repo).toBe("test-user/test-repo");
      expect(config.projectUrl).toBe("https://github.com/users/test-user/projects/1");
    } finally {
      if (origRepo === undefined) {
        delete process.env["SMOKE_PERSONAL_REPO"];
      } else {
        process.env["SMOKE_PERSONAL_REPO"] = origRepo;
      }
      if (origUrl === undefined) {
        delete process.env["SMOKE_PERSONAL_PROJECT_URL"];
      } else {
        process.env["SMOKE_PERSONAL_PROJECT_URL"] = origUrl;
      }
    }
  });
});

describe("[NFR-STABILITY-003-AC2] Org リポジトリのスモーク設定", () => {
  it("Org 環境のデフォルト設定が正しい", () => {
    const config = getEnvConfig("org");
    expect(config.repo).toBe("gh-gantt-e2e/test-repo");
    expect(config.projectUrl).toBe("https://github.com/orgs/gh-gantt-e2e/projects/1");
    expect(config.description).toContain("Org");
  });

  it("環境変数で Org 環境の設定を上書きできる", () => {
    const origRepo = process.env["SMOKE_ORG_REPO"];
    const origUrl = process.env["SMOKE_ORG_PROJECT_URL"];

    try {
      process.env["SMOKE_ORG_REPO"] = "test-org/test-repo";
      process.env["SMOKE_ORG_PROJECT_URL"] = "https://github.com/orgs/test-org/projects/1";

      const config = getEnvConfig("org");
      expect(config.repo).toBe("test-org/test-repo");
      expect(config.projectUrl).toBe("https://github.com/orgs/test-org/projects/1");
    } finally {
      if (origRepo === undefined) {
        delete process.env["SMOKE_ORG_REPO"];
      } else {
        process.env["SMOKE_ORG_REPO"] = origRepo;
      }
      if (origUrl === undefined) {
        delete process.env["SMOKE_ORG_PROJECT_URL"];
      } else {
        process.env["SMOKE_ORG_PROJECT_URL"] = origUrl;
      }
    }
  });
});

describe("[NFR-STABILITY-004-AC1] スモークテストのローカル実行", () => {
  it("pnpm smoke:personal / smoke:org のスクリプトエントリが存在する", async () => {
    // smoke パッケージの package.json にスクリプトが定義されていることを確認
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const pkgJson = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../../package.json"), "utf-8"),
    );
    expect(pkgJson.scripts["smoke:personal"]).toBeDefined();
    expect(pkgJson.scripts["smoke:org"]).toBeDefined();
  });

  it("run.ts のエントリポイントが存在する", async () => {
    const { access } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const entryPath = resolve(import.meta.dirname, "../run.ts");
    await expect(access(entryPath)).resolves.toBeUndefined();
  });
});

describe("[NFR-STABILITY-004-AC2] CI スモークワークフローの構成", () => {
  it("smoke.yml ワークフローファイルが存在する", async () => {
    const { access } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const workflowPath = resolve(import.meta.dirname, "../../../../.github/workflows/smoke.yml");
    await expect(access(workflowPath)).resolves.toBeUndefined();
  });

  it("smoke.yml に PR トリガーが含まれている", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const workflowPath = resolve(import.meta.dirname, "../../../../.github/workflows/smoke.yml");
    const content = await readFile(workflowPath, "utf-8");
    expect(content).toContain("pull_request");
    expect(content).toContain("schedule");
    expect(content).toContain("smoke-personal");
    expect(content).toContain("smoke-org");
  });
});
