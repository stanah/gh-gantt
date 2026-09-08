import { describe, it, expect } from "vitest";
import {
  PROJECT_MAP_PANEL_IDS,
  PROJECT_MAP_LAYOUT_PRESETS,
  ProjectMapLayoutSettingsSchema,
  applyProjectMapLayoutPreset,
  defaultProjectMapLayoutSettings,
  moveProjectMapPanel,
  packProjectMapPanels,
  parseProjectMapLayoutSettings,
  projectMapPanelColumnSpan,
  setProjectMapPanelSize,
  setProjectMapPanelVisible,
  visibleProjectMapPanels,
} from "../project-map-layout.js";

describe("[FR-VIS-028-AC1] 各パネルを個別に表示 / 非表示にでき、非表示パネルは描画されず残り領域が再配分される", () => {
  it("既定構成では 6 パネルすべてが可視である", () => {
    const settings = defaultProjectMapLayoutSettings();
    expect(settings.panels.map((p) => p.id)).toEqual([...PROJECT_MAP_PANEL_IDS]);
    expect(visibleProjectMapPanels(settings)).toHaveLength(6);
  });

  it("setProjectMapPanelVisible で指定パネルだけを非表示にできる", () => {
    const next = setProjectMapPanelVisible(defaultProjectMapLayoutSettings(), "board", false);
    expect(visibleProjectMapPanels(next).map((p) => p.id)).not.toContain("board");
    expect(visibleProjectMapPanels(next)).toHaveLength(5);
  });

  it("packProjectMapPanels は既定構成を 3 行（3 / 2+1 / 3）に詰め、空セルを残さない", () => {
    const packed = packProjectMapPanels(defaultProjectMapLayoutSettings(), 3);
    expect(packed.map((p) => `${p.id}:${p.span}`)).toEqual([
      "tree:1",
      "board:1",
      "dependency:1",
      "next:2",
      "timeline:1",
      "run:3",
    ]);
  });

  it("パネルを隠すと各行末尾のパネルが残り列まで広がり、行ごとの span 合計が列数になる", () => {
    const hidden = setProjectMapPanelVisible(defaultProjectMapLayoutSettings(), "board", false);
    const packed = packProjectMapPanels(hidden, 3);
    // tree(1) + dependency(1) の後に next(2) は収まらないので dependency が 2 に広がる
    expect(packed.map((p) => `${p.id}:${p.span}`)).toEqual([
      "tree:1",
      "dependency:2",
      "next:2",
      "timeline:1",
      "run:3",
    ]);
    // 最終行が丁度埋まる場合は広げない
    const tail = setProjectMapPanelVisible(hidden, "run", false);
    const packedTail = packProjectMapPanels(tail, 3);
    expect(packedTail.at(-1)).toEqual({ id: "timeline", span: 1 });
    // 最終行の末尾も列数まで広がる
    const onlyTree = packProjectMapPanels(
      { version: 1, panels: [{ id: "tree", visible: true, size: "standard" }] },
      3,
    );
    expect(onlyTree).toEqual([{ id: "tree", span: 3 }]);
  });

  it("1 カラムでは全パネルが span 1 になり、サイズ指定は列数で頭打ちになる", () => {
    const packed = packProjectMapPanels(defaultProjectMapLayoutSettings(), 1);
    expect(packed.every((p) => p.span === 1)).toBe(true);
    expect(packed).toHaveLength(6);
    // NaN や 0 以下の列数は 1 カラムとして扱う
    expect(packProjectMapPanels(defaultProjectMapLayoutSettings(), Number.NaN)).toEqual(packed);
    expect(packProjectMapPanels(defaultProjectMapLayoutSettings(), 0)).toEqual(packed);
  });
});

describe("[FR-VIS-028-AC2] パネルの並び順を上下移動で変更できる", () => {
  it("movePanel で up / down に 1 つずつ移動し、端では変化しない", () => {
    const base = defaultProjectMapLayoutSettings();
    const up = moveProjectMapPanel(base, "board", "up");
    expect(up.panels.map((p) => p.id).slice(0, 2)).toEqual(["board", "tree"]);
    const down = moveProjectMapPanel(base, "board", "down");
    expect(down.panels.map((p) => p.id).slice(0, 3)).toEqual(["tree", "dependency", "board"]);
    expect(moveProjectMapPanel(base, "tree", "up")).toEqual(base);
    expect(moveProjectMapPanel(base, "run", "down")).toEqual(base);
  });
});

describe("[FR-VIS-028-AC3] パネルごとに 標準 / 広い / 全幅 の表示サイズを選べる", () => {
  it("サイズは 3 カラム grid の column span に対応する", () => {
    expect(projectMapPanelColumnSpan("standard")).toBe(1);
    expect(projectMapPanelColumnSpan("wide")).toBe(2);
    expect(projectMapPanelColumnSpan("full")).toBe(3);
  });

  it("setProjectMapPanelSize で指定パネルのサイズだけが変わる", () => {
    const next = setProjectMapPanelSize(defaultProjectMapLayoutSettings(), "tree", "full");
    expect(next.panels.find((p) => p.id === "tree")?.size).toBe("full");
    expect(next.panels.find((p) => p.id === "board")?.size).toBe("standard");
  });
});

describe("[FR-VIS-028-AC4] パネル構成は Zod 検証付きで localStorage に保存され再訪時に復元され、不正データは既定構成にフォールバックする", () => {
  it("正しい設定はそのまま復元される", () => {
    const stored = setProjectMapPanelVisible(
      moveProjectMapPanel(defaultProjectMapLayoutSettings(), "run", "up"),
      "tree",
      false,
    );
    const parsed = parseProjectMapLayoutSettings(JSON.parse(JSON.stringify(stored)));
    expect(parsed).toEqual(stored);
    expect(ProjectMapLayoutSettingsSchema.safeParse(stored).success).toBe(true);
  });

  it("欠けたパネルは末尾に補完され、未知・重複パネルは除外される", () => {
    const parsed = parseProjectMapLayoutSettings({
      version: 1,
      panels: [
        { id: "run", visible: true, size: "full" },
        { id: "unknown", visible: true, size: "wide" },
        { id: "run", visible: false, size: "standard" },
      ],
    });
    expect(parsed.panels.map((p) => p.id)).toEqual([
      "run",
      "tree",
      "board",
      "dependency",
      "next",
      "timeline",
    ]);
    expect(parsed.panels[0]).toEqual({ id: "run", visible: true, size: "full" });
  });

  it("不正な JSON 構造や version 違いは既定構成にフォールバックする", () => {
    expect(parseProjectMapLayoutSettings(null)).toEqual(defaultProjectMapLayoutSettings());
    expect(parseProjectMapLayoutSettings("x")).toEqual(defaultProjectMapLayoutSettings());
    expect(parseProjectMapLayoutSettings({ version: 2, panels: [] })).toEqual(
      defaultProjectMapLayoutSettings(),
    );
    expect(
      parseProjectMapLayoutSettings({ version: 1, panels: [{ id: "tree", size: "huge" }] }),
    ).toEqual(defaultProjectMapLayoutSettings());
  });
});

describe("[FR-VIS-028-AC5] 既定構成に戻す操作と 標準 / 依存重視 / ボード重視 のプリセットを選べる", () => {
  it("3 種類のプリセットが定義され、standard は既定構成と一致する", () => {
    expect(PROJECT_MAP_LAYOUT_PRESETS.map((p) => p.id)).toEqual([
      "standard",
      "dependency",
      "board",
    ]);
    expect(applyProjectMapLayoutPreset("standard")).toEqual(defaultProjectMapLayoutSettings());
  });

  it("依存重視は Dependency Map を広く表示し、ボード重視は Project Board を広く表示する", () => {
    const dep = applyProjectMapLayoutPreset("dependency");
    expect(visibleProjectMapPanels(dep).map((p) => p.id)).toContain("dependency");
    expect(dep.panels.find((p) => p.id === "dependency")?.size).not.toBe("standard");
    expect(dep.panels.find((p) => p.id === "board")?.visible).toBe(false);

    const board = applyProjectMapLayoutPreset("board");
    expect(board.panels.find((p) => p.id === "board")?.size).not.toBe("standard");
    expect(board.panels.find((p) => p.id === "dependency")?.visible).toBe(false);
  });

  it("すべてのプリセットは 6 パネルを重複なく含み、スキーマ検証を通る", () => {
    for (const preset of PROJECT_MAP_LAYOUT_PRESETS) {
      const settings = applyProjectMapLayoutPreset(preset.id);
      expect(settings.panels.map((p) => p.id).sort()).toEqual([...PROJECT_MAP_PANEL_IDS].sort());
      expect(ProjectMapLayoutSettingsSchema.safeParse(settings).success).toBe(true);
    }
  });
});
