// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, fireEvent, cleanup, within, act } from "@testing-library/react";
import { buildProjectMapViewModel } from "@gh-gantt/shared";
import { ProjectMapPage } from "../components/project-map/ProjectMapPage.js";
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
    epic: { label: "Epic", display: "summary", color: "#8957e5", github_label: null },
    task: { label: "Task", display: "bar", color: "#27ae60", github_label: null },
  },
  type_hierarchy: { epic: ["task"], task: [] },
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

function sampleTasks(): Task[] {
  return [
    baseTask({ id: "epic", type: "epic", title: "Epic A", sub_tasks: ["t1", "t2"] }),
    baseTask({ id: "t1", parent: "epic", title: "ViewModel", custom_fields: { Status: "Done" } }),
    baseTask({
      id: "t2",
      parent: "epic",
      title: "UI Shell",
      custom_fields: { Status: "Todo" },
      blocked_by: [{ task: "t1", type: "finish-to-start", lag: 0 }],
    }),
  ];
}

afterEach(() => cleanup());

function renderPage(selectedTaskId: string | null, onSelectTask = vi.fn()) {
  const vm = buildProjectMapViewModel(sampleTasks(), config);
  const result = render(
    <ProjectMapPage
      viewModel={vm}
      config={config}
      selectedTaskId={selectedTaskId}
      onSelectTask={onSelectTask}
    />,
  );
  return { ...result, onSelectTask };
}

describe("[FR-VIS-024] Project Map ページ", () => {
  it("6 パネルのレイアウトと System Tree のタスクが描画される", () => {
    const { container, getByText } = renderPage(null);
    expect(container.querySelector('[data-testid="project-map-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-map-layout"]')).not.toBeNull();
    expect(getByText("Epic A")).toBeTruthy();
    expect(getByText("System Tree")).toBeTruthy();
    expect(getByText("Project Board")).toBeTruthy();
    expect(getByText("Dependency Map")).toBeTruthy();
    expect(getByText("Next Actions")).toBeTruthy();
    expect(getByText("Compact Gantt")).toBeTruthy();
    expect(getByText("Planned vs Actual")).toBeTruthy();
    expect(container.querySelector('[aria-label="Run Graph"]')).not.toBeNull();
  });

  it("依存解除済みでない t2 は Ready Now ではなく Blocked 列に出る（t1 完了済みなら Ready）", () => {
    // t1 は Done なので t2 の依存は解除済み → t2 は Ready Now 列
    const { container } = renderPage(null);
    const readyColumn = container.querySelector('[data-column="ready_now"]');
    expect(readyColumn?.textContent).toContain("UI Shell");
  });

  it("System Tree のノードクリックで onSelectTask が呼ばれる", () => {
    const { container, onSelectTask } = renderPage(null);
    const node = container.querySelector('[data-task-id="t2"]');
    expect(node).not.toBeNull();
    fireEvent.click(node!);
    expect(onSelectTask).toHaveBeenCalledWith("t2");
  });

  it("Next Actions に着手可能なタスクが推薦される", () => {
    const { container } = renderPage(null);
    const next = container.querySelector('[aria-label="Next Actions"]');
    expect(next?.textContent).toContain("UI Shell");
  });
});

describe("[FR-VIS-024] Project Map フィルタ (PM-08)", () => {
  it("検索でタスクが絞り込まれ、System Tree / Board に一貫適用される", () => {
    const { container } = renderPage(null);
    const board = container.querySelector('[aria-label="Project Board"]') as HTMLElement;
    const tree = container.querySelector('[aria-label="System Tree"]') as HTMLElement;
    expect(board.textContent).toContain("UI Shell");

    const search = container.querySelector(
      'input[aria-label="Project Map 検索"]',
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "ViewModel" } });

    // ViewModel に一致しない "UI Shell" は Board から消える
    expect(board.textContent).not.toContain("UI Shell");
    // 一致する ViewModel と、その祖先 Epic A は Tree に残る
    expect(tree.textContent).toContain("Epic A");
    expect(tree.textContent).toContain("ViewModel");
  });

  it("readiness フィルタ (Blocked) で該当列以外のタスクが除外される", () => {
    const { container } = renderPage(null);
    const filterGroup = container.querySelector('[aria-label="Readiness フィルタ"]') as HTMLElement;
    // t1=Done, t2=Ready。Blocked フィルタでは両方除外される
    fireEvent.click(within(filterGroup).getByText("Blocked"));
    const board = container.querySelector('[aria-label="Project Board"]') as HTMLElement;
    expect(board.textContent).not.toContain("UI Shell");
  });

  it("マッチ件数が表示される", () => {
    const { container } = renderPage(null);
    // 全 3 タスク
    expect(container.textContent).toContain("3/3 件");
  });
});

// ---------------------------------------------------------------------------
// フィルタの複数選択化と Dependency Map への適用 (#371)
// ---------------------------------------------------------------------------

function readinessGroup(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-label="Readiness フィルタ"]') as HTMLElement;
}

function typeGroup(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-label="タイプ フィルタ"]') as HTMLElement;
}

function boardText(container: HTMLElement): string {
  return (container.querySelector('[aria-label="Project Board"]') as HTMLElement).textContent ?? "";
}

/** Dependency Map は React Flow の初期化を伴うため act で描画を確定させる。 */
async function renderPageAsync(selectedTaskId: string | null) {
  let result!: ReturnType<typeof renderPage>;
  await act(async () => {
    result = renderPage(selectedTaskId);
  });
  return result;
}

describe("[FR-VIS-029-AC1] readiness チップを複数選択でき、任意の組み合わせで絞り込める（All で解除）", () => {
  it("Ready と Done を同時に選ぶと両方の列のタスクが残り、All で解除される", () => {
    const { container } = renderPage(null);
    const group = readinessGroup(container);
    // Ready は epic と t2 の 2 件。t1=Done は除外される
    fireEvent.click(within(group).getByText("Ready"));
    expect(boardText(container)).toContain("UI Shell");
    expect(boardText(container)).not.toContain("ViewModel");
    expect(container.textContent).toContain("2/3 件");

    // Done を追加選択 → t1=Done も残る
    fireEvent.click(within(group).getByText("Done"));
    expect(boardText(container)).toContain("UI Shell");
    expect(boardText(container)).toContain("ViewModel");
    expect(container.textContent).toContain("3/3 件");
    expect(within(group).getByText("Ready").getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByText("Done").getAttribute("aria-pressed")).toBe("true");

    // 同じチップを再クリックで選択解除 → Done のみ
    fireEvent.click(within(group).getByText("Ready"));
    expect(boardText(container)).not.toContain("UI Shell");
    expect(boardText(container)).toContain("ViewModel");
    expect(container.textContent).toContain("1/3 件");

    // All で解除
    fireEvent.click(within(group).getByText("All"));
    expect(container.textContent).toContain("3/3 件");
    expect(within(group).getByText("All").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("[FR-VIS-029-AC2] Done を除外 を 1 操作で切り替えられる", () => {
  it("Done を除外 で Done 列のタスクだけが消え、readiness の選択とは独立に効く", () => {
    const { container } = renderPage(null);
    const group = readinessGroup(container);
    fireEvent.click(within(group).getByText("Done を除外"));
    expect(boardText(container)).not.toContain("ViewModel");
    expect(boardText(container)).toContain("UI Shell");
    expect(container.textContent).toContain("2/3 件");
    expect(within(group).getByText("All").getAttribute("aria-pressed")).toBe("false");

    // Done チップを明示的に選ぶと除外は解除される
    fireEvent.click(within(group).getByText("Done"));
    expect(within(group).getByText("Done を除外").getAttribute("aria-pressed")).toBe("false");
    expect(boardText(container)).toContain("ViewModel");

    // 除外を再度有効にすると Done の選択は外れる
    fireEvent.click(within(group).getByText("Done を除外"));
    expect(within(group).getByText("Done").getAttribute("aria-pressed")).toBe("false");
    expect(boardText(container)).not.toContain("ViewModel");
  });
});

describe("[FR-VIS-029-AC3] タスクタイプで絞り込める（Gantt の TypeFilter とは独立した Project Map 内の状態）", () => {
  it("config.task_types のチップが並び、Epic を選ぶと Task 型が除外される", () => {
    const { container } = renderPage(null);
    const group = typeGroup(container);
    expect(group).not.toBeNull();
    fireEvent.click(within(group).getByText("Epic"));
    expect(boardText(container)).not.toContain("UI Shell");
    expect(container.textContent).toContain("1/3 件");
    const tree = container.querySelector('[aria-label="System Tree"]') as HTMLElement;
    expect(tree.textContent).toContain("Epic A");

    // Task を追加選択で複数タイプ
    fireEvent.click(within(group).getByText("Task"));
    expect(container.textContent).toContain("3/3 件");
    // All で解除
    fireEvent.click(within(group).getByText("All"));
    expect(within(group).getByText("Epic").getAttribute("aria-pressed")).toBe("false");
    expect(within(group).getByText("Task").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("3/3 件");
  });
});

describe("[FR-VIS-029-AC4] Dependency Map にフィルタが適用され、除外タスクはノードに出ず、除外ノードを経由する依存は途切れとして示される", () => {
  it("Done を除外 で t1 のノードが消え、t2 に除外された上流の省略記号が付く", async () => {
    const { container } = await renderPageAsync(null);
    expect(container.querySelector('.react-flow__node[data-id="t1"]')).not.toBeNull();
    expect(container.querySelector('.react-flow__node[data-id="t2"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(within(readinessGroup(container)).getByText("Done を除外"));
    });
    expect(container.querySelector('.react-flow__node[data-id="t1"]')).toBeNull();
    const t2 = container.querySelector('.react-flow__node[data-id="t2"]');
    expect(t2).not.toBeNull();
    expect(t2!.querySelector("[data-hidden-upstream]")?.getAttribute("data-hidden-upstream")).toBe(
      "1",
    );
    expect(container.querySelector('path[data-edge="t1->t2"]')).toBeNull();
    const dep = container.querySelector('[aria-label="Dependency Map"]') as HTMLElement;
    expect(dep.textContent).toContain("フィルタで 1 件非表示");
  });

  it("選択タスク中心の絞り込みとフィルタは同時に効く", async () => {
    const { container } = await renderPageAsync("t2");
    await act(async () => {
      fireEvent.click(within(readinessGroup(container)).getByText("Done を除外"));
    });
    expect(container.querySelector('.react-flow__node[data-id="t1"]')).toBeNull();
    expect(container.querySelector('.react-flow__node[data-id="t2"]')).not.toBeNull();
    const dep = container.querySelector('[aria-label="Dependency Map"]') as HTMLElement;
    expect(dep.textContent).toContain("選択の依存");
  });
});

describe("[FR-VIS-029-AC5] フィルタ状態が Tree / Board / Next Actions / Timeline / Dependency Map で一貫し、一致件数がフィルタ結果と一致する", () => {
  it("Done を除外 + 検索の組み合わせが全パネルに同じ集合で反映される", async () => {
    const { container } = await renderPageAsync(null);
    await act(async () => {
      fireEvent.click(within(readinessGroup(container)).getByText("Done を除外"));
    });
    const panel = (label: string) =>
      (container.querySelector(`[aria-label="${label}"]`) as HTMLElement).textContent ?? "";
    expect(panel("System Tree")).not.toContain("ViewModel");
    expect(panel("Project Board")).not.toContain("ViewModel");
    expect(panel("Next Actions")).not.toContain("ViewModel");
    expect(panel("Compact Gantt")).not.toContain("ViewModel");
    expect(container.querySelector('.react-flow__node[data-id="t1"]')).toBeNull();
    expect(container.textContent).toContain("2/3 件");

    // 検索を重ねると件数も一致する
    await act(async () => {
      fireEvent.change(container.querySelector('input[aria-label="Project Map 検索"]')!, {
        target: { value: "UI" },
      });
    });
    expect(panel("Project Board")).toContain("UI Shell");
    expect(container.textContent).toContain("1/3 件");
    expect(container.querySelector('.react-flow__node[data-id="t2"]')).not.toBeNull();
  });
});

describe("[FR-VIS-025] Project Map の Group by 軸セレクタ (GRP-02)", () => {
  it("Group by を type に切り替えると System Tree がグループ表示になる", () => {
    const { container } = renderPage(null);
    const tree = container.querySelector('[aria-label="System Tree"]') as HTMLElement;
    // 既定は階層表示
    expect(tree.textContent).toContain("構造を探索");

    const select = container.querySelector('select[aria-label="Group by 軸"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "type" } });

    // グループ表示に切り替わり、タイプ別グループ見出しが出る
    expect(tree.textContent).toContain("グループ表示");
    expect(tree.textContent).toContain("Epic");
    expect(tree.textContent).toContain("Task");
  });

  it("Group by セレクタに組み込み軸が並ぶ", () => {
    const { container } = renderPage(null);
    const select = container.querySelector('select[aria-label="Group by 軸"]') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("hierarchy");
    expect(values).toContain("type");
    expect(values).toContain("status");
  });

  it("Group by 時に Project Board がスイムレーン表示になる (GRP-03)", () => {
    const { container } = renderPage(null);
    const board = container.querySelector('[aria-label="Project Board"]') as HTMLElement;
    // 既定（hierarchy）はスイムレーンなし
    expect(board.querySelector("[data-lane]")).toBeNull();

    const select = container.querySelector('select[aria-label="Group by 軸"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "type" } });

    expect(board.textContent).toContain("スイムレーン");
    expect(board.querySelector("[data-lane]")).not.toBeNull();
    expect(board.textContent).toContain("UI Shell");
  });
});

// ---------------------------------------------------------------------------
// パネル構成のカスタマイズ (#362)
// ---------------------------------------------------------------------------

const LAYOUT_STORAGE_KEY = "gh-gantt:project-map-layout";

function panelIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-panel]")).map(
    (el) => (el as HTMLElement).dataset.panel ?? "",
  );
}

function openLayoutSettings(container: HTMLElement): HTMLElement {
  fireEvent.click(container.querySelector('button[aria-label="パネル設定"]') as HTMLElement);
  return container.querySelector('[data-testid="project-map-layout-settings"]') as HTMLElement;
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("[FR-VIS-028-AC1] 各パネルを個別に表示 / 非表示にでき、非表示パネルは描画されず残り領域が再配分される", () => {
  it("設定 UI は既定で閉じており、パネル設定ボタンで開閉する", () => {
    const { container } = renderPage(null);
    expect(container.querySelector('[data-testid="project-map-layout-settings"]')).toBeNull();
    const settings = openLayoutSettings(container);
    expect(settings).not.toBeNull();
    fireEvent.click(container.querySelector('button[aria-label="パネル設定"]') as HTMLElement);
    expect(container.querySelector('[data-testid="project-map-layout-settings"]')).toBeNull();
  });

  it("Project Board の表示チェックを外すとパネルが描画されなくなる", () => {
    const { container } = renderPage(null);
    expect(panelIds(container)).toHaveLength(6);
    const settings = openLayoutSettings(container);
    fireEvent.click(within(settings).getByLabelText("Project Board を表示"));
    expect(container.querySelector('[aria-label="Project Board"]')).toBeNull();
    expect(panelIds(container)).toEqual(["tree", "dependency", "next", "timeline", "run"]);
    // 再度チェックすると戻る
    fireEvent.click(within(settings).getByLabelText("Project Board を表示"));
    expect(container.querySelector('[aria-label="Project Board"]')).not.toBeNull();
  });

  it("隠したパネルの領域は同じ行の末尾パネルに再配分され、空セルが残らない", () => {
    const { container } = renderPage(null);
    const settings = openLayoutSettings(container);
    fireEvent.click(within(settings).getByLabelText("Project Board を表示"));
    const spans = Array.from(container.querySelectorAll("[data-panel]")).map(
      (el) => `${(el as HTMLElement).dataset.panel}:${(el as HTMLElement).style.gridColumn}`,
    );
    // tree(1)+dependency(1) の後に next(2) が入らないため dependency が行末まで広がる
    expect(spans).toEqual([
      "tree:span 1",
      "dependency:span 2",
      "next:span 2",
      "timeline:span 1",
      "run:span 3",
    ]);
  });
});

describe("[FR-VIS-028-AC2] パネルの並び順を上下移動で変更できる", () => {
  it("上へ / 下へ ボタンで描画順が入れ替わる", () => {
    const { container } = renderPage(null);
    const settings = openLayoutSettings(container);
    fireEvent.click(within(settings).getByLabelText("Project Board を上へ"));
    expect(panelIds(container).slice(0, 2)).toEqual(["board", "tree"]);
    fireEvent.click(within(settings).getByLabelText("Project Board を下へ"));
    expect(panelIds(container).slice(0, 2)).toEqual(["tree", "board"]);
  });

  it("先頭パネルの上へ / 末尾パネルの下へ は無効化される", () => {
    const { container } = renderPage(null);
    const settings = openLayoutSettings(container);
    expect(
      (within(settings).getByLabelText("System Tree を上へ") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(settings).getByLabelText("Planned vs Actual を下へ") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("[FR-VIS-028-AC3] パネルごとに 標準 / 広い / 全幅 の表示サイズを選べる", () => {
  it("サイズ選択が grid の column span に反映される", () => {
    const { container } = renderPage(null);
    const tree = container.querySelector('[data-panel="tree"]') as HTMLElement;
    expect(tree.style.gridColumn).toBe("span 1");
    const settings = openLayoutSettings(container);
    fireEvent.change(within(settings).getByLabelText("System Tree のサイズ"), {
      target: { value: "full" },
    });
    expect(tree.style.gridColumn).toBe("span 3");
    fireEvent.change(within(settings).getByLabelText("System Tree のサイズ"), {
      target: { value: "wide" },
    });
    expect(tree.style.gridColumn).toBe("span 2");
  });
});

describe("[FR-VIS-028-AC4] パネル構成は Zod 検証付きで localStorage に保存され再訪時に復元され、不正データは既定構成にフォールバックする", () => {
  it("保存済み設定で Run Graph を隠していれば初期描画から隠れる", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        panels: [
          { id: "run", visible: false, size: "full" },
          { id: "tree", visible: true, size: "standard" },
        ],
      }),
    );
    const { container } = renderPage(null);
    expect(container.querySelector('[aria-label="Run Graph"]')).toBeNull();
    expect(panelIds(container)).toEqual(["tree", "board", "dependency", "next", "timeline"]);
  });

  it("設定変更は localStorage に書き込まれる", () => {
    const { container } = renderPage(null);
    const settings = openLayoutSettings(container);
    fireEvent.click(within(settings).getByLabelText("Next Actions を表示"));
    const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    expect(stored.version).toBe(1);
    expect(stored.panels.find((p: { id: string }) => p.id === "next").visible).toBe(false);
  });

  it("壊れた JSON や不正な構造は既定構成にフォールバックする", () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, "{not json");
    const first = renderPage(null);
    expect(panelIds(first.container)).toHaveLength(6);
    cleanup();

    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ version: 1, panels: [{ id: "tree", visible: "yes", size: "huge" }] }),
    );
    const second = renderPage(null);
    expect(panelIds(second.container)).toHaveLength(6);
  });
});

describe("[FR-VIS-028-AC5] 既定構成に戻す操作と 標準 / 依存重視 / ボード重視 のプリセットを選べる", () => {
  it("プリセット選択で構成が切り替わり、既定に戻すで 6 パネルに戻る", () => {
    const { container } = renderPage(null);
    const settings = openLayoutSettings(container);
    const preset = within(settings).getByLabelText("レイアウトプリセット") as HTMLSelectElement;
    expect(Array.from(preset.options).map((o) => o.value)).toEqual(
      expect.arrayContaining(["standard", "dependency", "board"]),
    );

    fireEvent.change(preset, { target: { value: "dependency" } });
    expect(container.querySelector('[aria-label="Project Board"]')).toBeNull();
    expect(
      (container.querySelector('[data-panel="dependency"]') as HTMLElement).style.gridColumn,
    ).toBe("span 2");
    expect(preset.value).toBe("dependency");

    fireEvent.change(preset, { target: { value: "board" } });
    expect(container.querySelector('[aria-label="Dependency Map"]')).toBeNull();
    expect(container.querySelector('[aria-label="Project Board"]')).not.toBeNull();

    fireEvent.click(within(settings).getByText("既定に戻す"));
    expect(panelIds(container)).toEqual(["tree", "board", "dependency", "next", "timeline", "run"]);
    expect(preset.value).toBe("standard");
  });

  it("手動で変更するとプリセット選択はカスタムになる", () => {
    const { container } = renderPage(null);
    const settings = openLayoutSettings(container);
    fireEvent.click(within(settings).getByLabelText("Project Board を上へ"));
    const preset = within(settings).getByLabelText("レイアウトプリセット") as HTMLSelectElement;
    expect(preset.value).toBe("custom");
  });
});

describe("[FR-VIS-028-AC6] パネル構成の変更が選択連携・フィルタ・Group by・Run Graph の動作に影響しない", () => {
  it("Board を隠して並び替えた後も Tree の選択・検索・Group by が機能する", () => {
    const { container, onSelectTask } = renderPage(null);
    const settings = openLayoutSettings(container);
    fireEvent.click(within(settings).getByLabelText("Project Board を表示"));
    fireEvent.click(within(settings).getByLabelText("Next Actions を上へ"));

    // 選択連携
    fireEvent.click(container.querySelector('[data-task-id="t2"]') as HTMLElement);
    expect(onSelectTask).toHaveBeenCalledWith("t2");

    // フィルタ
    const search = container.querySelector(
      'input[aria-label="Project Map 検索"]',
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "ViewModel" } });
    const next = container.querySelector('[aria-label="Next Actions"]') as HTMLElement;
    expect(next.textContent).not.toContain("UI Shell");
    expect(container.textContent).toContain("1/3 件");

    // Group by
    fireEvent.change(container.querySelector('select[aria-label="Group by 軸"]') as HTMLElement, {
      target: { value: "type" },
    });
    const tree = container.querySelector('[aria-label="System Tree"]') as HTMLElement;
    expect(tree.textContent).toContain("グループ表示");

    // Run Graph パネルはそのまま残っている
    expect(container.querySelector('[aria-label="Run Graph"]')).not.toBeNull();
  });
});

describe("[FR-VIS-028-AC7] 画面幅が狭いときはパネルが 1 カラムに折り返される", () => {
  it("max-width 980px にマッチすると 1 カラムになり全パネルが span 1 になる", () => {
    stubMatchMedia(true);
    const { container } = renderPage(null);
    const layout = container.querySelector('[data-testid="project-map-layout"]') as HTMLElement;
    expect(layout.dataset.columns).toBe("1");
    const run = container.querySelector('[data-panel="run"]') as HTMLElement;
    expect(run.style.gridColumn).toBe("span 1");
  });

  it("広い画面では 3 カラムで、全幅パネルは span 3 になる", () => {
    stubMatchMedia(false);
    const { container } = renderPage(null);
    const layout = container.querySelector('[data-testid="project-map-layout"]') as HTMLElement;
    expect(layout.dataset.columns).toBe("3");
    const run = container.querySelector('[data-panel="run"]') as HTMLElement;
    expect(run.style.gridColumn).toBe("span 3");
  });
});
