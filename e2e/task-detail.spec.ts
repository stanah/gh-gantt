import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers";

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

  // Should show status in a select
  await expect(page.locator("select").first()).toHaveValue("In Progress");
});

test("detail panel shows dates", async ({ page }) => {
  await page.locator("[data-task-id='task-2']").click();

  const dateInputs = page.locator("input[type='date']");
  await expect(dateInputs.first()).toHaveValue("2026-01-16");
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
  await expect(page.getByRole("paragraph")).toContainText(
    "Implement the new dashboard layout.",
  );
});
