import type { CalendarHoliday } from "../types/index.js";

export type HolidayPresetId = "none" | "jp-2026" | "us-federal-2026";

export interface HolidayPreset {
  id: HolidayPresetId;
  label: string;
  holidays: CalendarHoliday[];
}

const NONE_HOLIDAY_PRESET: HolidayPreset = {
  id: "none",
  label: "None",
  holidays: [],
};

export const HOLIDAY_PRESETS: HolidayPreset[] = [
  NONE_HOLIDAY_PRESET,
  {
    id: "jp-2026",
    label: "Japan 2026",
    holidays: [
      { date: "2026-01-01", name: "元日" },
      { date: "2026-01-12", name: "成人の日" },
      { date: "2026-02-11", name: "建国記念の日" },
      { date: "2026-02-23", name: "天皇誕生日" },
      { date: "2026-03-20", name: "春分の日" },
      { date: "2026-04-29", name: "昭和の日" },
      { date: "2026-05-03", name: "憲法記念日" },
      { date: "2026-05-04", name: "みどりの日" },
      { date: "2026-05-05", name: "こどもの日" },
      { date: "2026-05-06", name: "休日" },
      { date: "2026-07-20", name: "海の日" },
      { date: "2026-08-11", name: "山の日" },
      { date: "2026-09-21", name: "敬老の日" },
      { date: "2026-09-22", name: "休日" },
      { date: "2026-09-23", name: "秋分の日" },
      { date: "2026-10-12", name: "スポーツの日" },
      { date: "2026-11-03", name: "文化の日" },
      { date: "2026-11-23", name: "勤労感謝の日" },
    ],
  },
  {
    id: "us-federal-2026",
    label: "United States Federal 2026",
    holidays: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-01-19", name: "Birthday of Martin Luther King, Jr." },
      { date: "2026-02-16", name: "Washington's Birthday" },
      { date: "2026-05-25", name: "Memorial Day" },
      { date: "2026-06-19", name: "Juneteenth National Independence Day" },
      { date: "2026-07-03", name: "Independence Day" },
      { date: "2026-09-07", name: "Labor Day" },
      { date: "2026-10-12", name: "Columbus Day" },
      { date: "2026-11-11", name: "Veterans Day" },
      { date: "2026-11-26", name: "Thanksgiving Day" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
  },
];

const holidayPresetIds = new Set<string>(HOLIDAY_PRESETS.map((preset) => preset.id));

export function isHolidayPresetId(value: string): value is HolidayPresetId {
  return holidayPresetIds.has(value);
}

export function getHolidayPreset(id: string | null | undefined): HolidayPreset {
  return HOLIDAY_PRESETS.find((preset) => preset.id === id) ?? NONE_HOLIDAY_PRESET;
}

export function getHolidayPresetHolidays(id: string | null | undefined): CalendarHoliday[] {
  return getHolidayPreset(id).holidays;
}
