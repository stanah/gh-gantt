import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LoopStateSchema, GANTT_DIR, LOOP_STATE_FILE } from "@gh-gantt/shared";
import type { LoopState } from "@gh-gantt/shared";

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

/**
 * `.gantt-sync/loop-state.json`（外側ループの実行ジャーナル）の読み書き。
 *
 * このファイルは tasks.json / sync-state.json と同様に直接編集禁止であり、
 * `gh-gantt loop` コマンド経由でのみ操作する（ADR-016）。
 */
export class LoopStateStore {
  private path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, GANTT_DIR, LOOP_STATE_FILE);
  }

  /** ファイル不在（未初期化）は null を返す。破損・スキーマ不一致は例外を投げる。 */
  async readOrNull(): Promise<LoopState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return LoopStateSchema.parse(JSON.parse(raw));
  }

  async write(state: LoopState): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeAtomic(this.path, JSON.stringify(state, null, 2) + "\n");
  }
}
