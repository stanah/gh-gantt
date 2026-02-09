import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ConfigSchema, GANTT_DIR, CONFIG_FILE } from "@gh-gantt/shared";
import type { Config } from "@gh-gantt/shared";

export class ConfigStore {
  private path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, GANTT_DIR, CONFIG_FILE);
  }

  async read(): Promise<Config> {
    const raw = await readFile(this.path, "utf-8");
    return ConfigSchema.parse(JSON.parse(raw));
  }

  async write(config: Config): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, JSON.stringify(config, null, 2) + "\n");
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(this.path);
      return true;
    } catch {
      return false;
    }
  }
}
