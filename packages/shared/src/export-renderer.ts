import type { Config, Task, ViewScale } from "./types.js";

/** ガントビューのエクスポート形式。 */
export type GanttExportFormat = "svg" | "png";

/** エクスポート対象の範囲。 */
export type GanttExportScope = "current" | "project";

/** エクスポート対象タスクとツリー上の階層深度。 */
export interface GanttExportTaskNode {
  /** 描画対象のタスク。 */
  task: Task;
  /** ツリー上の深度。ルートタスクは 0。 */
  depth: number;
}

/** SVG エクスポートのレンダリング入力。 */
export interface RenderGanttExportSvgOptions {
  /** 描画順に並べたタスクノード。 */
  nodes: GanttExportTaskNode[];
  /** 色・タスク種別・プロジェクト名を解決する設定。 */
  config: Config;
  /** SVG に記録するエクスポート範囲。 */
  scope: GanttExportScope;
  /** ガント列の日幅を決める表示スケール。 */
  viewScale?: ViewScale;
  /** メタ情報に記録する生成日時。 */
  generatedAt?: Date;
}

/** SVG エクスポートのレンダリング結果。 */
export interface RenderedGanttExport {
  /** 生成された SVG 文字列。 */
  svg: string;
  /** SVG の幅。 */
  width: number;
  /** SVG の高さ。 */
  height: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ROW_HEIGHT = 32;
const TITLE_HEIGHT = 44;
const HEADER_HEIGHT = 34;
const FOOTER_HEIGHT = 22;
const OUTER_PADDING = 18;
const TREE_WIDTH = 340;
const MIN_GANTT_WIDTH = 560;

function taskIssueLabel(task: Task): string {
  return task.github_issue ? `#${task.github_issue}` : task.id;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function diffDays(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function dateRangeForTask(task: Task): { start: Date; end: Date } | null {
  const start = parseDate(task.start_date ?? task.date ?? task.end_date);
  const end = parseDate(task.end_date ?? task.date ?? task.start_date);
  if (!start || !end) return null;
  return start.getTime() <= end.getTime() ? { start, end } : { start: end, end: start };
}

function taskSortKey(task: Task): string {
  return [
    task.start_date ?? task.date ?? task.end_date ?? "9999-99-99",
    String(task.github_issue ?? Number.MAX_SAFE_INTEGER).padStart(10, "0"),
    task.title,
  ].join("|");
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => taskSortKey(a).localeCompare(taskSortKey(b)));
}

function childrenForTask(task: Task, byParent: Map<string, Task[]>): Task[] {
  const children = byParent.get(task.id) ?? [];
  if (task.sub_tasks.length === 0) return sortTasks(children);

  const byId = new Map(children.map((child) => [child.id, child]));
  const ordered = task.sub_tasks.flatMap((childId) => {
    const child = byId.get(childId);
    return child ? [child] : [];
  });
  const orderedIds = new Set(ordered.map((child) => child.id));
  const rest = sortTasks(children.filter((child) => !orderedIds.has(child.id)));
  return [...ordered, ...rest];
}

/**
 * タスクリストを親子階層順のエクスポートノード列へ変換する。
 *
 * @param tasks エクスポート対象のタスク配列。
 * @returns 親子関係と深度を保持したタスクノード列。
 */
export function buildExportTaskNodes(tasks: Task[]): GanttExportTaskNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byParent = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parent || !byId.has(task.parent)) continue;
    const children = byParent.get(task.parent) ?? [];
    children.push(task);
    byParent.set(task.parent, children);
  }

  const roots = sortTasks(tasks.filter((task) => !task.parent || !byId.has(task.parent)));
  const visited = new Set<string>();
  const nodes: GanttExportTaskNode[] = [];

  const visit = (task: Task, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    nodes.push({ task, depth });
    for (const child of childrenForTask(task, byParent)) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }
  for (const task of sortTasks(tasks)) {
    visit(task, 0);
  }

  return nodes;
}

function viewScaleDayWidth(viewScale: ViewScale | undefined): number {
  switch (viewScale) {
    case "week":
      return 28;
    case "quarter":
      return 7;
    case "year":
      return 4;
    case "month":
    default:
      return 14;
  }
}

function resolveDateRange(
  nodes: GanttExportTaskNode[],
  generatedAt: Date,
): { start: Date; end: Date } {
  const ranges = nodes.flatMap((node) => {
    const range = dateRangeForTask(node.task);
    return range ? [range] : [];
  });
  if (ranges.length === 0) {
    const today = new Date(
      Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth(), generatedAt.getUTCDate()),
    );
    return { start: today, end: addDays(today, 7) };
  }

  const start = new Date(Math.min(...ranges.map((range) => range.start.getTime())));
  const end = new Date(Math.max(...ranges.map((range) => range.end.getTime())));
  return { start: addDays(start, -1), end: addDays(end, 1) };
}

function statusDone(task: Task, config: Config): boolean {
  if (task.state === "closed") return true;
  const statusFieldName = config.statuses.field_name;
  const statusName = task.custom_fields[statusFieldName];
  if (typeof statusName !== "string") return false;
  return config.statuses.values[statusName]?.done ?? false;
}

function taskColor(task: Task, config: Config): string {
  const taskType = config.task_types[task.type];
  if (statusDone(task, config)) return "#95A5A6";
  return taskType?.color ?? config.gantt.colors.on_track;
}

function renderHeader(
  projectName: string,
  scope: GanttExportScope,
  generatedAt: Date,
  width: number,
): string {
  return [
    `<text x="${OUTER_PADDING}" y="24" class="title">${escapeXml(projectName)}</text>`,
    `<text x="${width - OUTER_PADDING}" y="24" text-anchor="end" class="meta">${escapeXml(scope)} export · ${escapeXml(generatedAt.toISOString())}</text>`,
  ].join("");
}

function renderGrid(
  chartX: number,
  chartY: number,
  chartWidth: number,
  chartHeight: number,
  startDate: Date,
  endDate: Date,
  dayWidth: number,
): string {
  const days = Math.max(1, diffDays(startDate, endDate) + 1);
  const lines: string[] = [];
  for (let day = 0; day < days; day += 1) {
    const x = chartX + day * dayWidth;
    const date = addDays(startDate, day);
    const major = date.getUTCDate() === 1 || day === 0 || day === days - 1;
    lines.push(
      `<line x1="${x}" y1="${chartY}" x2="${x}" y2="${chartY + chartHeight}" class="${major ? "grid-major" : "grid"}" />`,
    );
    if (major) {
      lines.push(
        `<text x="${x + 4}" y="${chartY - 9}" class="date-label">${escapeXml(formatDate(date))}</text>`,
      );
    }
  }
  lines.push(
    `<line x1="${chartX + chartWidth}" y1="${chartY}" x2="${chartX + chartWidth}" y2="${chartY + chartHeight}" class="grid-major" />`,
  );
  return lines.join("");
}

function renderTaskRow(
  node: GanttExportTaskNode,
  rowIndex: number,
  chartX: number,
  treeX: number,
  rowY: number,
  startDate: Date,
  dayWidth: number,
  config: Config,
): string {
  const { task, depth } = node;
  const range = dateRangeForTask(task);
  const y = rowY + rowIndex * ROW_HEIGHT;
  const centerY = y + ROW_HEIGHT / 2;
  const issueLabel = taskIssueLabel(task);
  const color = taskColor(task, config);
  const opacity = statusDone(task, config) ? 0.55 : 1;
  const taskType = config.task_types[task.type];
  const treeLabelX = treeX + 8 + depth * 16;
  const title = `${task.title}, ${range ? `${formatDate(range.start)} to ${formatDate(range.end)}` : "unscheduled"}`;
  const elements = [
    `<rect x="${treeX}" y="${y}" width="${TREE_WIDTH}" height="${ROW_HEIGHT}" class="row-bg" />`,
    `<text x="${treeLabelX}" y="${centerY + 4}" class="issue">${escapeXml(issueLabel)}</text>`,
    `<text x="${treeLabelX + 52}" y="${centerY + 4}" class="task-title">${escapeXml(task.title)}</text>`,
  ];

  if (!range) {
    elements.push(
      `<text x="${chartX + 8}" y="${centerY + 4}" class="unscheduled">No schedule</text>`,
    );
    return elements.join("");
  }

  const barX = chartX + diffDays(startDate, range.start) * dayWidth;
  const durationDays = Math.max(1, diffDays(range.start, range.end) + 1);
  const barWidth = Math.max(10, durationDays * dayWidth);
  const barY = centerY - 7;

  if (taskType?.display === "milestone") {
    const size = 14;
    elements.push(
      `<polygon points="${barX + size / 2},${barY} ${barX + size},${barY + size / 2} ${barX + size / 2},${barY + size} ${barX},${barY + size / 2}" fill="${escapeXml(color)}" opacity="${opacity}"><title>${escapeXml(title)}</title></polygon>`,
    );
  } else {
    const rx = taskType?.display === "summary" ? 2 : 4;
    elements.push(
      `<rect x="${barX}" y="${barY}" width="${barWidth}" height="14" rx="${rx}" fill="${escapeXml(color)}" opacity="${opacity}"><title>${escapeXml(title)}</title></rect>`,
    );
    if (taskType?.display === "summary") {
      elements.push(
        `<rect x="${barX}" y="${barY - 3}" width="6" height="20" fill="${escapeXml(color)}" opacity="${opacity}" />`,
        `<rect x="${barX + barWidth - 6}" y="${barY - 3}" width="6" height="20" fill="${escapeXml(color)}" opacity="${opacity}" />`,
      );
    }
  }
  elements.push(
    `<text x="${barX + barWidth + 6}" y="${centerY + 4}" class="bar-label">${escapeXml(task.title)}</text>`,
  );
  return elements.join("");
}

/**
 * タスクツリー列とガント列を 1 つの SVG として描画する。
 *
 * @param options エクスポート対象ノード、設定、範囲、表示スケール。
 * @returns SVG 文字列と画像寸法。
 */
export function renderGanttExportSvg({
  nodes,
  config,
  scope,
  viewScale = config.gantt.default_view,
  generatedAt = new Date(),
}: RenderGanttExportSvgOptions): RenderedGanttExport {
  const { start, end } = resolveDateRange(nodes, generatedAt);
  const dayWidth = viewScaleDayWidth(viewScale);
  const days = Math.max(1, diffDays(start, end) + 1);
  const chartWidth = Math.max(MIN_GANTT_WIDTH, days * dayWidth);
  const width = OUTER_PADDING * 2 + TREE_WIDTH + chartWidth;
  const rowCount = Math.max(1, nodes.length);
  const chartHeight = HEADER_HEIGHT + rowCount * ROW_HEIGHT;
  const height = OUTER_PADDING + TITLE_HEIGHT + chartHeight + FOOTER_HEIGHT;
  const treeX = OUTER_PADDING;
  const chartX = OUTER_PADDING + TREE_WIDTH;
  const headerY = OUTER_PADDING + TITLE_HEIGHT;
  const rowY = headerY + HEADER_HEIGHT;

  const rows =
    nodes.length === 0
      ? `<text x="${treeX + 8}" y="${rowY + 20}" class="unscheduled">No tasks</text>`
      : nodes
          .map((node, index) =>
            renderTaskRow(node, index, chartX, treeX, rowY, start, dayWidth, config),
          )
          .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" data-export-format="svg" data-export-scope="${scope}">
  <style>
    .title { font: 700 18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #111827; }
    .meta, .date-label, .bar-label, .unscheduled { font: 10px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #6B7280; }
    .column-label { font: 700 11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #374151; letter-spacing: 0; }
    .issue { font: 700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #4B5563; }
    .task-title { font: 11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #111827; }
    .row-bg { fill: #FFFFFF; stroke: #E5E7EB; stroke-width: 1; }
    .panel { fill: #F9FAFB; stroke: #D1D5DB; stroke-width: 1; }
    .grid { stroke: #EEF2F7; stroke-width: 1; }
    .grid-major { stroke: #D1D5DB; stroke-width: 1; }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF" />
  ${renderHeader(config.project.name, scope, generatedAt, width)}
  <rect x="${treeX}" y="${headerY}" width="${TREE_WIDTH}" height="${chartHeight}" class="panel" />
  <rect x="${chartX}" y="${headerY}" width="${chartWidth}" height="${chartHeight}" class="panel" />
  <text x="${treeX + 8}" y="${headerY + 22}" class="column-label">Tree</text>
  <text x="${chartX + 8}" y="${headerY + 22}" class="column-label">Gantt</text>
  ${renderGrid(chartX, rowY, chartWidth, rowCount * ROW_HEIGHT, start, end, dayWidth)}
  ${rows}
  <text x="${OUTER_PADDING}" y="${height - 8}" class="meta">${escapeXml(formatDate(start))} - ${escapeXml(formatDate(end))} · ${nodes.length} tasks</text>
</svg>`;

  return { svg, width, height };
}
