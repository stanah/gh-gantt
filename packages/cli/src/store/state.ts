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
  private path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, GANTT_DIR, SYNC_STATE_FILE);
  }

  async read(): Promise<SyncState> {
    const raw = await readFile(this.path, "utf-8");
    return SyncStateSchema.parse(JSON.parse(raw));
  }

  async write(data: SyncState): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeAtomic(this.path, JSON.stringify(data, null, 2) + "\n");
  }
}
