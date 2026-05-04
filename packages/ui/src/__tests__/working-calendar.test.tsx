// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { scaleTime } from "d3-scale";
import { GanttChart } from "../components/GanttChart.js";
import { GanttGrid } from "../components/GanttGrid.js";
import { CalendarSettingsMenu } from "../components/toolbar/CalendarSettingsMenu.js";
import { useCustomNonWorkingDays } from "../hooks/useCustomNonWorkingDays.js";
import { useHolidayPreset, HOLIDAY_PRESET_STORAGE_KEY } from "../hooks/useHolidayPreset.js";
import { HOLIDAY_PRESETS, getHolidayPresetHolidays } from "../lib/holiday-presets.js";
import type { Config, Task } from "../types/index.js";
import type { TreeNode } from "../hooks/useTaskTree.js";

describe("[FR-VIS-016-AC3] Gantt grid の休日・休暇日表示", () => {
  it("休日・休暇日を週末とは別の非稼働日として描画する", () => {
    const dateRange: [Date, Date] = [new Date(2026, 0, 5), new Date(2026, 0, 9)];
    const xScale = scaleTime().domain(dateRange).range([0, 400]);

    const html = renderToStaticMarkup(
      <GanttGrid
        xScale={xScale}
        dateRange={dateRange}
        totalWidth={400}
        totalHeight={84}
        workingDays={[1, 2, 3, 4, 5]}
        pixelsPerDay={100}
        holidays={[{ date: "2026-01-06", name: "Company holiday" }]}
      />,
    );

    expect(html).toContain('data-calendar-day="holiday"');
    expect(html).toContain('data-date="2026-01-06"');
    expect(html).toContain("Company holiday");
  });
});

function CalendarSettingsHarness() {
  const { customDaysOff, addCustomDayOff, removeCustomDayOff } = useCustomNonWorkingDays();

  return (
    <CalendarSettingsMenu
      configuredHolidays={[{ date: "2026-01-06", name: "Company holiday" }]}
      customDaysOff={customDaysOff}
      onAddCustomDayOff={addCustomDayOff}
      onRemoveCustomDayOff={removeCustomDayOff}
    />
  );
}

function HolidayPresetHarness() {
  const { selectedHolidayPresetId, presetHolidays, selectHolidayPreset } = useHolidayPreset();

  return (
    <CalendarSettingsMenu
      configuredHolidays={[]}
      holidayPresetOptions={HOLIDAY_PRESETS}
      selectedHolidayPresetId={selectedHolidayPresetId}
      presetHolidays={presetHolidays}
      onSelectHolidayPreset={selectHolidayPreset}
      customDaysOff={[]}
      onAddCustomDayOff={() => {}}
      onRemoveCustomDayOff={() => {}}
    />
  );
}

const workingCalendarTask: Task = {
  id: "stanah/gh-gantt#228",
  type: "task",
  github_issue: 228,
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: "国別祝日プリセット",
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
  start_date: "2026-01-05",
  end_date: "2026-01-16",
  date: null,
  blocked_by: [],
};

const workingCalendarConfig: Config = {
  version: "1",
  project: {
    name: "Test Project",
    github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: {
      start_date: "Start Date",
      end_date: "End Date",
      status: "Status",
    },
  },
  task_types: {
    task: {
      label: "Task",
      display: "bar",
      color: "#27AE60",
      github_label: null,
    },
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

const workingCalendarFlatList: TreeNode[] = [{ task: workingCalendarTask, children: [], depth: 0 }];

describe("[FR-VIS-016-AC4] カスタム休暇日の localStorage 管理", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("UI からカスタム休暇日を追加・削除し localStorage に反映する", () => {
    const { getByTitle, getByLabelText, getByText, queryByText } = render(
      <CalendarSettingsHarness />,
    );

    fireEvent.click(getByTitle("Calendar Settings"));
    fireEvent.change(getByLabelText("Custom day off date"), { target: { value: "2026-01-07" } });
    fireEvent.change(getByLabelText("Custom day off name"), {
      target: { value: "Company offsite" },
    });
    fireEvent.click(getByText("Add"));

    expect(getByText(/Company offsite/)).toBeTruthy();
    expect(localStorage.getItem("gh-gantt:custom-non-working-days")).toContain("2026-01-07");

    fireEvent.click(getByTitle("Remove 2026-01-07"));

    expect(queryByText(/Company offsite/)).toBeNull();
    expect(localStorage.getItem("gh-gantt:custom-non-working-days")).toBe("[]");
  });

  it("壊れた localStorage 値は空配列として扱う", () => {
    localStorage.setItem("gh-gantt:custom-non-working-days", "not json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { getByTitle, queryByText } = render(<CalendarSettingsHarness />);

    fireEvent.click(getByTitle("Calendar Settings"));
    expect(queryByText("not json")).toBeNull();

    errorSpy.mockRestore();
  });
});

describe("[FR-VIS-017-AC1] 国別祝日プリセット選択", () => {
  afterEach(() => {
    cleanup();
  });

  it("Calendar Settings で祝日プリセットを選択しプリセット休日を表示できる", () => {
    const onSelectHolidayPreset = vi.fn();
    const { getByTitle, getByLabelText, getByText } = render(
      <CalendarSettingsMenu
        configuredHolidays={[]}
        customDaysOff={[]}
        onAddCustomDayOff={() => {}}
        onRemoveCustomDayOff={() => {}}
        holidayPresetOptions={[
          { id: "none", label: "None", holidays: [] },
          {
            id: "jp-2026",
            label: "Japan 2026",
            holidays: [{ date: "2026-01-12", name: "成人の日" }],
          },
        ]}
        selectedHolidayPresetId="jp-2026"
        presetHolidays={[{ date: "2026-01-12", name: "成人の日" }]}
        onSelectHolidayPreset={onSelectHolidayPreset}
      />,
    );

    fireEvent.click(getByTitle("Calendar Settings"));
    fireEvent.change(getByLabelText("Holiday preset"), { target: { value: "none" } });

    expect(onSelectHolidayPreset).toHaveBeenCalledWith("none");
    expect(getByText("2026-01-12 成人の日")).toBeTruthy();
  });
});

describe("[FR-VIS-017-AC2] 国別祝日プリセット定義", () => {
  it("2026 年の日本と米国連邦祝日を公式日付で提供する", () => {
    expect(getHolidayPresetHolidays("jp-2026")).toEqual(
      expect.arrayContaining([
        { date: "2026-01-01", name: "元日" },
        { date: "2026-09-22", name: "休日" },
        { date: "2026-11-23", name: "勤労感謝の日" },
      ]),
    );
    expect(getHolidayPresetHolidays("jp-2026")).toHaveLength(18);

    expect(getHolidayPresetHolidays("us-federal-2026")).toEqual(
      expect.arrayContaining([
        { date: "2026-01-19", name: "Birthday of Martin Luther King, Jr." },
        { date: "2026-07-03", name: "Independence Day" },
        { date: "2026-12-25", name: "Christmas Day" },
      ]),
    );
    expect(getHolidayPresetHolidays("us-federal-2026")).toHaveLength(11);
  });
});

describe("[FR-VIS-017-AC3] 祝日プリセットの localStorage 管理とグリッド反映", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("選択した祝日プリセットを localStorage に保存する", () => {
    const { getByTitle, getByLabelText, getByText } = render(<HolidayPresetHarness />);

    fireEvent.click(getByTitle("Calendar Settings"));
    fireEvent.change(getByLabelText("Holiday preset"), {
      target: { value: "us-federal-2026" },
    });

    expect(localStorage.getItem(HOLIDAY_PRESET_STORAGE_KEY)).toBe("us-federal-2026");
    expect(getByText("2026-07-03 Independence Day")).toBeTruthy();
  });

  it("選択プリセット休日を GanttChart の非稼働日表示に反映する", () => {
    const originalConsoleError = console.error.bind(console);
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message, ...args) => {
      if (
        typeof message === "string" &&
        message.includes("useLayoutEffect does nothing on the server")
      ) {
        return;
      }
      originalConsoleError(message, ...args);
    });

    let html = "";
    try {
      html = renderToStaticMarkup(
        <GanttChart
          tasks={[workingCalendarTask]}
          flatList={workingCalendarFlatList}
          config={workingCalendarConfig}
          selectedTaskId={null}
          onSelectTask={() => {}}
          header={() => {}}
          dependencyHighlightEnabled={false}
          presetHolidays={[{ date: "2026-01-12", name: "成人の日" }]}
        />,
      );
    } finally {
      errorSpy.mockRestore();
    }

    expect(html).toContain('data-calendar-day="holiday"');
    expect(html).toContain('data-date="2026-01-12"');
    expect(html).toContain("成人の日");
  });
});
