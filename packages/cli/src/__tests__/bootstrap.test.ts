import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { getToken } from "../github/auth.js";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gh-gantt-bootstrap-"));
  createdDirs.push(dir);
  return dir;
}

describe("新品クローンからのブートストラップ（store の readOrDefault）", () => {
  it("tasks.json 不在なら空の初期値を返す", async () => {
    const store = new TasksStore(await freshDir());
    expect(await store.readOrDefault()).toEqual({
      tasks: [],
      cache: { comments: {}, reactions: {} },
    });
  });

  it("sync-state.json 不在なら初回同期用の空 state（last_synced_at 空）を返す", async () => {
    const store = new SyncStateStore(await freshDir());
    const state = await store.readOrDefault();
    // last_synced_at が空 → executePull は quick-check をバイパスしフル同期する
    expect(state.last_synced_at).toBe("");
    expect(state.id_map).toEqual({});
    expect(state.snapshots).toEqual({});
  });

  it("ファイルが存在する場合は通常どおり内容を返す", async () => {
    const dir = await freshDir();
    const store = new SyncStateStore(dir);
    await store.write({
      last_synced_at: "2026-07-04T00:00:00Z",
      project_node_id: "PVT_x",
      id_map: {},
      field_ids: {},
      snapshots: {},
    });
    expect((await store.readOrDefault()).last_synced_at).toBe("2026-07-04T00:00:00Z");
  });

  it("破損したファイルは初期値に落とさず例外にする（silent failure の禁止）", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, ".gantt-sync"), { recursive: true });
    await writeFile(join(dir, ".gantt-sync", "tasks.json"), "{ broken");
    await expect(new TasksStore(dir).readOrDefault()).rejects.toThrow();
  });
});

describe("getToken の環境変数フォールバック", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("GITHUB_TOKEN が設定されていればそれを使う（gh CLI 不要）", async () => {
    process.env.GITHUB_TOKEN = "ghp_env_token";
    delete process.env.GH_TOKEN;
    expect(await getToken()).toBe("ghp_env_token");
  });

  it("GITHUB_TOKEN がなければ GH_TOKEN にフォールバックする", async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "ghp_gh_token";
    expect(await getToken()).toBe("ghp_gh_token");
  });

  it("空白のみのトークンは未設定として扱う", async () => {
    process.env.GITHUB_TOKEN = "  ";
    process.env.GH_TOKEN = "ghp_fallback";
    expect(await getToken()).toBe("ghp_fallback");
  });
});
