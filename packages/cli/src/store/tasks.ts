import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TasksFileWithConflictsSchema, GANTT_DIR, TASKS_FILE } from "@gh-gantt/shared";
import type { TasksFile } from "@gh-gantt/shared";

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

export class TasksStore {
  private path: string | null;
  private binding: {
    readText(slot: "tasks"): Promise<string | null>;
    writeText(slot: "tasks", content: string): Promise<void>;
  } | null;

  constructor(
    projectRootOrBinding:
      | string
      | {
          readText(slot: "tasks"): Promise<string | null>;
          writeText(slot: "tasks", content: string): Promise<void>;
        },
  ) {
    this.path =
      typeof projectRootOrBinding === "string"
        ? join(projectRootOrBinding, GANTT_DIR, TASKS_FILE)
        : null;
    this.binding = typeof projectRootOrBinding === "string" ? null : projectRootOrBinding;
  }

  async read(): Promise<TasksFile> {
    const raw = this.binding
      ? await this.binding.readText("tasks")
      : await readFile(this.path!, "utf-8");
    if (raw === null) {
      throw Object.assign(new Error("tasks.json が見つかりません"), { code: "ENOENT" });
    }
    return TasksFileWithConflictsSchema.parse(JSON.parse(raw)) as TasksFile;
  }

  /**
   * ファイル不在（新品クローン等）は空の初期値を返す。破損は例外のまま。
   * エフェメラル環境で pull が GitHub だけから状態を再構成するための入口。
   */
  async readOrDefault(): Promise<TasksFile> {
    try {
      return await this.read();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { tasks: [], cache: { comments: {}, reactions: {} } };
      }
      throw err;
    }
  }

  async write(data: TasksFile): Promise<void> {
    const content = JSON.stringify(data, null, 2) + "\n";
    if (this.binding) {
      await this.binding.writeText("tasks", content);
      return;
    }
    await mkdir(join(this.path!, ".."), { recursive: true });
    await writeAtomic(this.path!, content);
  }

  /** ファイルの存在判定。ENOENT のみ false とし、権限エラー等は再 throw する。 */
  async exists(): Promise<boolean> {
    if (this.binding) return (await this.binding.readText("tasks")) !== null;
    try {
      await readFile(this.path!);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
