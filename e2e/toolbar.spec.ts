import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator("[data-task-id='epic-1']").waitFor();
});

async function openTypeFilter(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "All types" }).click();
  await expect(page.getByRole("dialog", { name: "Filter by type" })).toBeVisible();
}

test("type filter menu lists each task type", async ({ page }) => {
  await openTypeFilter(page);

  const dialog = page.getByRole("dialog", { name: "Filter by type" });
  // Type buttons use aria-pressed toggle buttons, not checkboxes
  await expect(dialog.getByRole("button", { name: "Epic" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "Feature" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "Task" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "Milestone" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("clicking a type filter hides tasks of that type", async ({ page }) => {
  // task-2 (type "task") is visible
  await expect(page.locator("[data-task-id='task-2']")).toBeVisible();

  await openTypeFilter(page);

  const dialog = page.getByRole("dialog", { name: "Filter by type" });
  // Disable the "Task" type filter by clicking the toggle button
  await dialog.getByRole("button", { name: "Task" }).click();

  // Task-type items should be hidden
  await expect(page.locator("[data-task-id='task-2']")).not.toBeVisible();
  await expect(page.locator("[data-task-id='task-3']")).not.toBeVisible();

  // Epic and feature should still be visible
  await expect(page.locator("[data-task-id='epic-1']")).toBeVisible();
  await expect(page.locator("[data-task-id='feature-1']")).toBeVisible();
});

test("re-enabling type filter shows tasks again", async ({ page }) => {
  await openTypeFilter(page);
  const dialog = page.getByRole("dialog", { name: "Filter by type" });
  const taskButton = dialog.getByRole("button", { name: "Task" });

  await taskButton.click();
  await expect(page.locator("[data-task-id='task-2']")).not.toBeVisible();

  await taskButton.click();
  await expect(page.locator("[data-task-id='task-2']")).toBeVisible();
});

test("Hide closed button toggles closed task visibility", async ({ page }) => {
  // hideClosed is true by default, so closed tasks are hidden
  await expect(page.locator("[data-task-id='task-1']")).not.toBeVisible();

  // Click Hide Closed Tasks to show them
  await page.getByRole("button", { name: "Hide Closed Tasks" }).click();
  await expect(page.locator("[data-task-id='task-1']")).toBeVisible();
  await expect(page.locator("[data-task-id='task-4']")).toBeVisible();

  // Click again to hide
  await page.getByRole("button", { name: "Hide Closed Tasks" }).click();
  await expect(page.locator("[data-task-id='task-1']")).not.toBeVisible();
});

test("search input filters tasks by title", async ({ page }) => {
  const searchInput = page.getByLabel("Search tasks");
  await searchInput.fill("dashboard");

  // task-2 "Implement dashboard components" should match
  await expect(page.locator("[data-task-id='task-2']")).toBeVisible();
  // Non-matching tasks should be hidden
  await expect(page.locator("[data-task-id='task-3']")).not.toBeVisible();
});

test("スケール切替ボタン (Week/Month/Quarter/Year) と Scroll to Today が表示される", async ({
  page,
}) => {
  await expect(page.getByRole("button", { name: "Week" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Month" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quarter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Year" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scroll to Today" })).toBeVisible();
});

test("display toggle issue ID button works", async ({ page }) => {
  // Display toggles are inside the MoreMenu dropdown
  await page.getByRole("button", { name: "Display & Legend" }).click();

  const idButton = page.getByRole("button", { name: "Issue ID" });
  // Issue ID is enabled by default
  await expect(idButton).toHaveAttribute("aria-pressed", "true");

  await idButton.click();
  await expect(idButton).toHaveAttribute("aria-pressed", "false");

  await idButton.click();
  await expect(idButton).toHaveAttribute("aria-pressed", "true");
});
