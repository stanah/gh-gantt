import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator("[data-task-id='epic-1']").waitFor();
});

test("clicking a task opens the detail panel", async ({ page }) => {
  await page.locator("[data-task-id='feature-1']").click();

  // Detail panel shows task title as a link (since it has a GitHub issue)
  const titleLink = page.locator("a").filter({ hasText: "Feature: New Dashboard" });
  await expect(titleLink).toBeVisible();
});

test("detail panel shows task metadata", async ({ page }) => {
  // task-2 is open and visible by default
  await page.locator("[data-task-id='task-2']").click();

  // In single-column layout, status is shown as an inline badge
  // Use .first() since multiple elements may show "In Progress"
  await expect(page.getByText("In Progress").first()).toBeVisible();
});

test("detail panel shows dates", async ({ page }) => {
  await page.locator("[data-task-id='task-2']").click();

  // In single-column layout, dates are shown as a date range badge
  // task-2: start_date "2026-01-16", end_date "2026-02-28"
  await expect(page.getByText("2026-01-16")).toBeVisible();
});

test("clicking same task again closes the detail panel", async ({ page }) => {
  const taskRow = page.locator("[data-task-id='feature-1']");

  // Click to open panel
  await taskRow.click();
  const titleLink = page.locator("a").filter({ hasText: "Feature: New Dashboard" });
  await expect(titleLink).toBeVisible();

  // Click same task to close
  await taskRow.click();
  await expect(titleLink).not.toBeVisible();
});

test("detail panel shows description when available", async ({ page }) => {
  await page.locator("[data-task-id='feature-1']").click();

  // Description appears as a paragraph in the detail panel
  await expect(
    page.getByRole("paragraph").filter({ hasText: "Implement the new dashboard layout." }),
  ).toBeVisible();
});
