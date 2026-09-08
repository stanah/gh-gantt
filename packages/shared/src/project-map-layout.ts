import { z } from "zod";

/**
 * Project Map のパネル ID。表示順の既定は配列順。
 * `tree` = System Tree, `board` = Project Board, `dependency` = Dependency Map,
 * `next` = Next Actions, `timeline` = Compact Gantt, `run` = Planned vs Actual Run Graph。
 */
export const PROJECT_MAP_PANEL_IDS = [
  "tree",
  "board",
  "dependency",
  "next",
  "timeline",
  "run",
] as const;

export type ProjectMapPanelId = (typeof PROJECT_MAP_PANEL_IDS)[number];

/** パネルの表示サイズ。3 カラム grid に対する column span を表す。 */
export const PROJECT_MAP_PANEL_SIZES = ["standard", "wide", "full"] as const;

export type ProjectMapPanelSize = (typeof PROJECT_MAP_PANEL_SIZES)[number];

/** パネルの表示ラベル（UI 見出しと同じ英語表記）。 */
export const PROJECT_MAP_PANEL_LABELS: Record<ProjectMapPanelId, string> = {
  tree: "System Tree",
  board: "Project Board",
  dependency: "Dependency Map",
  next: "Next Actions",
  timeline: "Compact Gantt",
  run: "Planned vs Actual",
};

/** サイズの表示ラベル。 */
export const PROJECT_MAP_PANEL_SIZE_LABELS: Record<ProjectMapPanelSize, string> = {
  standard: "標準",
  wide: "広い",
  full: "全幅",
};

export interface ProjectMapPanelSetting {
  id: ProjectMapPanelId;
  visible: boolean;
  size: ProjectMapPanelSize;
}

export const ProjectMapPanelSettingSchema: z.ZodType<ProjectMapPanelSetting> = z.object({
  id: z.enum(PROJECT_MAP_PANEL_IDS),
  visible: z.boolean(),
  size: z.enum(PROJECT_MAP_PANEL_SIZES),
});

export const PROJECT_MAP_LAYOUT_VERSION = 1 as const;

/** localStorage に保存する Project Map レイアウト設定。`panels` の配列順が表示順。 */
export interface ProjectMapLayoutSettings {
  version: typeof PROJECT_MAP_LAYOUT_VERSION;
  panels: ProjectMapPanelSetting[];
}

/**
 * 設定全体の厳密スキーマ。書き込み値と正規化後の値の最終保証に使う。
 * 復元時は未知のパネル id を寛容に除外したいので、parseProjectMapLayoutSettings が
 * 要素単位で ProjectMapPanelSettingSchema を適用し、正規化後にこのスキーマを通す。
 */
export const ProjectMapLayoutSettingsSchema: z.ZodType<ProjectMapLayoutSettings> = z.object({
  version: z.literal(PROJECT_MAP_LAYOUT_VERSION),
  panels: z.array(ProjectMapPanelSettingSchema),
});

/** 3 カラム grid の列数。 */
export const PROJECT_MAP_GRID_COLUMNS: number = 3;

type PanelSpec = [ProjectMapPanelId, boolean, ProjectMapPanelSize];

function buildSettings(specs: readonly PanelSpec[]): ProjectMapLayoutSettings {
  return {
    version: PROJECT_MAP_LAYOUT_VERSION,
    panels: specs.map(([id, visible, size]) => ({ id, visible, size })),
  };
}

/** 既定構成: 上段 tree / board / dependency、中段 next(広い) / timeline、下段 run(全幅)。 */
const DEFAULT_SPECS: readonly PanelSpec[] = [
  ["tree", true, "standard"],
  ["board", true, "standard"],
  ["dependency", true, "standard"],
  ["next", true, "wide"],
  ["timeline", true, "standard"],
  ["run", true, "full"],
];

export function defaultProjectMapLayoutSettings(): ProjectMapLayoutSettings {
  return buildSettings(DEFAULT_SPECS);
}

export type ProjectMapLayoutPresetId = "standard" | "dependency" | "board";

export interface ProjectMapLayoutPreset {
  id: ProjectMapLayoutPresetId;
  label: string;
  description: string;
  settings: () => ProjectMapLayoutSettings;
}

/**
 * レイアウトプリセット。`standard` は既定構成、`dependency` は Dependency Map を広く表示し
 * Board / Run Graph を隠す。`board` は Project Board を広く表示し Dependency Map / Run Graph を隠す。
 */
export const PROJECT_MAP_LAYOUT_PRESETS: readonly ProjectMapLayoutPreset[] = [
  {
    id: "standard",
    label: "標準",
    description: "6 パネルをすべて表示する既定構成",
    settings: defaultProjectMapLayoutSettings,
  },
  {
    id: "dependency",
    label: "依存重視",
    description: "Dependency Map を広く表示し、Board と Run Graph を隠す",
    settings: () =>
      buildSettings([
        ["tree", true, "standard"],
        ["dependency", true, "wide"],
        ["next", true, "standard"],
        ["timeline", true, "wide"],
        ["board", false, "standard"],
        ["run", false, "full"],
      ]),
  },
  {
    id: "board",
    label: "ボード重視",
    description: "Project Board を広く表示し、Dependency Map と Run Graph を隠す",
    settings: () =>
      buildSettings([
        ["tree", true, "standard"],
        ["board", true, "wide"],
        ["next", true, "wide"],
        ["timeline", true, "standard"],
        ["dependency", false, "standard"],
        ["run", false, "full"],
      ]),
  },
];

/** プリセット ID から設定を生成する。未知の ID は既定構成。 */
export function applyProjectMapLayoutPreset(
  id: ProjectMapLayoutPresetId,
): ProjectMapLayoutSettings {
  const preset = PROJECT_MAP_LAYOUT_PRESETS.find((p) => p.id === id);
  return preset ? preset.settings() : defaultProjectMapLayoutSettings();
}

/** 現在の設定がいずれかのプリセットと一致すればその ID を返す。 */
export function matchProjectMapLayoutPreset(
  settings: ProjectMapLayoutSettings,
): ProjectMapLayoutPresetId | null {
  const key = JSON.stringify(settings.panels);
  for (const preset of PROJECT_MAP_LAYOUT_PRESETS) {
    if (JSON.stringify(preset.settings().panels) === key) return preset.id;
  }
  return null;
}

/**
 * 保存データを Zod で検証し、正規化した設定を返す。
 * - スキーマ違反（構造不正・未知の size・version 違い）は既定構成にフォールバック
 * - 未知の id は除外し、重複 id は先勝ち、欠けた id は既定の設定で末尾に補完
 */
export function parseProjectMapLayoutSettings(value: unknown): ProjectMapLayoutSettings {
  // 未知のパネル id はスキーマ違反にせず除外したいので、配列要素単位で検証する。
  if (typeof value !== "object" || value === null) return defaultProjectMapLayoutSettings();
  const record = value as Record<string, unknown>;
  if (record.version !== PROJECT_MAP_LAYOUT_VERSION || !Array.isArray(record.panels)) {
    return defaultProjectMapLayoutSettings();
  }
  const seen = new Set<ProjectMapPanelId>();
  const panels: ProjectMapPanelSetting[] = [];
  for (const item of record.panels) {
    const idResult = z.object({ id: z.string() }).safeParse(item);
    if (!idResult.success) return defaultProjectMapLayoutSettings();
    if (!(PROJECT_MAP_PANEL_IDS as readonly string[]).includes(idResult.data.id)) continue;
    const parsed = ProjectMapPanelSettingSchema.safeParse(item);
    if (!parsed.success) return defaultProjectMapLayoutSettings();
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    panels.push(parsed.data);
  }
  for (const fallback of defaultProjectMapLayoutSettings().panels) {
    if (!seen.has(fallback.id)) panels.push(fallback);
  }
  return ProjectMapLayoutSettingsSchema.parse({ version: PROJECT_MAP_LAYOUT_VERSION, panels });
}

/** 表示対象のパネルを表示順で返す。 */
export function visibleProjectMapPanels(
  settings: ProjectMapLayoutSettings,
): ProjectMapPanelSetting[] {
  return settings.panels.filter((p) => p.visible);
}

/** サイズを 3 カラム grid の column span に変換する。 */
export function projectMapPanelColumnSpan(size: ProjectMapPanelSize): number {
  switch (size) {
    case "wide":
      return 2;
    case "full":
      return PROJECT_MAP_GRID_COLUMNS;
    default:
      return 1;
  }
}

/** grid に配置する 1 パネル分の結果。`span` は列数で頭打ちにした後、行パッキングで拡張済み。 */
export interface PackedProjectMapPanel {
  id: ProjectMapPanelId;
  span: number;
}

/**
 * 可視パネルを表示順のまま `columns` 列の行に詰め、各行末尾のパネルを残り列まで広げる。
 * 次のパネルが行に収まらない場合はその行を閉じるため、空セルは残らず、
 * 非表示にしたパネルの領域は同じ行の末尾パネルへ再配分される。
 * CSS の `grid-auto-flow: dense` と異なり、後続パネルが前の穴へ繰り上がって表示順が崩れることはない。
 */
export function packProjectMapPanels(
  settings: ProjectMapLayoutSettings,
  columns: number,
): PackedProjectMapPanel[] {
  // columns は正の整数を想定する。NaN や 1 未満は 1 カラムとして扱う。
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
  const packed: PackedProjectMapPanel[] = [];
  let remaining = cols;
  for (const panel of visibleProjectMapPanels(settings)) {
    const span = Math.min(projectMapPanelColumnSpan(panel.size), cols);
    if (span > remaining) {
      // 行を閉じる: 直前のパネルを行末まで広げる
      const last = packed[packed.length - 1];
      if (last) last.span += remaining;
      remaining = cols;
    }
    packed.push({ id: panel.id, span });
    remaining -= span;
    if (remaining === 0) remaining = cols;
  }
  // 最終行の末尾も列数まで広げる
  const last = packed[packed.length - 1];
  if (last && remaining !== cols) last.span += remaining;
  return packed;
}

export function setProjectMapPanelVisible(
  settings: ProjectMapLayoutSettings,
  id: ProjectMapPanelId,
  visible: boolean,
): ProjectMapLayoutSettings {
  return {
    ...settings,
    panels: settings.panels.map((p) => (p.id === id ? { ...p, visible } : p)),
  };
}

export function setProjectMapPanelSize(
  settings: ProjectMapLayoutSettings,
  id: ProjectMapPanelId,
  size: ProjectMapPanelSize,
): ProjectMapLayoutSettings {
  return {
    ...settings,
    panels: settings.panels.map((p) => (p.id === id ? { ...p, size } : p)),
  };
}

/** パネルを 1 つ上（前）または下（後）へ移動する。端では変化しない。 */
export function moveProjectMapPanel(
  settings: ProjectMapLayoutSettings,
  id: ProjectMapPanelId,
  direction: "up" | "down",
): ProjectMapLayoutSettings {
  const index = settings.panels.findIndex((p) => p.id === id);
  if (index < 0) return settings;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= settings.panels.length) return settings;
  const panels = [...settings.panels];
  const [moved] = panels.splice(index, 1);
  panels.splice(target, 0, moved);
  return { ...settings, panels };
}
