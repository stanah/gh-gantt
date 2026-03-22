import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator("[data-task-id='epic-1']").waitFor();
});

test("clicking a task opens the detail panel", async ({ page }) => {
  await page.locator("[data-task-id='feature-1']").click();

  // Detail panel shows a heading with the task title
  await expect(
    page.getByRole("heading", { name: "Feature: New Dashboard" }),
  ).toBeVisible();
});

test("detail panel shows task metadata", async ({ page }) => {
  // task-2 is open and visible by default
  await page.locator("[data-task-id='task-2']").click();

  // Should show status in a select (scoped by label)
  await expect(
    page.locator("label:text('Status') + select"),
  ).toHaveValue("In Progress");
});

test("detail panel shows dates", async ({ page }) => {
  await page.locator("[data-task-id='task-2']").click();

  await expect(
    page.locator("label:text('Start Date') + input[type='date']"),
  ).toHaveValue("2026-01-16");
});

test("clicking same task again closes the detail panel", async ({ page }) => {
  const taskRow = page.locator("[data-task-id='feature-1']");

  // Click to open panel
  await taskRow.click();
  await expect(
    page.getByRole("heading", { name: "Feature: New Dashboard" }),
  ).toBeVisible();

  // Click same task to close
  await taskRow.click();
  await expect(
    page.getByRole("heading", { name: "Feature: New Dashboard" }),
  ).not.toBeVisible();
});

test("detail panel shows description when available", async ({ page }) => {
  await page.locator("[data-task-id='feature-1']").click();

  // Description appears in a paragraph in the detail panel
  await expect(
    page.locator("label:text('Description') ~ * p").first(),
  ).toContainText("Implement the new dashboard layout.");
});
