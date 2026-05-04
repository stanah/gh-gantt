import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import {
  buildExportTaskNodes,
  renderGanttExportSvg,
  type GanttExportFormat,
  type GanttExportScope,
  type ViewScale,
} from "@gh-gantt/shared";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";

export interface PngRenderInput {
  svg: string;
  width: number;
  height: number;
  scaleFactor: 1 | 2;
}

export type PngRenderer = (input: PngRenderInput) => Promise<Buffer>;

interface ExportCommandOptions {
  format?: string;
  scope?: string;
  output?: string;
  highResolution?: boolean;
  scale?: string;
}

interface ExportCommandDeps {
  pngRenderer?: PngRenderer;
}

function normalizeFormat(value: string | undefined): GanttExportFormat {
  if (value === undefined) return "svg";
  if (value === "svg" || value === "png") return value;
  throw new Error("--format は svg または png を指定してください");
}

function normalizeScope(value: string | undefined): GanttExportScope {
  if (value === undefined) return "project";
  if (value === "project") return value;
  if (value === "current") {
    throw new Error(
      "--scope current は UI の表示中ビュー専用です。CLI では --scope project を指定してください",
    );
  }
  throw new Error("--scope は project を指定してください");
}

function normalizeScale(value: string | undefined, fallback: ViewScale): ViewScale {
  if (value === undefined) return fallback;
  if (value === "week" || value === "month" || value === "quarter" || value === "year") {
    return value;
  }
  throw new Error("--scale は week, month, quarter, year のいずれかを指定してください");
}

async function renderPngWithPlaywright({
  svg,
  width,
  height,
  scaleFactor,
}: PngRenderInput): Promise<Buffer> {
  let chromium: typeof import("@playwright/test").chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (err) {
    throw new Error(
      `PNG export requires @playwright/test. 依存関係をインストールしてから再実行してください: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: scaleFactor,
    });
    await page.setContent(`<html><body style="margin:0;background:white">${svg}</body></html>`, {
      waitUntil: "load",
    });
    return await page.locator("svg").screenshot({ type: "png" });
  } catch (err) {
    throw new Error(
      `PNG export に失敗しました。Playwright browser が利用可能か確認してください: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await browser?.close();
  }
}

export async function runExportCommand(
  projectRoot: string,
  options: ExportCommandOptions,
  deps: ExportCommandDeps = {},
): Promise<void> {
  const config = await new ConfigStore(projectRoot).read();
  const tasksFile = await new TasksStore(projectRoot).read();
  const format = normalizeFormat(options.format);
  const scope = normalizeScope(options.scope);
  const viewScale = normalizeScale(options.scale, config.gantt.default_view);
  const outputPath = resolve(projectRoot, options.output ?? `gh-gantt-export.${format}`);
  const rendered = renderGanttExportSvg({
    nodes: buildExportTaskNodes(tasksFile.tasks),
    config,
    scope,
    viewScale,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  if (format === "svg") {
    await writeFile(outputPath, rendered.svg);
  } else {
    const pngRenderer = deps.pngRenderer ?? renderPngWithPlaywright;
    const png = await pngRenderer({
      svg: rendered.svg,
      width: rendered.width,
      height: rendered.height,
      scaleFactor: options.highResolution ? 2 : 1,
    });
    await writeFile(outputPath, png);
  }

  console.log(`Exported ${format.toUpperCase()} to ${outputPath}`);
}

export function createExportCommand(): Command {
  return new Command("export")
    .description("Export the Gantt view as SVG or PNG")
    .option("-f, --format <format>", "Export format: svg or png", "svg")
    .option("--scope <scope>", "Export scope: project (current is UI-only)", "project")
    .option("-o, --output <path>", "Output file path")
    .option("--high-resolution", "Render PNG at 2x resolution")
    .option("--scale <scale>", "Gantt scale: week, month, quarter, year")
    .action(async (options: ExportCommandOptions) => {
      try {
        await runExportCommand(process.cwd(), options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

export const exportCommand = createExportCommand();
