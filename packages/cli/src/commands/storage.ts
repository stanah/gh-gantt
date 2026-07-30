import { Command } from "commander";
import { ProjectStorageError, withProjectStorage } from "../store/project-storage.js";

export interface StorageCommandDependencies {
  projectRoot?: () => string;
}

/** 分岐したlegacy cacheの正本をoperatorが明示して共有snapshotへ移行する。 */
export function createStorageCommand(dependencies: StorageCommandDependencies = {}): Command {
  const storage = new Command("storage").description("Project Storage の配置と移行を管理する");

  storage
    .command("migrate")
    .description("選択したworktreeのlegacy cacheを共有snapshotへ移行する")
    .requiredOption("--from <worktree>", "正本として選ぶworktree root")
    .option("--json", "JSON形式で出力する")
    .action(async (options: { from: string; json?: boolean }) => {
      try {
        await withProjectStorage(
          dependencies.projectRoot?.() ?? process.cwd(),
          {
            mode: "write",
            scope: "shared-cache",
            legacySource: options.from,
          },
          async (projectStorage) => {
            await projectStorage.ensureSharedCache();
          },
        );
        if (options.json) {
          console.log(JSON.stringify({ ok: true, source: options.from }, null, 2));
        } else {
          console.log(`legacy cache の移行が完了しました: ${options.from}`);
        }
      } catch (error) {
        const code = error instanceof ProjectStorageError ? error.code : "STORAGE_MIGRATION_FAILED";
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) {
          console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
        } else {
          console.error(`${code}: ${message}`);
        }
        process.exitCode = 1;
      }
    });

  return storage;
}

export const storageCommand = createStorageCommand();
