import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { CommentsStore } from "../store/comments.js";
import { createApiRouter } from "../server/api.js";

describe("createApiRouter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-gantt-api-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds the progress task map only once per GET /api/tasks request", async () => {
    const configStore = new ConfigStore(dir);
    const tasksStore = new TasksStore(dir);
    const commentsStore = new CommentsStore(dir);

    const tasks = [
      {
        id: "root",
        type: "epic",
        github_issue: 1,
        github_repo: "o/r",
        parent: null,
        sub_tasks: ["child"],
        title: "Root",
        body: null,
        state: "open" as const,
        state_reason: null,
        assignees: [],
        labels: [],
        milestone: null,
        linked_prs: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        closed_at: null,
        custom_fields: {},
        start_date: "2026-01-01",
        end_date: "2026-01-10",
        date: null,
        blocked_by: [],
      },
      {
        id: "child",
        type: "feature",
        github_issue: 2,
        github_repo: "o/r",
        parent: "root",
        sub_tasks: ["leaf"],
        title: "Child",
        body: null,
        state: "open" as const,
        state_reason: null,
        assignees: [],
        labels: [],
        milestone: null,
        linked_prs: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        closed_at: null,
        custom_fields: {},
        start_date: "2026-01-01",
        end_date: "2026-01-10",
        date: null,
        blocked_by: [],
      },
      {
        id: "leaf",
        type: "task",
        github_issue: 3,
        github_repo: "o/r",
        parent: "child",
        sub_tasks: [],
        title: "Leaf",
        body: null,
        state: "closed" as const,
        state_reason: null,
        assignees: [],
        labels: [],
        milestone: null,
        linked_prs: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        closed_at: "2026-01-02T00:00:00Z",
        custom_fields: {},
        start_date: "2026-01-01",
        end_date: "2026-01-10",
        date: null,
        blocked_by: [],
      },
    ];

    await configStore.write({
      version: "1",
      project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
      sync: { conflict_strategy: "remote-wins", auto_create_issues: false, field_mapping: { start_date: "S", end_date: "E", status: "Status" } },
      task_types: {
        epic: { label: "Epic", display: "summary", color: "#111111", github_label: null },
        feature: { label: "Feature", display: "bar", color: "#222222", github_label: null },
        task: { label: "Task", display: "bar", color: "#333333", github_label: null },
      },
      type_hierarchy: { epic: ["feature"], feature: ["task"], task: [] },
      statuses: { field_name: "Status", values: { Done: { color: "#0f0", done: true } } },
      gantt: { default_view: "month", working_days: [1, 2, 3, 4, 5], colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" } },
    });
    await tasksStore.write({ tasks, cache: { comments: {}, reactions: {} } });
    await commentsStore.write({ version: "1", fetched_at: {}, comments: {} });

    const OriginalMap = globalThis.Map;
    let taskMapBuilds = 0;

    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        if (Array.isArray(entries) && entries.length === tasks.length) {
          const looksLikeTaskMap = entries.every(([key, value]) => (
            typeof key === "string"
            && tasks.some((task) => task.id === key)
            && typeof value === "object"
            && value !== null
            && "id" in (value as object)
          ));
          if (looksLikeTaskMap) taskMapBuilds++;
        }
      }
    }

    globalThis.Map = CountingMap as typeof Map;

    const router = createApiRouter(dir);
    const routeLayer = router.stack.find((layer: any) => layer.route?.path === "/api/tasks");
    const handler = routeLayer?.route?.stack?.[0]?.handle as ((req: unknown, res: unknown) => Promise<void>) | undefined;
    if (!handler) throw new Error("GET /api/tasks handler not found");

    try {
      let statusCode = 200;
      let jsonPayload: unknown;
      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(payload: unknown) {
          jsonPayload = payload;
          return this;
        },
      };

      await handler({}, res);

      expect(statusCode).toBe(200);
      expect(jsonPayload).toBeDefined();
      expect(taskMapBuilds).toBe(1);
    } finally {
      globalThis.Map = OriginalMap;
    }
  });
});
