import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

import { ConfigSchema, TaskSchema, DependencySchema, StatusesSchema } from "@gh-gantt/shared";

export const registry = new OpenAPIRegistry();

registry.register("Task", TaskSchema);
registry.register("Config", ConfigSchema);
registry.register("Dependency", DependencySchema);
registry.register("Statuses", StatusesSchema);

const TaskCreateRequestSchema = z.object({
  title: z.string(),
  type: z.string(),
  body: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  parent: z.string().nullable().optional().openapi({
    description:
      "親タスク参照。draft-1 / 293 / #293 などの短縮形は正規形 (owner/repo#N / owner/repo#draft-N) に解決して保存される。存在しないタスクを指す場合は 400 を返す",
  }),
});
registry.register("TaskCreateRequest", TaskCreateRequestSchema);

const TaskUpdateRequestSchema = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  type: z.string().optional(),
  state: z.enum(["open", "closed"]).optional(),
  state_reason: z.string().nullable().optional(),
  assignees: z.array(z.string()).optional(),
  implementer: z.string().nullable().optional(),
  reviewer: z.string().nullable().optional(),
  require_review: z.boolean().optional(),
  review_approved_by: z.string().nullable().optional(),
  review_approved_at: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  milestone: z.string().nullable().optional(),
  custom_fields: z.record(z.unknown()).optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  parent: z.string().nullable().optional().openapi({
    description:
      "親タスク参照。短縮形は正規形に解決して保存される。存在しないタスクを指す場合は 400 を返す",
  }),
  sub_tasks: z.array(z.string()).optional(),
  blocked_by: z.array(DependencySchema).optional(),
});
registry.register("TaskUpdateRequest", TaskUpdateRequestSchema);

const ReparentRequestSchema = z.object({
  newParentId: z.string().nullable().openapi({
    description: "新しい親タスク参照 (null で親を外す)。短縮形は正規形に解決してから存在検証される",
  }),
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
  code: z.string().optional(),
});
registry.register("ErrorResponse", ErrorResponseSchema);

const ConflictResponseSchema = z.object({
  message: z.string(),
});
registry.register("ConflictResponse", ConflictResponseSchema);

const TaskWithProgressSchema = TaskSchema.and(z.object({ _progress: z.number() }));

const TasksWithProgressResponseSchema = z.object({
  tasks: z.array(TaskWithProgressSchema),
  cache: z.object({
    comments: z.record(
      z.array(z.object({ author: z.string(), body: z.string(), created_at: z.string() })),
    ),
    reactions: z.record(z.record(z.number())),
  }),
});
registry.register("TasksWithProgressResponse", TasksWithProgressResponseSchema);

const ReparentResponseSchema = z.object({
  tasks: z.array(TaskSchema),
});
registry.register("ReparentResponse", ReparentResponseSchema);

const PushResultSchema = z.object({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  message: z.string().optional(),
});
registry.register("PushResult", PushResultSchema);

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
      content: { "application/json": { schema: TasksWithProgressResponseSchema } },
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
    400: {
      description: "バリデーションエラー (存在しない parent 参照を含む)",
      content: { "application/json": { schema: ErrorResponseSchema } },
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
      content: { "application/json": { schema: ReparentResponseSchema } },
    },
    400: {
      description: "自己参照・循環参照・階層違反・不正な newParentId",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "対象タスクまたは新しい親タスクが存在しない",
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
      content: { "application/json": { schema: ConflictResponseSchema } },
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
          schema: PushResultSchema,
        },
      },
    },
    409: {
      description: "未解決コンフリクトあり",
      content: { "application/json": { schema: ConflictResponseSchema } },
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
