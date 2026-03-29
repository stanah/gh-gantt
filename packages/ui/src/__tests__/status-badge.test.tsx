import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge } from "../components/StatusBadge.js";
import type { StatusValue } from "../types/index.js";

describe("StatusBadge", () => {
  it("renders nothing when status is undefined", () => {
    const html = renderToStaticMarkup(<StatusBadge status={undefined} statusValues={{}} />);
    expect(html).toBe("");
  });

  describe("explicit category", () => {
    const cases: Array<{ name: string; category: StatusValue["category"]; expected: string }> = [
      { name: "backlog", category: "backlog", expected: "stroke-dasharray" },
      { name: "todo", category: "todo", expected: "border-radius:50%" },
      { name: "in_progress", category: "in_progress", expected: "#3fb950" },
      { name: "in_review", category: "in_review", expected: "#f97316" },
      { name: "blocked", category: "blocked", expected: "#e74c3c" },
      { name: "done", category: "done", expected: "#8957e5" },
    ];

    for (const { name, category, expected } of cases) {
      it(`renders ${name} icon when category is "${category}"`, () => {
        const statusValues: Record<string, StatusValue> = {
          CustomName: { color: "#000", done: false, category },
        };
        const html = renderToStaticMarkup(
          <StatusBadge status="CustomName" statusValues={statusValues} />,
        );
        expect(html).toContain(expected);
      });
    }
  });

  describe("inferred category from status name", () => {
    it("infers in_progress from 'In Progress' without category", () => {
      const statusValues: Record<string, StatusValue> = {
        "In Progress": { color: "#000", done: false },
      };
      const html = renderToStaticMarkup(
        <StatusBadge status="In Progress" statusValues={statusValues} />,
      );
      expect(html).toContain("#3fb950");
    });

    it("infers backlog from 'Backlog' without category", () => {
      const statusValues: Record<string, StatusValue> = {
        Backlog: { color: "#000", done: false },
      };
      const html = renderToStaticMarkup(
        <StatusBadge status="Backlog" statusValues={statusValues} />,
      );
      expect(html).toContain("stroke-dasharray");
    });

    it("falls back to todo icon for unknown status name", () => {
      const statusValues: Record<string, StatusValue> = {
        Unknown: { color: "#000", done: false },
      };
      const html = renderToStaticMarkup(
        <StatusBadge status="Unknown" statusValues={statusValues} />,
      );
      expect(html).toContain("border-radius:50%");
    });
  });

  describe("done flag takes precedence over category", () => {
    it("renders done icon when done: true even if category is in_progress", () => {
      const statusValues: Record<string, StatusValue> = {
        Completed: { color: "#000", done: true, category: "in_progress" },
      };
      const html = renderToStaticMarkup(
        <StatusBadge status="Completed" statusValues={statusValues} />,
      );
      expect(html).toContain("#8957e5");
    });

    it("renders done icon when done: true without category", () => {
      const statusValues: Record<string, StatusValue> = {
        Finished: { color: "#000", done: true },
      };
      const html = renderToStaticMarkup(
        <StatusBadge status="Finished" statusValues={statusValues} />,
      );
      expect(html).toContain("#8957e5");
    });
  });
});
