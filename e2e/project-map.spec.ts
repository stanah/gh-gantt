import { expect, test } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator("[data-task-id='epic-1']").waitFor();
});

test("Gantt と Project Map ビューを切り替えられる", async ({ page }) => {
  // 既定は Gantt ビュー
  await expect(page.getByTestId("project-map-page")).toHaveCount(0);

  await page.getByRole("button", { name: "Project Map" }).click();

  // Project Map のレイアウトと主要パネルが表示される
  await expect(page.getByTestId("project-map-layout")).toBeVisible();
  await expect(page.getByText("System Tree")).toBeVisible();
  await expect(page.getByText("Project Board")).toBeVisible();
  await expect(page.getByText("Dependency Map")).toBeVisible();
  await expect(page.getByText("Next Actions")).toBeVisible();
  await expect(page.getByText("Compact Gantt")).toBeVisible();

  // Gantt ビューへ戻れる
  await page.getByRole("button", { name: "Gantt" }).click();
  await expect(page.getByTestId("project-map-page")).toHaveCount(0);
});

test("Project Map で検索フィルタが効く", async ({ page }) => {
  await page.getByRole("button", { name: "Project Map" }).click();
  await expect(page.getByTestId("project-map-layout")).toBeVisible();

  const search = page.getByLabel("Project Map 検索");
  await search.fill("___no_such_task___");

  // 一致 0 件のカウントになる
  await expect(page.getByText(/0\/\d+ 件/)).toBeVisible();
});
