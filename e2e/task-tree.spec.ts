import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator("[data-task-id='epic-1']").waitFor();
});

test("displays project name and task count in header", async ({ page }) => {
  await expect(page.locator("header")).toContainText("Test Project");
  await expect(page.locator("header")).toContainText("7");
});

test("renders all root-level tasks in the tree", async ({ page }) => {
  await expect(page.locator("[data-task-id='epic-1']")).toBeVisible();
});

test("renders child tasks under their parent", async ({ page }) => {
  // hideClosed defaults to true, so closed tasks (task-1, task-4) are hidden
  await expect(page.locator("[data-task-id='feature-1']")).toBeVisible();
  await expect(page.locator("[data-task-id='feature-2']")).toBeVisible();
  await expect(page.locator("[data-task-id='task-2']")).toBeVisible();
  await expect(page.locator("[data-task-id='task-3']")).toBeVisible();
});

test("displays task titles", async ({ page }) => {
  await expect(page.locator("[data-task-id='epic-1']")).toContainText(
    "Epic: Platform Redesign",
  );
  await expect(page.locator("[data-task-id='task-2']")).toContainText(
    "Implement dashboard components",
  );
});

test("collapse and expand a parent task", async ({ page }) => {
  const feature1 = page.locator("[data-task-id='feature-1']");
  const task2 = page.locator("[data-task-id='task-2']");

  await expect(task2).toBeVisible();

  // Click the collapse toggle (▼/▶) on feature-1
  await feature1.locator("span").filter({ hasText: /[▼▶]/ }).first().click();
  await expect(task2).not.toBeVisible();

  // Expand again
  await feature1.locator("span").filter({ hasText: /[▼▶]/ }).first().click();
  await expect(task2).toBeVisible();
});

test("unhide closed shows closed tasks", async ({ page }) => {
  // Closed tasks hidden by default
  await expect(page.locator("[data-task-id='task-1']")).not.toBeVisible();

  // Click "Hide closed" button to toggle (un-hide)
  await page.getByRole("button", { name: "Hide closed" }).click();

  // Now closed tasks should appear
  await expect(page.locator("[data-task-id='task-1']")).toBeVisible();
  await expect(page.locator("[data-task-id='task-4']")).toBeVisible();
});
