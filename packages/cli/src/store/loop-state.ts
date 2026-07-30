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
  private path: string | null;
  private binding: {
    readText(slot: "loop-state"): Promise<string | null>;
    writeText(slot: "loop-state", content: string): Promise<void>;
  } | null;

  constructor(
    projectRootOrBinding:
      | string
      | {
          readText(slot: "loop-state"): Promise<string | null>;
          writeText(slot: "loop-state", content: string): Promise<void>;
        },
  ) {
    this.path =
      typeof projectRootOrBinding === "string"
        ? join(projectRootOrBinding, GANTT_DIR, LOOP_STATE_FILE)
        : null;
    this.binding = typeof projectRootOrBinding === "string" ? null : projectRootOrBinding;
  }

  /** ファイル不在（未初期化）は null を返す。破損・スキーマ不一致は例外を投げる。 */
  async readOrNull(): Promise<LoopState | null> {
    let raw: string | null;
    try {
      raw = this.binding
        ? await this.binding.readText("loop-state")
        : await readFile(this.path!, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (raw === null) return null;
    return LoopStateSchema.parse(JSON.parse(raw));
  }

  async write(state: LoopState): Promise<void> {
    const content = JSON.stringify(state, null, 2) + "\n";
    if (this.binding) {
      await this.binding.writeText("loop-state", content);
      return;
    }
    await mkdir(join(this.path!, ".."), { recursive: true });
    await writeAtomic(this.path!, content);
  }
}
