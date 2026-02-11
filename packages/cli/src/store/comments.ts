import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CommentsFileSchema, GANTT_DIR, COMMENTS_FILE } from "@gh-gantt/shared";
import type { CommentsFile } from "@gh-gantt/shared";

const EMPTY: CommentsFile = { version: "1", fetched_at: {}, comments: {} };

export class CommentsStore {
  private path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, GANTT_DIR, COMMENTS_FILE);
  }

  async read(): Promise<CommentsFile> {
    try {
      const raw = await readFile(this.path, "utf-8");
      return CommentsFileSchema.parse(JSON.parse(raw));
    } catch {
      return { ...EMPTY, fetched_at: {}, comments: {} };
    }
  }

  async write(data: CommentsFile): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, JSON.stringify(data, null, 2) + "\n");
  }
}
