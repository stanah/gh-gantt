import { describe, expect, it } from "vitest";
import { buildExportTaskNodes, renderGanttExportSvg, type Config, type Task } from "../index.js";

const config: Config = {
  version: "1",
  project: {
    name: "Export Project",
    github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
  },
  task_types: {
    epic: { label: "Epic", display: "summary", color: "#8E44AD", github_label: "epic" },
    task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
  },
  type_hierarchy: { epic: ["task"], task: [] },
  statuses: {
    field_name: "Status",
    values: {
      Todo: { color: "#3498DB", done: false },
      Done: { color: "#2ECC71", done: true },
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

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: Number(id.split("#")[1] ?? "0"),
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: id,
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
    ...overrides,
  };
}

describe("[FR-VIS-019] SVG/PNG エクスポート", () => {
  it("[FR-VIS-019-AC1] buildExportTaskNodes は親子階層を depth 付きで並べる", () => {
    const epic = makeTask("stanah/gh-gantt#30", {
      type: "epic",
      title: "可視化拡張",
      sub_tasks: ["stanah/gh-gantt#20"],
    });
    const task = makeTask("stanah/gh-gantt#20", {
      title: "SVG/PNGエクスポート",
      parent: "stanah/gh-gantt#30",
    });

    expect(buildExportTaskNodes([task, epic]).map((node) => [node.task.title, node.depth])).toEqual(
      [
        ["可視化拡張", 0],
        ["SVG/PNGエクスポート", 1],
      ],
    );
  });

  it("[FR-VIS-019-AC2] renderGanttExportSvg はツリー列とガント列を 1 つの SVG に含める", () => {
    const epic = makeTask("stanah/gh-gantt#30", {
      type: "epic",
      title: "可視化拡張",
      start_date: "2026-05-04",
      end_date: "2026-05-15",
      sub_tasks: ["stanah/gh-gantt#20"],
    });
    const task = makeTask("stanah/gh-gantt#20", {
      title: "SVG/PNGエクスポート",
      parent: "stanah/gh-gantt#30",
    });

    const result = renderGanttExportSvg({
      nodes: buildExportTaskNodes([epic, task]),
      config,
      scope: "project",
      viewScale: "month",
    });

    expect(result.svg).toContain('data-export-scope="project"');
    expect(result.svg).toContain("Export Project");
    expect(result.svg).toContain("Tree");
    expect(result.svg).toContain("Gantt");
    expect(result.svg).toContain("#20");
    expect(result.svg).toContain("SVG/PNGエクスポート");
    expect(result.width).toBeGreaterThan(800);
    expect(result.height).toBeGreaterThan(120);
  });

  it("[FR-VIS-019-AC3] current scope は渡された表示中ノードだけを SVG に含める", () => {
    const visible = makeTask("stanah/gh-gantt#20", { title: "表示中タスク" });
    const hidden = makeTask("stanah/gh-gantt#51", { title: "非表示タスク" });

    const result = renderGanttExportSvg({
      nodes: buildExportTaskNodes([visible]),
      config,
      scope: "current",
      viewScale: "week",
    });

    expect(result.svg).toContain('data-export-scope="current"');
    expect(result.svg).toContain("表示中タスク");
    expect(result.svg).not.toContain(hidden.title);
  });

  it("[FR-VIS-019-AC2] グリッドの日付ラベルは export 範囲の翌日を出力しない", () => {
    const task = makeTask("stanah/gh-gantt#20", {
      title: "単日タスク",
      start_date: "2026-05-04",
      end_date: "2026-05-04",
    });

    const result = renderGanttExportSvg({
      nodes: buildExportTaskNodes([task]),
      config,
      scope: "project",
      viewScale: "month",
    });

    expect(result.svg).toContain("2026-05-03");
    expect(result.svg).toContain("2026-05-05");
    expect(result.svg).not.toContain("2026-05-06");
  });
});
