import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TasksFileSchema, GANTT_DIR, TASKS_FILE } from "@gh-gantt/shared";
import type { TasksFile } from "@gh-gantt/shared";

export class TasksStore {
  private path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, GANTT_DIR, TASKS_FILE);
  }

  async read(): Promise<TasksFile> {
    const raw = await readFile(this.path, "utf-8");
    return TasksFileSchema.parse(JSON.parse(raw));
  }

  async write(data: TasksFile): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, JSON.stringify(data, null, 2) + "\n");
  }
}
