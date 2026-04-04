import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

import {
  ConfigSchema,
  TaskSchema,
  TasksFileSchema,
  DependencySchema,
  StatusesSchema,
} from "@gh-gantt/shared";

export const registry = new OpenAPIRegistry();

registry.register("Task", TaskSchema);
registry.register("Config", ConfigSchema);
registry.register("Dependency", DependencySchema);
registry.register("Statuses", StatusesSchema);

const TaskCreateRequestSchema = z.object({
  title: z.string(),
  type: z.string(),
  body: z.string().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
});
registry.register("TaskCreateRequest", TaskCreateRequestSchema);

const TaskUpdateRequestSchema = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]).optional(),
  state_reason: z.string().nullable().optional(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  milestone: z.string().nullable().optional(),
  custom_fields: z.record(z.unknown()).optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  sub_tasks: z.array(z.string()).optional(),
  blocked_by: z.array(DependencySchema).optional(),
});
registry.register("TaskUpdateRequest", TaskUpdateRequestSchema);

const ReparentRequestSchema = z.object({
  newParentId: z.string().nullable(),
});
registry.register("ReparentRequest", ReparentRequestSchema);

const SyncStatusResponseSchema = z.object({
  last_synced_at: z.string(),
  local_changes: z.number(),
  total_tasks: z.number(),
});
registry.register("SyncStatusResponse", SyncStatusResponseSchema);

const PushRequestSchema = z.object({
  dry_run: z.boolean().optional(),
  force: z.boolean().optional(),
});
registry.register("PushRequest", PushRequestSchema);

const ErrorResponseSchema = z.object({
  error: z.string(),
});
registry.register("ErrorResponse", ErrorResponseSchema);

registry.registerPath({
  method: "get",
  path: "/api/config",
  summary: "設定を取得",
  responses: {
    200: {
      description: "Config オブジェクト",
      content: { "application/json": { schema: ConfigSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/tasks",
  summary: "タスク一覧を取得",
  responses: {
    200: {
      description: "タスク一覧 (進捗情報付き)",
      content: { "application/json": { schema: TasksFileSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/tasks",
  summary: "ドラフトタスクを作成",
  request: {
    body: {
      content: { "application/json": { schema: TaskCreateRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "作成されたタスク",
      content: { "application/json": { schema: TaskSchema } },
    },
    400: {
      description: "バリデーションエラー",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/tasks/{id}",
  summary: "タスクを更新",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: TaskUpdateRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "更新されたタスク",
      content: { "application/json": { schema: TaskSchema } },
    },
    404: {
      description: "タスクが見つからない",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/tasks/{id}/reparent",
  summary: "タスクの親を変更",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: ReparentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "更新後のタスク一覧",
      content: { "application/json": { schema: TasksFileSchema } },
    },
    400: {
      description: "循環参照・階層違反",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/sync/pull",
  summary: "GitHub からローカルに同期",
  responses: {
    200: {
      description: "同期結果",
      content: {
        "application/json": {
          schema: z.object({
            added: z.number(),
            updated: z.number(),
            removed: z.number(),
            conflicts: z.number(),
          }),
        },
      },
    },
    409: {
      description: "未解決コンフリクトあり",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/sync/push",
  summary: "ローカルから GitHub に同期",
  request: {
    body: {
      content: { "application/json": { schema: PushRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "push 結果",
      content: {
        "application/json": {
          schema: z.object({}),
        },
      },
    },
    409: {
      description: "未解決コンフリクトあり",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/sync/status",
  summary: "同期ステータスを取得",
  responses: {
    200: {
      description: "同期ステータス",
      content: {
        "application/json": { schema: SyncStatusResponseSchema },
      },
    },
  },
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "gh-gantt REST API",
      version: "0.1.0",
      description: "GitHub Projects (V2) と双方向同期するガントチャート CLI の REST API",
    },
  });
}
