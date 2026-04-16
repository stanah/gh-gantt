import { describe, expect, it } from "vitest";

import { getAuthToken, getEnvConfig } from "../config.js";

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

describe("空文字列の環境変数はデフォルトにフォールバックする", () => {
  it("個人環境: 空文字列の SMOKE_PERSONAL_REPO でデフォルトが使われる", () => {
    const orig = process.env["SMOKE_PERSONAL_REPO"];
    try {
      process.env["SMOKE_PERSONAL_REPO"] = "";
      const config = getEnvConfig("personal");
      expect(config.repo).toBe("stanah/gh-gantt-e2e-test");
    } finally {
      if (orig === undefined) delete process.env["SMOKE_PERSONAL_REPO"];
      else process.env["SMOKE_PERSONAL_REPO"] = orig;
    }
  });

  it("Org 環境: 空文字列の SMOKE_ORG_REPO でデフォルトが使われる", () => {
    const orig = process.env["SMOKE_ORG_REPO"];
    try {
      process.env["SMOKE_ORG_REPO"] = "";
      const config = getEnvConfig("org");
      expect(config.repo).toBe("gh-gantt-e2e/test-repo");
    } finally {
      if (orig === undefined) delete process.env["SMOKE_ORG_REPO"];
      else process.env["SMOKE_ORG_REPO"] = orig;
    }
  });
});

describe("getAuthToken: 認証トークン取得のフォールバック", () => {
  it("GITHUB_TOKEN が設定されていれば優先して使う", () => {
    const origGithub = process.env["GITHUB_TOKEN"];
    const origGh = process.env["GH_TOKEN"];
    try {
      process.env["GITHUB_TOKEN"] = "token-from-github";
      process.env["GH_TOKEN"] = "token-from-gh";
      expect(getAuthToken()).toBe("token-from-github");
    } finally {
      if (origGithub === undefined) delete process.env["GITHUB_TOKEN"];
      else process.env["GITHUB_TOKEN"] = origGithub;
      if (origGh === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = origGh;
    }
  });

  it("GITHUB_TOKEN が未設定で GH_TOKEN があればそれを使う", () => {
    const origGithub = process.env["GITHUB_TOKEN"];
    const origGh = process.env["GH_TOKEN"];
    try {
      delete process.env["GITHUB_TOKEN"];
      process.env["GH_TOKEN"] = "token-from-gh";
      expect(getAuthToken()).toBe("token-from-gh");
    } finally {
      if (origGithub !== undefined) process.env["GITHUB_TOKEN"] = origGithub;
      if (origGh === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = origGh;
    }
  });

  it("GITHUB_TOKEN が空文字列でも fallback される (CI の空 secrets 対策)", () => {
    const origGithub = process.env["GITHUB_TOKEN"];
    const origGh = process.env["GH_TOKEN"];
    try {
      process.env["GITHUB_TOKEN"] = "";
      process.env["GH_TOKEN"] = "token-from-gh";
      expect(getAuthToken()).toBe("token-from-gh");
    } finally {
      if (origGithub === undefined) delete process.env["GITHUB_TOKEN"];
      else process.env["GITHUB_TOKEN"] = origGithub;
      if (origGh === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = origGh;
    }
  });
});

describe("[NFR-STABILITY-004-AC1] スモークテストのローカル実行", () => {
  it("ルートの package.json に smoke:personal / smoke:org スクリプトが定義されている", async () => {
    // リポジトリルートの package.json を参照して `pnpm smoke:*` の存在を担保する
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const rootPkgJson = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../../../../package.json"), "utf-8"),
    );
    expect(rootPkgJson.scripts["smoke:personal"]).toBeDefined();
    expect(rootPkgJson.scripts["smoke:org"]).toBeDefined();
  });

  it("smoke パッケージの package.json にスクリプトエントリが存在する", async () => {
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

describe("smoke ワークフロー (workflow_dispatch のみ、CI 自動実行は security review のため deferred)", () => {
  it("smoke.yml ワークフローファイルが存在する", async () => {
    const { access } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const workflowPath = resolve(import.meta.dirname, "../../../../.github/workflows/smoke.yml");
    await expect(access(workflowPath)).resolves.toBeUndefined();
  });

  it("smoke.yml に workflow_dispatch トリガーと両 job が含まれている", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const workflowPath = resolve(import.meta.dirname, "../../../../.github/workflows/smoke.yml");
    const content = await readFile(workflowPath, "utf-8");
    expect(content).toContain("workflow_dispatch");
    expect(content).toContain("smoke-personal");
    expect(content).toContain("smoke-org");
  });

  it("smoke.yml に自動トリガー (pull_request/push/schedule) が含まれていない", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const workflowPath = resolve(import.meta.dirname, "../../../../.github/workflows/smoke.yml");
    const content = await readFile(workflowPath, "utf-8");
    // PAT 配置の security review 完了まで自動トリガーは無効化
    expect(content).not.toMatch(/^on:\s*\n\s*pull_request:/m);
    expect(content).not.toMatch(/^\s*push:\s*\n\s*branches:/m);
    expect(content).not.toMatch(/^\s*schedule:\s*\n\s*-\s*cron:/m);
  });
});
