import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { CommentsStore } from "../store/comments.js";
import { createApiRouter } from "../server/api.js";
import type { Config, Task } from "@gh-gantt/shared";

describe("createApiRouter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-gantt-api-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("[FR-API-004-AC1] GET /api/config は sprint 設定を返す", async () => {
    const configStore = new ConfigStore(dir);
    await configStore.write({
      version: "1",
      project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
      sync: {
        auto_create_issues: false,
        field_mapping: { start_date: "S", end_date: "E", status: "Status" },
      },
      task_types: {
        task: { label: "Task", display: "bar", color: "#333333", github_label: null },
      },
      type_hierarchy: { task: [] },
      statuses: { field_name: "Status", values: {} },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
      },
      sprints: [
        {
          name: "Sprint 1",
          start_date: "2026-04-01",
          end_date: "2026-04-14",
          color: "#123456",
        },
      ],
    });

    const router = createApiRouter(dir);
    const routeLayer = router.stack.find((layer: any) => layer.route?.path === "/api/config");
    const handler = routeLayer?.route?.stack?.[0]?.handle as
      | ((req: unknown, res: unknown) => Promise<void>)
      | undefined;
    if (!handler) throw new Error("GET /api/config handler not found");

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
    expect(jsonPayload).toMatchObject({
      sprints: [
        {
          name: "Sprint 1",
          start_date: "2026-04-01",
          end_date: "2026-04-14",
          color: "#123456",
        },
      ],
    });
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
      sync: {
        auto_create_issues: false,
        field_mapping: { start_date: "S", end_date: "E", status: "Status" },
      },
      task_types: {
        epic: { label: "Epic", display: "summary", color: "#111111", github_label: null },
        feature: { label: "Feature", display: "bar", color: "#222222", github_label: null },
        task: { label: "Task", display: "bar", color: "#333333", github_label: null },
      },
      type_hierarchy: { epic: ["feature"], feature: ["task"], task: [] },
      statuses: { field_name: "Status", values: { Done: { color: "#0f0", done: true } } },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
      },
    });
    await tasksStore.write({ tasks, cache: { comments: {}, reactions: {} } });
    await commentsStore.write({ version: "1", fetched_at: {}, comments: {} });

    const OriginalMap = globalThis.Map;
    let taskMapBuilds = 0;

    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        if (Array.isArray(entries) && entries.length === tasks.length) {
          const looksLikeTaskMap = entries.every(
            ([key, value]) =>
              typeof key === "string" &&
              tasks.some((task) => task.id === key) &&
              typeof value === "object" &&
              value !== null &&
              "id" in (value as object),
          );
          if (looksLikeTaskMap) taskMapBuilds++;
        }
      }
    }

    globalThis.Map = CountingMap as typeof Map;

    const router = createApiRouter(dir);
    const routeLayer = router.stack.find((layer: any) => layer.route?.path === "/api/tasks");
    const handler = routeLayer?.route?.stack?.[0]?.handle as
      | ((req: unknown, res: unknown) => Promise<void>)
      | undefined;
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

  it("PATCH /api/tasks/:id で type 変更を保存し github_label を差し替える", async () => {
    const configStore = new ConfigStore(dir);
    const tasksStore = new TasksStore(dir);

    await configStore.write({
      version: "1",
      project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
      sync: {
        auto_create_issues: false,
        field_mapping: { start_date: "S", end_date: "E", status: "Status" },
      },
      task_types: {
        task: { label: "Task", display: "bar", color: "#333333", github_label: "task" },
        feature: {
          label: "Feature",
          display: "bar",
          color: "#222222",
          github_label: "feature",
        },
      },
      type_hierarchy: {},
      statuses: { field_name: "Status", values: {} },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
      },
    });
    await tasksStore.write({
      tasks: [
        {
          id: "o/r#1",
          type: "task",
          github_issue: 1,
          github_repo: "o/r",
          parent: null,
          sub_tasks: [],
          title: "Task",
          body: null,
          state: "open" as const,
          state_reason: null,
          assignees: [],
          labels: ["task", "keep"],
          milestone: null,
          linked_prs: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          closed_at: null,
          custom_fields: {},
          start_date: null,
          end_date: null,
          date: null,
          blocked_by: [],
        },
      ],
      cache: { comments: {}, reactions: {} },
    });

    const router = createApiRouter(dir);
    const routeLayer = router.stack.find(
      (layer: any) => layer.route?.path === "/api/tasks/:id" && layer.route?.methods?.patch,
    );
    const handler = routeLayer?.route?.stack?.[0]?.handle as
      | ((req: unknown, res: unknown) => Promise<void>)
      | undefined;
    if (!handler) throw new Error("PATCH /api/tasks/:id handler not found");

    let statusCode = 200;
    let jsonPayload: any;
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

    await handler(
      {
        params: { id: encodeURIComponent("o/r#1") },
        body: { type: "feature" },
      },
      res,
    );

    const written = await tasksStore.read();

    expect(statusCode).toBe(200);
    expect(jsonPayload.type).toBe("feature");
    expect(jsonPayload.labels).toEqual(["keep", "feature"]);
    expect(written.tasks[0].type).toBe("feature");
    expect(written.tasks[0].labels).toEqual(["keep", "feature"]);
  });

  it("PATCH /api/tasks/:id は labels が文字列配列でない場合 400 を返す", async () => {
    const configStore = new ConfigStore(dir);
    const tasksStore = new TasksStore(dir);

    await configStore.write({
      version: "1",
      project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
      sync: {
        auto_create_issues: false,
        field_mapping: { start_date: "S", end_date: "E", status: "Status" },
      },
      task_types: {
        task: { label: "Task", display: "bar", color: "#333333", github_label: "task" },
        feature: {
          label: "Feature",
          display: "bar",
          color: "#222222",
          github_label: "feature",
        },
      },
      type_hierarchy: {},
      statuses: { field_name: "Status", values: {} },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
      },
    });
    await tasksStore.write({
      tasks: [
        {
          id: "o/r#1",
          type: "task",
          github_issue: 1,
          github_repo: "o/r",
          parent: null,
          sub_tasks: [],
          title: "Task",
          body: null,
          state: "open" as const,
          state_reason: null,
          assignees: [],
          labels: ["task", "keep"],
          milestone: null,
          linked_prs: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          closed_at: null,
          custom_fields: {},
          start_date: null,
          end_date: null,
          date: null,
          blocked_by: [],
        },
      ],
      cache: { comments: {}, reactions: {} },
    });

    const router = createApiRouter(dir);
    const routeLayer = router.stack.find(
      (layer: any) => layer.route?.path === "/api/tasks/:id" && layer.route?.methods?.patch,
    );
    const handler = routeLayer?.route?.stack?.[0]?.handle as
      | ((req: unknown, res: unknown) => Promise<void>)
      | undefined;
    if (!handler) throw new Error("PATCH /api/tasks/:id handler not found");

    let statusCode = 200;
    let jsonPayload: any;
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

    await handler(
      {
        params: { id: encodeURIComponent("o/r#1") },
        body: { type: "feature", labels: null },
      },
      res,
    );

    const written = await tasksStore.read();

    expect(statusCode).toBe(400);
    expect(jsonPayload.error).toBe("labels must be an array of strings");
    expect(written.tasks[0].type).toBe("task");
    expect(written.tasks[0].labels).toEqual(["task", "keep"]);
  });

  it("[FR-API-005-AC1] PATCH /api/tasks/:id は sprint 期間への日付更新を保存する", async () => {
    const configStore = new ConfigStore(dir);
    const tasksStore = new TasksStore(dir);

    await configStore.write({
      version: "1",
      project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
      sync: {
        auto_create_issues: false,
        field_mapping: { start_date: "S", end_date: "E", status: "Status" },
      },
      task_types: {
        task: { label: "Task", display: "bar", color: "#333333", github_label: "task" },
      },
      type_hierarchy: {},
      statuses: { field_name: "Status", values: {} },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
      },
      sprints: [
        {
          name: "Sprint 2",
          start_date: "2026-04-15",
          end_date: "2026-04-28",
          color: "#123456",
        },
      ],
    });
    await tasksStore.write({
      tasks: [
        {
          id: "o/r#1",
          type: "task",
          github_issue: 1,
          github_repo: "o/r",
          parent: null,
          sub_tasks: [],
          title: "Task",
          body: null,
          state: "open" as const,
          state_reason: null,
          assignees: [],
          labels: ["task"],
          milestone: null,
          linked_prs: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          closed_at: null,
          custom_fields: {},
          start_date: null,
          end_date: null,
          date: null,
          blocked_by: [],
        },
      ],
      cache: { comments: {}, reactions: {} },
    });

    const router = createApiRouter(dir);
    const routeLayer = router.stack.find(
      (layer: any) => layer.route?.path === "/api/tasks/:id" && layer.route?.methods?.patch,
    );
    const handler = routeLayer?.route?.stack?.[0]?.handle as
      | ((req: unknown, res: unknown) => Promise<void>)
      | undefined;
    if (!handler) throw new Error("PATCH /api/tasks/:id handler not found");

    let statusCode = 200;
    let jsonPayload: any;
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

    await handler(
      {
        params: { id: encodeURIComponent("o/r#1") },
        body: { start_date: "2026-04-15", end_date: "2026-04-28" },
      },
      res,
    );

    const written = await tasksStore.read();

    expect(statusCode).toBe(200);
    expect(jsonPayload.start_date).toBe("2026-04-15");
    expect(jsonPayload.end_date).toBe("2026-04-28");
    expect(written.tasks[0].start_date).toBe("2026-04-15");
    expect(written.tasks[0].end_date).toBe("2026-04-28");
  });

  describe("[FR-API-001-AC2] POST /api/tasks は parent 参照を正規形へ解決して保存する", () => {
    beforeEach(async () => {
      await new ConfigStore(dir).write(buildParentTestConfig());
      await new TasksStore(dir).write({
        tasks: [
          makeServerTask("o/r#draft-1", { type: "epic" }),
          makeServerTask("o/r#293", { github_issue: 293 }),
        ],
        cache: { comments: {}, reactions: {} },
      });
    });

    async function postTask(body: Record<string, unknown>) {
      const handler = findRouteHandler(createApiRouter(dir), "/api/tasks", "post");
      const { res, captured } = makeCapturingRes();
      await handler({ body }, res);
      return captured;
    }

    it("draft 短縮形 (draft-1) を正規形 o/r#draft-1 に解決して保存する", async () => {
      const { statusCode, jsonPayload } = await postTask({
        title: "子タスク",
        type: "task",
        parent: "draft-1",
      });

      expect(statusCode).toBe(201);
      expect(jsonPayload.parent).toBe("o/r#draft-1");
      const written = await new TasksStore(dir).read();
      const created = written.tasks.find((t) => t.id === "o/r#draft-2");
      expect(created?.parent).toBe("o/r#draft-1");
      // 親の sub_tasks にも正規形の子 ID が追加される
      const parentTask = written.tasks.find((t) => t.id === "o/r#draft-1");
      expect(parentTask?.sub_tasks).toContain("o/r#draft-2");
    });

    it("番号形式 (293) を正規形 o/r#293 に解決して保存する", async () => {
      const { statusCode, jsonPayload } = await postTask({
        title: "子タスク",
        type: "task",
        parent: "293",
      });

      expect(statusCode).toBe(201);
      expect(jsonPayload.parent).toBe("o/r#293");
      const written = await new TasksStore(dir).read();
      const parentTask = written.tasks.find((t) => t.id === "o/r#293");
      expect(parentTask?.sub_tasks).toContain("o/r#draft-2");
    });

    it("#付き番号形式 (#293) を正規形 o/r#293 に解決して保存する", async () => {
      const { statusCode, jsonPayload } = await postTask({
        title: "子タスク",
        type: "task",
        parent: "#293",
      });

      expect(statusCode).toBe(201);
      expect(jsonPayload.parent).toBe("o/r#293");
    });

    it("正規形 (o/r#293) はそのまま受理される (UI の既存経路を壊さない)", async () => {
      const { statusCode, jsonPayload } = await postTask({
        title: "子タスク",
        type: "task",
        parent: "o/r#293",
      });

      expect(statusCode).toBe(201);
      expect(jsonPayload.parent).toBe("o/r#293");
    });

    it("存在しない親を指す parent は 400 になりタスクを作成しない", async () => {
      const { statusCode, jsonPayload } = await postTask({
        title: "子タスク",
        type: "task",
        parent: "draft-99",
      });

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe("Parent task not found: o/r#draft-99");
      // silent 成功しないこと: タスクが増えていない
      const written = await new TasksStore(dir).read();
      expect(written.tasks).toHaveLength(2);
    });

    it("parent が文字列以外の場合は 400 になる", async () => {
      const { statusCode, jsonPayload } = await postTask({
        title: "子タスク",
        type: "task",
        parent: 293,
      });

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe("parent must be a string or null");
    });

    it("parent 未指定なら parent は null のまま作成される", async () => {
      const { statusCode, jsonPayload } = await postTask({ title: "単独タスク", type: "task" });

      expect(statusCode).toBe(201);
      expect(jsonPayload.parent).toBeNull();
    });

    it("空文字・空白のみの parent は 400 になる", async () => {
      for (const invalid of ["", "   "]) {
        const { statusCode, jsonPayload } = await postTask({
          title: "タスク",
          type: "task",
          parent: invalid,
        });
        expect(statusCode).toBe(400);
        expect(jsonPayload.error).toBe("parent must be a non-empty string or null");
      }
    });
  });

  describe("[FR-API-001-AC2] PATCH /api/tasks/:id は parent 参照を正規形へ解決して保存する", () => {
    beforeEach(async () => {
      await new ConfigStore(dir).write(buildParentTestConfig());
      await new TasksStore(dir).write({
        tasks: [
          makeServerTask("o/r#draft-1", { type: "epic" }),
          makeServerTask("o/r#5", { github_issue: 5, parent: null }),
        ],
        cache: { comments: {}, reactions: {} },
      });
    });

    async function patchTask(id: string, body: Record<string, unknown>) {
      const handler = findRouteHandler(createApiRouter(dir), "/api/tasks/:id", "patch");
      const { res, captured } = makeCapturingRes();
      await handler({ params: { id: encodeURIComponent(id) }, body }, res);
      return captured;
    }

    it("draft 短縮形 (draft-1) を正規形 o/r#draft-1 に解決して保存する", async () => {
      const { statusCode, jsonPayload } = await patchTask("o/r#5", { parent: "draft-1" });

      expect(statusCode).toBe(200);
      expect(jsonPayload.parent).toBe("o/r#draft-1");
      const written = await new TasksStore(dir).read();
      expect(written.tasks.find((t) => t.id === "o/r#5")?.parent).toBe("o/r#draft-1");
    });

    it("存在しない親を指す parent は 400 になり保存されない", async () => {
      const { statusCode, jsonPayload } = await patchTask("o/r#5", { parent: "draft-99" });

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe("Parent task not found: o/r#draft-99");
      const written = await new TasksStore(dir).read();
      expect(written.tasks.find((t) => t.id === "o/r#5")?.parent).toBeNull();
    });

    it("parent が文字列以外の場合は 400 になる", async () => {
      const { statusCode, jsonPayload } = await patchTask("o/r#5", { parent: 5 });

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe("parent must be a string or null");
    });

    it("parent: null による親解除は従来どおり通る", async () => {
      await new TasksStore(dir).write({
        tasks: [
          makeServerTask("o/r#draft-1", { type: "epic", sub_tasks: ["o/r#5"] }),
          makeServerTask("o/r#5", { github_issue: 5, parent: "o/r#draft-1" }),
        ],
        cache: { comments: {}, reactions: {} },
      });

      const { statusCode, jsonPayload } = await patchTask("o/r#5", { parent: null });

      expect(statusCode).toBe(200);
      expect(jsonPayload.parent).toBeNull();
      // 旧親の sub_tasks からも除去される (逆リンク維持)
      const written = await new TasksStore(dir).read();
      expect(written.tasks.find((t) => t.id === "o/r#draft-1")?.sub_tasks).toEqual([]);
    });

    it("parent の設定は新親の sub_tasks にも逆リンクを追加する", async () => {
      const { statusCode } = await patchTask("o/r#5", { parent: "draft-1" });

      expect(statusCode).toBe(200);
      const written = await new TasksStore(dir).read();
      expect(written.tasks.find((t) => t.id === "o/r#draft-1")?.sub_tasks).toContain("o/r#5");
    });

    it("空文字・空白のみの parent は 400 になる (POST と同一の対称性)", async () => {
      for (const invalid of ["", "   "]) {
        const { statusCode, jsonPayload } = await patchTask("o/r#5", { parent: invalid });
        expect(statusCode).toBe(400);
        expect(jsonPayload.error).toBe("parent must be a non-empty string or null");
      }
    });

    it("循環を作る parent 変更は 400 になる (A→B の階層で A の parent を B にする)", async () => {
      await new TasksStore(dir).write({
        tasks: [
          makeServerTask("o/r#draft-1", { type: "epic", sub_tasks: ["o/r#5"] }),
          makeServerTask("o/r#5", { github_issue: 5, parent: "o/r#draft-1" }),
        ],
        cache: { comments: {}, reactions: {} },
      });

      const { statusCode, jsonPayload } = await patchTask("o/r#draft-1", { parent: "o/r#5" });

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe("This operation would create a cycle");
    });

    it("type_hierarchy に反する parent 変更は 400 になる (reparent と同一の階層制約)", async () => {
      const config = buildParentTestConfig();
      config.type_hierarchy = { epic: ["feature"], task: [], feature: [] };
      await new ConfigStore(dir).write(config);

      const { statusCode, jsonPayload } = await patchTask("o/r#5", { parent: "draft-1" });

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe('Cannot place "task" under "epic"');
    });

    it("短縮形の自己参照 parent は 400 になる", async () => {
      const { statusCode, jsonPayload } = await patchTask("o/r#5", { parent: "5" });

      expect(statusCode).toBe(400);
      // 自己参照は 1 要素の循環として循環検出に先に捕まる
      expect(jsonPayload.error).toBe("This operation would create a cycle");
      const written = await new TasksStore(dir).read();
      expect(written.tasks.find((t) => t.id === "o/r#5")?.parent).toBeNull();
    });
  });

  describe("[FR-API-003-AC3] POST /api/tasks/:id/reparent は newParentId を正規形へ解決する", () => {
    beforeEach(async () => {
      await new ConfigStore(dir).write(buildParentTestConfig());
      await new TasksStore(dir).write({
        tasks: [
          makeServerTask("o/r#draft-1", { type: "epic" }),
          makeServerTask("o/r#293", { github_issue: 293 }),
          makeServerTask("o/r#5", { github_issue: 5 }),
        ],
        cache: { comments: {}, reactions: {} },
      });
    });

    async function reparentTask(id: string, body: Record<string, unknown>) {
      const handler = findRouteHandler(createApiRouter(dir), "/api/tasks/:id/reparent", "post");
      const { res, captured } = makeCapturingRes();
      await handler({ params: { id: encodeURIComponent(id) }, body }, res);
      return captured;
    }

    it("newParentId キーが無い body は 400 になる（意図しない親解除の防止）", async () => {
      const { statusCode, jsonPayload } = await reparentTask("o/r#5", {});

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe("newParentId is required (use null to remove parent)");
    });

    it("空文字・空白のみの newParentId は 400 になる", async () => {
      for (const invalid of ["", "   "]) {
        const { statusCode, jsonPayload } = await reparentTask("o/r#5", { newParentId: invalid });
        expect(statusCode).toBe(400);
        expect(jsonPayload.error).toBe("newParentId must be a non-empty string or null");
      }
    });

    it("draft 短縮形 (draft-1) を正規形 o/r#draft-1 に解決して親子関係を設定する", async () => {
      const { statusCode } = await reparentTask("o/r#5", { newParentId: "draft-1" });

      expect(statusCode).toBe(200);
      const written = await new TasksStore(dir).read();
      expect(written.tasks.find((t) => t.id === "o/r#5")?.parent).toBe("o/r#draft-1");
      expect(written.tasks.find((t) => t.id === "o/r#draft-1")?.sub_tasks).toContain("o/r#5");
    });

    it("短縮形での自己参照 (293 → o/r#293) を正規化後に検出して 400 を返す", async () => {
      const { statusCode, jsonPayload } = await reparentTask("o/r#293", { newParentId: "293" });

      expect(statusCode).toBe(400);
      expect(jsonPayload.code).toBe("SELF_REFERENCE");
    });

    it("newParentId が文字列以外の場合は 400 になる", async () => {
      const { statusCode, jsonPayload } = await reparentTask("o/r#5", { newParentId: 5 });

      expect(statusCode).toBe(400);
      expect(jsonPayload.error).toBe("newParentId must be a string or null");
    });

    it("newParentId: null による親解除は従来どおり通る", async () => {
      await new TasksStore(dir).write({
        tasks: [
          makeServerTask("o/r#draft-1", { type: "epic", sub_tasks: ["o/r#5"] }),
          makeServerTask("o/r#5", { github_issue: 5, parent: "o/r#draft-1" }),
        ],
        cache: { comments: {}, reactions: {} },
      });

      const { statusCode } = await reparentTask("o/r#5", { newParentId: null });

      expect(statusCode).toBe(200);
      const written = await new TasksStore(dir).read();
      expect(written.tasks.find((t) => t.id === "o/r#5")?.parent).toBeNull();
    });
  });
});

/** parent 正規化テスト用の最小 Config を生成する */
function buildParentTestConfig(): Config {
  return {
    version: "1",
    project: { name: "test", github: { owner: "o", repo: "r", project_number: 1 } },
    sync: {
      auto_create_issues: false,
      field_mapping: { start_date: "S", end_date: "E", status: "Status" },
    },
    task_types: {
      task: { label: "Task", display: "bar", color: "#333333", github_label: null },
      epic: { label: "Epic", display: "summary", color: "#111111", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "month",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
  };
}

/** parent 正規化テスト用のタスクを生成する */
function makeServerTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "o/r",
    parent: null,
    sub_tasks: [],
    title: `Task ${id}`,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

/** ルーターから指定 path / method のハンドラを取り出す */
function findRouteHandler(
  router: ReturnType<typeof createApiRouter>,
  path: string,
  method: "get" | "post" | "patch",
): (req: unknown, res: unknown) => Promise<void> {
  const layer = (router as unknown as { stack: any[] }).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.[method],
  );
  const handler = layer?.route?.stack?.[0]?.handle;
  if (!handler) throw new Error(`${method.toUpperCase()} ${path} handler not found`);
  return handler;
}

/** status / json を記録するレスポンスモックを生成する */
function makeCapturingRes() {
  const captured: { statusCode: number; jsonPayload: any } = {
    statusCode: 200,
    jsonPayload: undefined,
  };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.jsonPayload = payload;
      return this;
    },
  };
  return { res, captured };
}
