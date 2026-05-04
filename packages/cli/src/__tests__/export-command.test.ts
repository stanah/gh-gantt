import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_FILE, GANTT_DIR, TASKS_FILE, type Config, type Task } from "@gh-gantt/shared";
import { createExportCommand, runExportCommand, type PngRenderer } from "../commands/export.js";

const config: Config = {
  version: "1",
  project: {
    name: "CLI Export Project",
    github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
  },
  type_hierarchy: { task: [] },
  statuses: {
    field_name: "Status",
    values: {
      Todo: { color: "#3498DB", done: false },
    },
  },
  gantt: {
    default_view: "month",
    working_days: [1, 2, 3, 4, 5],
    colors: {
      critical_path: "#E74C3C",
      on_track: "#2ECC71",
      at_risk: "#F39C12",
      overdue: "#E74C3C",
    },
  },
};

const task: Task = {
  id: "stanah/gh-gantt#20",
  type: "task",
  github_issue: 20,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "SVG/PNGエクスポート",
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
  closed_at: null,
  custom_fields: { Status: "Todo" },
  start_date: "2026-05-04",
  end_date: "2026-05-08",
  date: null,
  blocked_by: [],
};

async function writeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gh-gantt-export-"));
  const ganttDir = join(root, GANTT_DIR);
  await mkdir(ganttDir, { recursive: true });
  await Promise.all([
    writeFile(join(ganttDir, CONFIG_FILE), JSON.stringify(config, null, 2)),
    writeFile(
      join(ganttDir, TASKS_FILE),
      JSON.stringify({ tasks: [task], cache: { comments: {}, reactions: {} } }, null, 2),
    ),
  ]);
  return root;
}

describe("[FR-VIS-019-AC5] CLI エクスポートコマンド", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("export コマンドに format/scope/output/2x オプションが定義されている", () => {
    const command = createExportCommand();
    const optionNames = command.options.map((option) => option.long);

    expect(optionNames).toContain("--format");
    expect(optionNames).toContain("--scope");
    expect(optionNames).toContain("--output");
    expect(optionNames).toContain("--high-resolution");
  });

  it("SVG 形式でツリーとガントを含むファイルを書き出す", async () => {
    const root = await writeProject();
    const outputPath = join(root, "out.svg");

    await runExportCommand(root, {
      format: "svg",
      scope: "project",
      output: outputPath,
      highResolution: false,
    });

    const svg = await readFile(outputPath, "utf-8");
    expect(svg).toContain("CLI Export Project");
    expect(svg).toContain("Tree");
    expect(svg).toContain("Gantt");
    expect(svg).toContain("SVG/PNGエクスポート");
  });

  it("PNG 形式では SVG から PNG への変換に 2x 指定を渡す", async () => {
    const root = await writeProject();
    const outputPath = join(root, "out.png");
    const pngRenderer = vi.fn<PngRenderer>().mockResolvedValue(Buffer.from("png"));

    await runExportCommand(
      root,
      {
        format: "png",
        scope: "project",
        output: outputPath,
        highResolution: true,
      },
      { pngRenderer },
    );

    expect(pngRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        scaleFactor: 2,
        svg: expect.stringContaining("SVG/PNGエクスポート"),
      }),
    );
    await expect(readFile(outputPath)).resolves.toEqual(Buffer.from("png"));
  });

  it("PNG export の Playwright は CLI の runtime dependency として宣言する", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect(packageJson.dependencies?.playwright).toBeDefined();
    expect(packageJson.devDependencies?.playwright).toBeUndefined();
  });

  it("CLI では UI の表示中ビューを持たないため current scope を拒否する", async () => {
    const root = await writeProject();

    await expect(
      runExportCommand(root, {
        format: "svg",
        scope: "current",
        output: join(root, "out.svg"),
        highResolution: false,
      }),
    ).rejects.toThrow("--scope current");
  });
});
