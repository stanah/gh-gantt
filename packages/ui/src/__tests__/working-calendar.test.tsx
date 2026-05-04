// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { scaleTime } from "d3-scale";
import { GanttGrid } from "../components/GanttGrid.js";
import { CalendarSettingsMenu } from "../components/toolbar/CalendarSettingsMenu.js";
import { useCustomNonWorkingDays } from "../hooks/useCustomNonWorkingDays.js";

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
