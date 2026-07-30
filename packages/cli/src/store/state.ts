import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SyncStateSchema, GANTT_DIR, SYNC_STATE_FILE } from "@gh-gantt/shared";
import type { SyncState } from "@gh-gantt/shared";

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content);
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export class SyncStateStore {
  private path: string | null;
  private binding: {
    readText(slot: "sync-state"): Promise<string | null>;
    writeText(slot: "sync-state", content: string): Promise<void>;
  } | null;

  constructor(
    projectRootOrBinding:
      | string
      | {
          readText(slot: "sync-state"): Promise<string | null>;
          writeText(slot: "sync-state", content: string): Promise<void>;
        },
  ) {
    this.path =
      typeof projectRootOrBinding === "string"
        ? join(projectRootOrBinding, GANTT_DIR, SYNC_STATE_FILE)
        : null;
    this.binding = typeof projectRootOrBinding === "string" ? null : projectRootOrBinding;
  }

  async read(): Promise<SyncState> {
    const raw = this.binding
      ? await this.binding.readText("sync-state")
      : await readFile(this.path!, "utf-8");
    if (raw === null) {
      throw Object.assign(new Error("sync-state.json が見つかりません"), { code: "ENOENT" });
    }
    return SyncStateSchema.parse(JSON.parse(raw));
  }

  /**
   * ファイル不在（新品クローン等）は初回同期用の空 state を返す。破損は例外のまま。
   * last_synced_at が空のため executePull は quick-check をバイパスしフル同期する。
   */
  async readOrDefault(): Promise<SyncState> {
    try {
      return await this.read();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          last_synced_at: "",
          project_node_id: "",
          id_map: {},
          field_ids: {},
          snapshots: {},
        };
      }
      throw err;
    }
  }

  async write(data: SyncState): Promise<void> {
    const content = JSON.stringify(data, null, 2) + "\n";
    if (this.binding) {
      await this.binding.writeText("sync-state", content);
      return;
    }
    await mkdir(join(this.path!, ".."), { recursive: true });
    await writeAtomic(this.path!, content);
  }
}
