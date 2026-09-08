import { Command } from "commander";
import {
  ProjectStorageError,
  withProjectStorage,
  type ProjectStorageDescription,
  type StorageMode,
  type StorageRelocationReport,
} from "../store/project-storage.js";
import { isStorageMode, STORAGE_MODES } from "../store/storage-location.js";

export interface StorageCommandDependencies {
  projectRoot?: () => string;
}

function reportError(error: unknown, json: boolean | undefined, fallbackCode: string): void {
  const code = error instanceof ProjectStorageError ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
  } else {
    console.error(`${code}: ${message}`);
  }
  process.exitCode = 1;
}

function parseStorageMode(value: string): StorageMode {
  if (!isStorageMode(value)) {
    throw new Error(
      `配置モードは ${STORAGE_MODES.join(" | ")} のいずれかを指定してください: ${value}`,
    );
  }
  return value;
}

export function formatStorageDescription(description: ProjectStorageDescription): string[] {
  const lines = [
    `Storage mode:      ${description.mode}`,
    `Project root:      ${description.projectRoot}`,
    `Git common dir:    ${description.gitCommonDir ?? "(non-git)"}`,
    `Config:            ${description.paths.config}`,
    `Workflow:          ${description.paths.workflow}`,
    `Loop state:        ${description.paths.loopState}`,
    `Run Graph:         ${description.paths.runGraph}`,
    `Work Graph Cache:  ${description.sharedCacheRoot ?? "(config が無いため未解決)"}`,
  ];
  if (description.mode === "git") {
    lines.push(`Repository dir:    ${description.paths.repositoryDir} (git モードでは未使用)`);
  } else if (description.paths.gitConfigDir) {
    lines.push(`Git mode config:   ${description.paths.gitConfigDir} (未使用)`);
  }
  return lines;
}

function formatRelocation(report: StorageRelocationReport): string[] {
  if (!report.changed) {
    return [`配置モードは既に ${report.to} です。変更はありません`];
  }
  const lines = [`配置モードを ${report.from} から ${report.to} へ移行しました`];
  for (const item of report.moved) {
    lines.push(`  ${item.slot}: ${item.from} -> ${item.to}`);
  }
  if (report.to === "git") {
    lines.push(
      "  config / workflow を git 管理していた場合は、削除をコミットして追跡から外してください",
      "  (例: git rm --cached .gantt-sync/gantt.config.json .gantt-sync/workflow.md)",
    );
  } else {
    lines.push(
      "  config / workflow を共有するには .gantt-sync/ 配下の 2 file をコミットしてください",
    );
  }
  return lines;
}

/** Project Storage の配置モードの表示と移行、分岐した legacy cache の明示的な移行を扱う。 */
export function createStorageCommand(dependencies: StorageCommandDependencies = {}): Command {
  const storage = new Command("storage").description("Project Storage の配置と移行を管理する");
  const projectRoot = () => dependencies.projectRoot?.() ?? process.cwd();

  storage
    .command("status")
    .description("配置モード (repository / git) と解決済みの path を表示する")
    .option("--json", "JSON形式で出力する")
    .action(async (options: { json?: boolean }) => {
      try {
        const description = await withProjectStorage(
          projectRoot(),
          { mode: "read", scope: "workspace" },
          (session) => session.describeStorage(),
        );
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...description }, null, 2));
        } else {
          for (const line of formatStorageDescription(description)) console.log(line);
        }
      } catch (error) {
        reportError(error, options.json, "STORAGE_STATUS_FAILED");
      }
    });

  storage
    .command("migrate")
    .description(
      "legacy cache の正本を明示して共有snapshotへ移行する (--from)、" +
        "または config / workflow / journal の配置モードを切り替える (--to)",
    )
    .option("--from <worktree>", "正本として選ぶworktree root")
    .option("--to <mode>", `移行先の配置モード (${STORAGE_MODES.join(" | ")})`)
    .option("--json", "JSON形式で出力する")
    .action(async (options: { from?: string; to?: string; json?: boolean }) => {
      if (!options.from && !options.to) {
        reportError(
          new Error("--from <worktree> または --to <mode> のどちらかを指定してください"),
          options.json,
          "STORAGE_MIGRATION_INVALID",
        );
        return;
      }
      if (options.from && options.to) {
        reportError(
          new Error("--from と --to は同時に指定できません"),
          options.json,
          "STORAGE_MIGRATION_INVALID",
        );
        return;
      }
      try {
        if (options.to) {
          const target = parseStorageMode(options.to);
          const report = await withProjectStorage(
            projectRoot(),
            { mode: "write", scope: "all" },
            (session) => session.relocateStorage(target),
          );
          if (options.json) {
            console.log(JSON.stringify({ ok: true, ...report }, null, 2));
          } else {
            for (const line of formatRelocation(report)) console.log(line);
          }
          return;
        }
        await withProjectStorage(
          projectRoot(),
          {
            mode: "write",
            scope: "shared-cache",
            legacySource: options.from,
          },
          async (session) => {
            await session.ensureSharedCache();
          },
        );
        if (options.json) {
          console.log(JSON.stringify({ ok: true, source: options.from }, null, 2));
        } else {
          console.log(`legacy cache の移行が完了しました: ${options.from}`);
        }
      } catch (error) {
        reportError(error, options.json, "STORAGE_MIGRATION_FAILED");
      }
    });

  return storage;
}

export const storageCommand = createStorageCommand();
