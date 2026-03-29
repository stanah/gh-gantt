import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator("[data-task-id='epic-1']").waitFor();
});

async function openShortcutsViaMenu(page: import("@playwright/test").Page) {
  // Shortcuts button is inside the MoreMenu dropdown
  await page.getByRole("button", { name: "Display & Legend" }).click();
  await page
    .getByRole("menuitem", { name: "Keyboard Shortcuts" })
    .or(page.locator("button", { hasText: "Keyboard Shortcuts" }))
    .click();
}

test("? button in toolbar opens help panel", async ({ page }) => {
  await openShortcutsViaMenu(page);

  const dialog = page.locator("[role='dialog']");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("ショートカット一覧");
});

test("Escape closes the help panel", async ({ page }) => {
  await openShortcutsViaMenu(page);
  await expect(page.locator("[role='dialog']")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("[role='dialog']")).not.toBeVisible();
});

test("? key opens the keyboard shortcuts help panel", async ({ page }) => {
  // Click on the page body first to ensure it has focus, not an input
  await page.locator("body").click();
  await page.keyboard.press("Shift+Slash");

  const dialog = page.locator("[role='dialog']");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("ショートカット一覧");
});

test("j/k keys navigate between tasks", async ({ page }) => {
  // Ensure body focus (not search input)
  await page.locator("body").click();

  // Press j to select first task
  await page.keyboard.press("j");

  // The first task (epic-1) should be selected (highlighted background)
  const epic1 = page.locator("[data-task-id='epic-1']");
  await expect(epic1).toHaveCSS("background", /232, 240, 254/);

  // Press j again to move to next task
  await page.keyboard.press("j");
  const feature1 = page.locator("[data-task-id='feature-1']");
  await expect(feature1).toHaveCSS("background", /232, 240, 254/);

  // Press k to go back
  await page.keyboard.press("k");
  await expect(epic1).toHaveCSS("background", /232, 240, 254/);
});

test("Space toggles collapse on selected task", async ({ page }) => {
  await page.locator("body").click();

  // Navigate to epic-1
  await page.keyboard.press("j");
  await expect(page.locator("[data-task-id='epic-1']")).toHaveCSS("background", /232, 240, 254/);

  const feature1 = page.locator("[data-task-id='feature-1']");
  await expect(feature1).toBeVisible();

  // Space to collapse
  await page.keyboard.press("Space");
  await expect(feature1).not.toBeVisible();

  // Space to expand
  await page.keyboard.press("Space");
  await expect(feature1).toBeVisible();
});
