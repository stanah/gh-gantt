import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ConfigSchema, GANTT_DIR, CONFIG_FILE } from "@gh-gantt/shared";
import type { Config } from "@gh-gantt/shared";

const DEFAULT_STARTS_WORK_NAMES = ["in progress", "in review", "active", "working"];

export class ConfigStore {
  private path: string | null;
  private binding: {
    readText(slot: "config"): Promise<string | null>;
    writeText(slot: "config", content: string): Promise<void>;
  } | null;

  constructor(
    projectRootOrBinding:
      | string
      | {
          readText(slot: "config"): Promise<string | null>;
          writeText(slot: "config", content: string): Promise<void>;
        },
  ) {
    this.path =
      typeof projectRootOrBinding === "string"
        ? join(projectRootOrBinding, GANTT_DIR, CONFIG_FILE)
        : null;
    this.binding = typeof projectRootOrBinding === "string" ? null : projectRootOrBinding;
  }

  async read(): Promise<Config> {
    const raw = this.binding
      ? await this.binding.readText("config")
      : await readFile(this.path!, "utf-8");
    if (raw === null) {
      throw Object.assign(new Error("gantt.config.json が見つかりません"), { code: "ENOENT" });
    }
    const config = ConfigSchema.parse(JSON.parse(raw));
    // Auto-migrate: fill in starts_work for known status names
    for (const [name, sv] of Object.entries(config.statuses.values)) {
      if (sv.starts_work === undefined && DEFAULT_STARTS_WORK_NAMES.includes(name.toLowerCase())) {
        sv.starts_work = true;
      }
    }
    // deprecated な sync.field_mapping.status が正 (statuses.field_name) と
    // 食い違っている場合に警告する (#315)。値は無視され pull/push には影響しない。
    const deprecatedStatus = config.sync.field_mapping.status;
    if (deprecatedStatus !== undefined && deprecatedStatus !== config.statuses.field_name) {
      console.warn(
        `WARNING: sync.field_mapping.status ("${deprecatedStatus}") は deprecated であり無視されます。` +
          `pull/push は statuses.field_name ("${config.statuses.field_name}") を使用します。` +
          `gantt.config.json から sync.field_mapping.status を削除してください。`,
      );
    }
    return config;
  }

  async write(config: Config): Promise<void> {
    const content = JSON.stringify(config, null, 2) + "\n";
    if (this.binding) {
      await this.binding.writeText("config", content);
      return;
    }
    await mkdir(join(this.path!, ".."), { recursive: true });
    await writeFile(this.path!, content);
  }

  /** ファイルの存在判定。ENOENT のみ false とし、権限エラー等は再 throw する。 */
  async exists(): Promise<boolean> {
    if (this.binding) return (await this.binding.readText("config")) !== null;
    try {
      await readFile(this.path!);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
