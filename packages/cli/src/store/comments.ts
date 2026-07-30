import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CommentsFileSchema, GANTT_DIR, COMMENTS_FILE } from "@gh-gantt/shared";
import type { CommentsFile } from "@gh-gantt/shared";

const EMPTY: CommentsFile = { version: "1", fetched_at: {}, comments: {} };

export class CommentsStore {
  private path: string | null;
  private binding: {
    readText(slot: "comments"): Promise<string | null>;
    writeText(slot: "comments", content: string): Promise<void>;
  } | null;

  constructor(
    projectRootOrBinding:
      | string
      | {
          readText(slot: "comments"): Promise<string | null>;
          writeText(slot: "comments", content: string): Promise<void>;
        },
  ) {
    this.path =
      typeof projectRootOrBinding === "string"
        ? join(projectRootOrBinding, GANTT_DIR, COMMENTS_FILE)
        : null;
    this.binding = typeof projectRootOrBinding === "string" ? null : projectRootOrBinding;
  }

  async read(): Promise<CommentsFile> {
    try {
      const raw = this.binding
        ? await this.binding.readText("comments")
        : await readFile(this.path!, "utf-8");
      if (raw === null) return { ...EMPTY, fetched_at: {}, comments: {} };
      return CommentsFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...EMPTY, fetched_at: {}, comments: {} };
      }
      throw error;
    }
  }

  async write(data: CommentsFile): Promise<void> {
    const content = JSON.stringify(data, null, 2) + "\n";
    if (this.binding) {
      await this.binding.writeText("comments", content);
      return;
    }
    await mkdir(join(this.path!, ".."), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content);
    try {
      await rename(temporary, this.path!);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
