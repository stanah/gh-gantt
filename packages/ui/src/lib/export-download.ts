import {
  buildExportTaskNodes,
  renderGanttExportSvg,
  type Config,
  type GanttExportScope,
  type GanttExportTaskNode,
  type Task,
  type ViewScale,
} from "@gh-gantt/shared";
import type { ExportRequest } from "../components/toolbar/ExportMenu.js";

interface DownloadGanttExportOptions {
  tasks: Task[];
  visibleNodes: GanttExportTaskNode[];
  config: Config;
  request: ExportRequest;
  viewScale: ViewScale;
}

function fileName(scope: GanttExportScope, format: "svg" | "png"): string {
  return `gh-gantt-${scope}.${format}`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function svgToPngBlob(
  svg: string,
  width: number,
  height: number,
  scaleFactor: 1 | 2,
): Promise<Blob> {
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("SVG の画像化に失敗しました"));
    });
    image.src = url;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = width * scaleFactor;
    canvas.height = height * scaleFactor;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas を初期化できません");
    }
    context.scale(scaleFactor, scaleFactor);
    context.drawImage(image, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG の生成に失敗しました"));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadGanttExport({
  tasks,
  visibleNodes,
  config,
  request,
  viewScale,
}: DownloadGanttExportOptions): Promise<void> {
  const nodes = request.scope === "project" ? buildExportTaskNodes(tasks) : visibleNodes;
  const rendered = renderGanttExportSvg({
    nodes,
    config,
    scope: request.scope,
    viewScale,
  });

  if (request.format === "svg") {
    downloadBlob(
      new Blob([rendered.svg], { type: "image/svg+xml;charset=utf-8" }),
      fileName(request.scope, "svg"),
    );
    return;
  }

  const pngBlob = await svgToPngBlob(
    rendered.svg,
    rendered.width,
    rendered.height,
    request.scaleFactor,
  );
  downloadBlob(pngBlob, fileName(request.scope, "png"));
}
