import type { Page } from "@playwright/test";
import configJson from "./fixtures/config.json";
import tasksJson from "./fixtures/tasks.json";

export async function mockApi(page: Page) {
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: configJson }),
  );

  await page.route("**/api/tasks", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: tasksJson });
    }
    return route.fulfill({ json: { ok: true } });
  });

  await page.route("**/api/tasks/**", (route) => {
    const method = route.request().method();
    if (method === "PATCH" || method === "POST") {
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });

  await page.route("**/api/sync/**", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
}
