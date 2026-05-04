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

test("詳細パネルの Status を編集コントロールの値として表示する", async ({ page }) => {
  // task-2 は open でデフォルト表示される
  await page.locator("[data-task-id='task-2']").click();

  await expect(page.getByLabel("Status")).toHaveValue("In Progress");
});

test("詳細パネルの日付を編集コントロールの値として表示する", async ({ page }) => {
  await page.locator("[data-task-id='task-2']").click();

  await expect(page.getByLabel("Start Date")).toHaveValue("2026-01-16");
  await expect(page.getByLabel("End Date")).toHaveValue("2026-02-28");
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
    page.locator("p").filter({ hasText: "Implement the new dashboard layout." }),
  ).toBeVisible();
});
