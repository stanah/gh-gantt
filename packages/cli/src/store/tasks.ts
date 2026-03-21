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
  private path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, GANTT_DIR, TASKS_FILE);
  }

  async read(): Promise<TasksFile> {
    const raw = await readFile(this.path, "utf-8");
    return TasksFileWithConflictsSchema.parse(JSON.parse(raw)) as TasksFile;
  }

  async write(data: TasksFile): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeAtomic(this.path, JSON.stringify(data, null, 2) + "\n");
  }
}
