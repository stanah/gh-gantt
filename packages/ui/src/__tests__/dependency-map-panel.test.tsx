// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { buildProjectMapViewModel, buildDependencySubgraph } from "@gh-gantt/shared";
import { DependencyMapPanel } from "../components/project-map/DependencyMapPanel.js";
import {
  computeInitialViewport,
  layoutDependencyGraph,
} from "../components/project-map/dependency-map-layout.js";
import type { Config, Task } from "../types/index.js";

const baseTask = (overrides: Partial<Task>): Task => ({
  id: "T",
  type: "task",
  github_issue: 1,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "task",
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
  ...overrides,
});

const config: Config = {
  version: "1",
  project: { name: "P", github: { owner: "stanah", repo: "gh-gantt", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status", priority: "Priority" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#27ae60", github_label: null },
  },
  type_hierarchy: { task: [] },
  statuses: {
    field_name: "Status",
    values: {
      Todo: { color: "#3498DB", done: false, category: "todo" },
      Done: { color: "#2ECC71", done: true, category: "done" },
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

/** up (Done) → sel (Todo) → down (Todo)。sel → down は未解決の依存になる。 */
function chainTasks(): Task[] {
  return [
    baseTask({
      id: "up",
      title: "Upstream Task",
      custom_fields: { Status: "Done" },
      start_date: "2026-01-05",
      end_date: "2026-01-06",
    }),
    baseTask({
      id: "sel",
      title: "Selected Task",
      custom_fields: { Status: "Todo" },
      start_date: "2026-01-07",
      end_date: "2026-01-08",
      blocked_by: [{ task: "up", type: "finish-to-start", lag: 0 }],
    }),
    baseTask({
      id: "down",
      title: "Downstream Task",
      custom_fields: { Status: "Todo" },
      start_date: "2026-01-09",
      end_date: "2026-01-10",
      blocked_by: [{ task: "sel", type: "finish-to-start", lag: 0 }],
    }),
  ];
}

afterEach(() => cleanup());

async function renderPanel(
  tasks: Task[],
  selectedTaskId: string | null,
  overrides: Partial<{ warnings: string[]; criticalEdgeKeys: string[] }> = {},
) {
  const vm = buildProjectMapViewModel(tasks, config);
  const onSelectTask = vi.fn();
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <div style={{ width: 600, height: 400 }}>
        <DependencyMapPanel
          tasks={tasks}
          readinessById={vm.readinessById}
          config={config}
          criticalEdgeKeys={overrides.criticalEdgeKeys ?? vm.criticalPath.criticalEdgeKeys}
          warnings={overrides.warnings ?? vm.warnings}
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
      </div>,
    );
  });
  return { ...result, onSelectTask, vm };
}

const translate = (el: Element) => {
  const m = (el as HTMLElement).style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: Number.NaN, y: Number.NaN };
};

describe("[FR-VIS-027-AC1] 依存サブグラフのノード座標とエッジ経路が dagre の横向き階層レイアウト (上流が左、下流が右) から得られる", () => {
  it("React Flow のキャンバス上に上流 → 選択 → 下流の順でノードが横に並ぶ", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    expect(container.querySelector(".react-flow")).not.toBeNull();
    const up = container.querySelector('.react-flow__node[data-id="up"]')!;
    const sel = container.querySelector('.react-flow__node[data-id="sel"]')!;
    const down = container.querySelector('.react-flow__node[data-id="down"]')!;
    expect(up).not.toBeNull();
    expect(translate(up).x).toBeLessThan(translate(sel).x);
    expect(translate(sel).x).toBeLessThan(translate(down).x);
    // 1 本の鎖なので同じ行に並ぶ
    expect(translate(up).y).toBeCloseTo(translate(sel).y, 3);
  });

  it("エッジが dagre の経路点からなるパスとして描画される", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    const path = container.querySelector('path[data-edge="up->sel"]');
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")).toMatch(/^M/);
    expect(container.querySelector('path[data-edge="sel->down"]')).not.toBeNull();
  });

  it("依存を持つタスクがなければ空状態を表示する", async () => {
    const { container } = await renderPanel([baseTask({ id: "solo", title: "Solo" })], null);
    expect(container.textContent).toContain("依存関係のあるタスクがありません");
    expect(container.querySelector(".react-flow")).toBeNull();
  });
});

describe("[FR-VIS-027-AC3] Dependency Map のノードをクリックまたは Enter / Space で選択すると詳細パネル連携の選択が更新される", () => {
  it("クリックで onSelectTask が呼ばれる", async () => {
    const { container, onSelectTask } = await renderPanel(chainTasks(), "sel");
    fireEvent.click(container.querySelector('[data-node="down"]')!);
    expect(onSelectTask).toHaveBeenCalledWith("down");
  });

  it("Enter / Space で onSelectTask が呼ばれ、他のキーでは呼ばれない", async () => {
    const { container, onSelectTask } = await renderPanel(chainTasks(), "sel");
    const node = container.querySelector('[data-node="up"]')!;
    fireEvent.keyDown(node, { key: "Enter" });
    fireEvent.keyDown(node, { key: " " });
    fireEvent.keyDown(node, { key: "a" });
    expect(onSelectTask).toHaveBeenCalledTimes(2);
    expect(onSelectTask).toHaveBeenNthCalledWith(1, "up");
    expect(onSelectTask).toHaveBeenNthCalledWith(2, "up");
  });

  it("ノードは role=button / aria-label / aria-pressed を持ち、選択中のみ pressed になる", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    const sel = container.querySelector('[data-node="sel"]')!;
    const up = container.querySelector('[data-node="up"]')!;
    expect(sel.getAttribute("role")).toBe("button");
    expect(sel.getAttribute("tabindex")).toBe("0");
    expect(sel.getAttribute("aria-label")).toBe("Selected Task");
    expect(sel.getAttribute("aria-pressed")).toBe("true");
    expect(up.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("[FR-VIS-027-AC4] クリティカルパスの強調、未解決依存の赤表示、循環依存の警告が Dependency Map に表示される", () => {
  it("未解決の依存エッジは danger トークンの破線で描画される", async () => {
    const { container } = await renderPanel(chainTasks(), "sel", { criticalEdgeKeys: [] });
    const unresolved = container.querySelector('path[data-edge="sel->down"]')!;
    expect(unresolved.getAttribute("stroke")).toContain("--color-danger");
    expect(unresolved.getAttribute("stroke-dasharray")).not.toBeNull();
    const resolved = container.querySelector('path[data-edge="up->sel"]')!;
    expect(resolved.getAttribute("stroke")).toContain("--color-border");
    expect(resolved.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("クリティカルパス上の解決済みエッジは critical_path 色の太線で描画される", async () => {
    const { container } = await renderPanel(chainTasks(), "sel", {
      criticalEdgeKeys: ["up->sel"],
    });
    const critical = container.querySelector('path[data-edge="up->sel"]')!;
    expect(critical.getAttribute("stroke")).toBe(config.gantt.colors.critical_path);
    expect(Number(critical.getAttribute("stroke-width"))).toBeGreaterThan(1);
    expect(critical.getAttribute("data-critical")).toBe("true");
  });

  it("循環依存の警告が role=alert で表示される", async () => {
    const { container } = await renderPanel(chainTasks(), "sel", {
      warnings: ["循環依存: a -> b -> a"],
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("循環依存");
  });
});

describe("[FR-VIS-027-AC5] Dependency Map をパン・ズームでき、初期表示で選択タスクが表示領域内に収まる", () => {
  it("ズームコントロールとドラッグ可能なパンが提供される", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    expect(container.querySelector('button[aria-label="zoom in"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="zoom out"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="fit view"]')).not.toBeNull();
    expect(container.querySelector(".react-flow__pane.draggable")).not.toBeNull();
  });

  it("初期ビューポートが computeInitialViewport の結果でキャンバスに適用される", async () => {
    const tasks = chainTasks();
    const { container, vm } = await renderPanel(tasks, "sel");
    // setup.ts の offsetWidth / offsetHeight 固定値により、jsdom では表示領域が 150 x 30 として計測される
    const size = { width: 150, height: 30 };
    const layout = layoutDependencyGraph(
      buildDependencySubgraph("sel", tasks, config, new Set(vm.criticalPath.criticalEdgeKeys)),
    );
    const expected = computeInitialViewport(layout, "sel", size);
    const viewport = container.querySelector(".react-flow__viewport") as HTMLElement;
    const m = viewport.style.transform.match(
      /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([\d.]+)\)/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(expected.x, 3);
    expect(Number(m![2])).toBeCloseTo(expected.y, 3);
    expect(Number(m![3])).toBeCloseTo(expected.zoom, 3);
    expect(viewport.style.transform).not.toBe("translate(0px,0px) scale(1)");
  });

  it("ノードはドラッグや接続の対象にならない (閲覧専用)", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    const node = container.querySelector('.react-flow__node[data-id="sel"]')!;
    expect(node.classList.contains("draggable")).toBe(false);
    expect(container.querySelector(".react-flow__handle.connectable")).toBeNull();
  });
});

describe("[FR-VIS-027-AC7] Dependency Map が横向き (LR) 配置で、ノードのハンドルが左右の辺にありエッジの始点 / 終点が左右の辺になる", () => {
  it("target ハンドルは左辺、source ハンドルは右辺に置かれる", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    const node = container.querySelector('.react-flow__node[data-id="sel"]')!;
    const target = node.querySelector(".react-flow__handle.target")!;
    const source = node.querySelector(".react-flow__handle.source")!;
    expect(target.classList.contains("react-flow__handle-left")).toBe(true);
    expect(source.classList.contains("react-flow__handle-right")).toBe(true);
    expect(node.querySelector(".react-flow__handle-top")).toBeNull();
    expect(node.querySelector(".react-flow__handle-bottom")).toBeNull();
  });

  it("エッジのパスは from ノードの右辺から始まり to ノードの左辺で終わる", async () => {
    const tasks = chainTasks();
    const { container, vm } = await renderPanel(tasks, "sel");
    const layout = layoutDependencyGraph(
      buildDependencySubgraph("sel", tasks, config, new Set(vm.criticalPath.criticalEdgeKeys)),
    );
    const up = layout.nodes.find((n) => n.id === "up")!;
    const sel = layout.nodes.find((n) => n.id === "sel")!;
    const d = container.querySelector('path[data-edge="up->sel"]')!.getAttribute("d")!;
    const start = d.match(/^M([-\d.]+) ([-\d.]+)/)!;
    const end = d.match(/L([-\d.]+) ([-\d.]+)$/)!;
    expect(Number(start[1])).toBeCloseTo(up.x + up.width, 3);
    expect(Number(start[2])).toBeCloseTo(up.y + up.height / 2, 3);
    expect(Number(end[1])).toBeCloseTo(sel.x, 3);
    expect(Number(end[2])).toBeCloseTo(sel.y + sel.height / 2, 3);
  });
});

describe("[FR-VIS-027-AC6] Dependency Map がライト / ダーク両テーマで既存の色トークンに沿って配色される", () => {
  it("ノードの背景・文字・選択枠が既存の CSS 変数を参照する", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    const sel = container.querySelector('[data-node="sel"]') as HTMLElement;
    const up = container.querySelector('[data-node="up"]') as HTMLElement;
    expect(sel.style.background).toContain("var(--color-surface");
    expect(sel.style.color).toContain("var(--color-text");
    expect(sel.style.borderColor).toContain("var(--color-selected-fg");
    expect(up.style.borderColor).not.toContain("var(--color-selected-fg");
  });

  it("React Flow のテーマ変数 (--xy-*) が既存トークンに束ねられる", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    const wrapper = container.querySelector("[data-testid='dependency-map-canvas']") as HTMLElement;
    const style = wrapper.getAttribute("style") ?? "";
    expect(style).toContain("--xy-background-color");
    expect(style).toContain("var(--color-surface");
    expect(style).toContain("--xy-controls-button-background-color");
  });
});

describe("[FR-VIS-027-AC9] Dependency Map のノードに担当者アバターが GitHub の決定的 URL から表示され、超過分は +N、取得失敗時はイニシャル、担当者なしは空領域を作らない", () => {
  it("担当者の login ごとに https://github.com/<login>.png?size=40 の画像を表示し、title で login が分かる", async () => {
    const tasks = chainTasks();
    tasks[1].assignees = ["alice", "bob"];
    const { container } = await renderPanel(tasks, "sel");
    const node = container.querySelector('[data-node="sel"]')!;
    const imgs = node.querySelectorAll("img[data-avatar]");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute("src")).toBe("https://github.com/alice.png?size=40");
    expect(imgs[0].getAttribute("title")).toBe("alice");
    expect(imgs[1].getAttribute("src")).toBe("https://github.com/bob.png?size=40");
    const group = node.querySelector("[data-assignees]")!;
    expect(group.getAttribute("aria-label")).toBe("担当: alice, bob");
    expect(group.getAttribute("title")).toBe("alice, bob");
  });

  it("3 人以上の担当者は 2 人までを画像で表示し、残りを +N で示す", async () => {
    const tasks = chainTasks();
    tasks[1].assignees = ["alice", "bob", "carol", "dave"];
    const { container } = await renderPanel(tasks, "sel");
    const node = container.querySelector('[data-node="sel"]')!;
    expect(node.querySelectorAll("img[data-avatar]")).toHaveLength(2);
    const overflow = node.querySelector("[data-avatar-overflow]")!;
    expect(overflow.getAttribute("data-avatar-overflow")).toBe("2");
    expect(overflow.textContent).toBe("+2");
    expect(overflow.getAttribute("title")).toBe("carol, dave");
  });

  it("画像の取得に失敗した担当者は同じ寸法のイニシャルのプレースホルダに置き換わる", async () => {
    const tasks = chainTasks();
    tasks[1].assignees = ["alice"];
    const { container } = await renderPanel(tasks, "sel");
    const node = container.querySelector('[data-node="sel"]')!;
    const img = node.querySelector('img[data-avatar="alice"]') as HTMLImageElement;
    await act(async () => {
      fireEvent.error(img);
    });
    expect(node.querySelector('img[data-avatar="alice"]')).toBeNull();
    const fallback = node.querySelector('[data-avatar="alice"][data-avatar-fallback="true"]')!;
    expect(fallback).not.toBeNull();
    expect(fallback.textContent).toBe("AL");
    expect(fallback.getAttribute("title")).toBe("alice");
    expect((fallback as HTMLElement).style.width).toBe(`${img.getAttribute("width")}px`);
    expect((fallback as HTMLElement).style.height).toBe(`${img.getAttribute("height")}px`);
  });

  it("担当者がいないノードにはアバター領域を描画しない", async () => {
    const { container } = await renderPanel(chainTasks(), "sel");
    const node = container.querySelector('[data-node="up"]')!;
    expect(node.querySelector("[data-assignees]")).toBeNull();
    expect(node.querySelector("img")).toBeNull();
  });
});
