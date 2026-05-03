import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@gh-gantt/shared";
import { CONFIG_FILE, GANTT_DIR } from "@gh-gantt/shared";
import { createSprintCommand } from "../commands/sprint.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: "1",
    project: {
      name: "test",
      github: { owner: "owner", repo: "repo", project_number: 1 },
    },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#000000", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: {
        critical_path: "#ff0000",
        on_track: "#00ff00",
        at_risk: "#ffff00",
        overdue: "#ff0000",
      },
    },
    ...overrides,
  };
}

async function writeConfig(root: string, config: Config): Promise<void> {
  const configDir = join(root, GANTT_DIR);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
}

async function readConfig(root: string): Promise<Config> {
  const raw = await readFile(join(root, GANTT_DIR, CONFIG_FILE), "utf-8");
  return JSON.parse(raw) as Config;
}

async function runSprintCommand(args: string[]): Promise<void> {
  const command = createSprintCommand();
  command.exitOverride();
  await command.parseAsync(args, { from: "user" });
}

describe("[FR-CLI-009-AC1] sprint CLI で config の sprints を CRUD できる", () => {
  let tmpRoot: string;
  let originalCwd: string;
  let originalExitCode: number | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "gh-gantt-sprint-"));
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    process.chdir(tmpRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeConfig(tmpRoot, makeConfig());
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("list/create/update/delete が JSON とテキスト出力で同じ sprint 設定を扱う", async () => {
    await runSprintCommand([
      "create",
      "Sprint 1",
      "--start-date",
      "2026-05-04",
      "--end-date",
      "2026-05-15",
      "--color",
      "#123abc",
      "--json",
    ]);

    const created = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      sprint: { name: string; start_date: string; end_date: string; color: string };
    };
    expect(created.sprint).toEqual({
      name: "Sprint 1",
      start_date: "2026-05-04",
      end_date: "2026-05-15",
      color: "#123abc",
    });
    await expect(readConfig(tmpRoot)).resolves.toMatchObject({
      sprints: [created.sprint],
    });

    await runSprintCommand(["list", "--json"]);
    const listed = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      sprints: (typeof created.sprint)[];
    };
    expect(listed.sprints).toEqual([created.sprint]);

    await runSprintCommand([
      "update",
      "Sprint 1",
      "--name",
      "Sprint 1A",
      "--start-date",
      "2026-05-05",
      "--end-date",
      "2026-05-16",
      "--color",
      "#abcdef",
      "--json",
    ]);
    const updated = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      sprint: { name: string; start_date: string; end_date: string; color: string };
    };
    expect(updated.sprint).toEqual({
      name: "Sprint 1A",
      start_date: "2026-05-05",
      end_date: "2026-05-16",
      color: "#abcdef",
    });

    await runSprintCommand(["delete", "Sprint 1A"]);
    expect(logSpy.mock.calls.at(-1)?.[0]).toBe("Deleted sprint: Sprint 1A");
    await expect(readConfig(tmpRoot)).resolves.toMatchObject({ sprints: [] });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("[FR-CLI-009-AC2] sprint CLI は重複 name と不正な日付範囲を拒否する", () => {
  let tmpRoot: string;
  let originalCwd: string;
  let originalExitCode: number | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "gh-gantt-sprint-invalid-"));
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    process.chdir(tmpRoot);
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeConfig(
      tmpRoot,
      makeConfig({
        sprints: [
          {
            name: "Sprint 1",
            start_date: "2026-05-04",
            end_date: "2026-05-15",
            color: "#123abc",
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("既存 name の create と end_date < start_date の update を失敗扱いにする", async () => {
    await runSprintCommand([
      "create",
      "Sprint 1",
      "--start-date",
      "2026-06-01",
      "--end-date",
      "2026-06-14",
      "--color",
      "#654321",
    ]);
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toContain("already exists");

    process.exitCode = undefined;
    await runSprintCommand([
      "update",
      "Sprint 1",
      "--start-date",
      "2026-05-20",
      "--end-date",
      "2026-05-10",
    ]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toContain("start_date");
    await expect(readConfig(tmpRoot)).resolves.toMatchObject({
      sprints: [
        {
          name: "Sprint 1",
          start_date: "2026-05-04",
          end_date: "2026-05-15",
          color: "#123abc",
        },
      ],
    });
  });
});
