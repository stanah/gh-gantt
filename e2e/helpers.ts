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

  await page.route("**/api/tasks/**", async (route) => {
    const method = route.request().method();
    if (method === "PATCH" || method === "POST") {
      const url = route.request().url();
      if (url.includes("/reparent")) {
        return route.fulfill({ json: { tasks: tasksJson.tasks } });
      }
      // Return a realistic task object by merging request body into a fixture task
      const body = route.request().postDataJSON() ?? {};
      const taskId = url.split("/api/tasks/").pop()?.split("/")[0];
      const baseTask = tasksJson.tasks.find((t) => t.id === taskId) ?? tasksJson.tasks[0];
      return route.fulfill({ json: { ...baseTask, ...body } });
    }
    return route.continue();
  });

  await page.route("**/api/sync/**", (route) => {
    const url = route.request().url();

    if (url.endsWith("/pull")) {
      return route.fulfill({
        json: { added: [], updated: [], removed: [] },
      });
    }

    if (url.endsWith("/push")) {
      return route.fulfill({
        json: { created: 0, updated: 0, skipped: 0 },
      });
    }

    return route.fulfill({ json: { ok: true } });
  });
}
