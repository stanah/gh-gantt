import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator("[data-task-id='epic-1']").waitFor();
});

test("type filter buttons are rendered for each task type", async ({
  page,
}) => {
  await expect(page.getByRole("button", { name: "Epic" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feature" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Task", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Milestone" }),
  ).toBeVisible();
});

test("clicking a type filter hides tasks of that type", async ({ page }) => {
  // task-2 (type "task") is visible
  await expect(page.locator("[data-task-id='task-2']")).toBeVisible();

  // Click "Task" type filter to disable it
  await page.getByRole("button", { name: "Task", exact: true }).click();

  // Task-type items should be hidden
  await expect(page.locator("[data-task-id='task-2']")).not.toBeVisible();
  await expect(page.locator("[data-task-id='task-3']")).not.toBeVisible();

  // Epic and feature should still be visible
  await expect(page.locator("[data-task-id='epic-1']")).toBeVisible();
  await expect(page.locator("[data-task-id='feature-1']")).toBeVisible();
});

test("re-enabling type filter shows tasks again", async ({ page }) => {
  const taskButton = page.getByRole("button", { name: "Task", exact: true });

  await taskButton.click();
  await expect(page.locator("[data-task-id='task-2']")).not.toBeVisible();

  await taskButton.click();
  await expect(page.locator("[data-task-id='task-2']")).toBeVisible();
});

test("Hide closed button toggles closed task visibility", async ({ page }) => {
  // hideClosed is true by default, so closed tasks are hidden
  await expect(page.locator("[data-task-id='task-1']")).not.toBeVisible();

  // Click Hide closed to show them
  await page.getByRole("button", { name: "Hide closed" }).click();
  await expect(page.locator("[data-task-id='task-1']")).toBeVisible();
  await expect(page.locator("[data-task-id='task-4']")).toBeVisible();

  // Click again to hide
  await page.getByRole("button", { name: "Hide closed" }).click();
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

test("view scale buttons switch between views", async ({ page }) => {
  // Default is "month" per config
  const monthButton = page.getByRole("button", { name: "month" });
  await expect(monthButton).toHaveCSS("background-color", "rgb(51, 51, 51)");

  const weekButton = page.getByRole("button", { name: "week" });
  await weekButton.click();

  await expect(weekButton).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await expect(monthButton).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

test("display toggle #ID button works", async ({ page }) => {
  const idButton = page.getByRole("button", { name: "#ID" });

  // Check initial state, then toggle
  const initialBg = await idButton.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );

  await idButton.click();

  // Background should change after toggle
  const newBg = await idButton.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(newBg).not.toBe(initialBg);
});
