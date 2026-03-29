import { z } from "zod";
import type {
  Config,
  Dependency,
  SprintConfig,
  Statuses,
  SyncFields,
  SyncState,
  Task,
  TasksFile,
} from "./types.js";

const TaskDisplaySchema = z.enum(["bar", "summary", "milestone"]);
const DependencyTypeSchema = z.enum([
  "finish-to-start",
  "finish-to-finish",
  "start-to-start",
  "start-to-finish",
]);
const ViewScaleSchema = z.enum(["week", "month", "quarter", "year"]);

const TaskTypeSchema = z.object({
  label: z.string(),
  display: TaskDisplaySchema,
  color: z.string(),
  github_label: z.string().nullable(),
  github_field_value: z.string().nullable().optional(),
  default_collapsed: z.boolean().optional(),
});

const StatusCategorySchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
]);

const StatusValueSchema = z.object({
  color: z.string(),
  done: z.boolean(),
  starts_work: z.boolean().optional(),
  category: StatusCategorySchema.optional(),
});

export const StatusesSchema: z.ZodType<Statuses> = z.object({
  field_name: z.string(),
  values: z.record(StatusValueSchema),
});

export const DependencySchema: z.ZodType<Dependency> = z.object({
  task: z.string(),
  type: DependencyTypeSchema,
  lag: z.number(),
});

const TaskSchemaObject = z.object({
  id: z.string(),
  type: z.string(),
  github_issue: z.number().nullable(),
  github_repo: z.string(),
  parent: z.string().nullable(),
  sub_tasks: z.array(z.string()),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable(),
  assignees: z.array(z.string()),
  labels: z.array(z.string()),
  milestone: z.string().nullable(),
  linked_prs: z.array(z.number()),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  custom_fields: z.record(z.unknown()),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  date: z.string().nullable(),
  blocked_by: z.array(DependencySchema),
});

export const TaskSchema: z.ZodType<Task> = TaskSchemaObject;

export const SprintSchema: z.ZodType<SprintConfig> = z.object({
  name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  color: z.string(),
});

const TaskTemplatesSchema = z.object({
  path: z.string().trim().min(1),
  mapping: z.record(z.string().trim().min(1)).optional(),
});

export const ConfigSchema: z.ZodType<Config> = z.object({
  version: z.string(),
  project: z.object({
    name: z.string(),
    github: z.object({
      owner: z.string(),
      repo: z.string(),
      project_number: z.number(),
    }),
  }),
  sync: z
    .object({
      auto_create_issues: z.boolean(),
      field_mapping: z.object({
        start_date: z.string(),
        end_date: z.string(),
        status: z.string(),
        type: z.string().nullable().optional(),
        priority: z.string().optional(),
      }),
    })
    .passthrough(),
  task_types: z.record(TaskTypeSchema),
  type_hierarchy: z.record(z.array(z.string())),
  statuses: StatusesSchema,
  gantt: z.object({
    default_view: ViewScaleSchema,
    working_days: z.array(z.number()),
    colors: z.object({
      critical_path: z.string(),
      on_track: z.string(),
      at_risk: z.string(),
      overdue: z.string(),
    }),
  }),
  sprints: z.array(SprintSchema).optional(),
  task_templates: TaskTemplatesSchema.optional(),
});

export const TasksFileSchema: z.ZodType<TasksFile> = z.object({
  tasks: z.array(TaskSchema),
  cache: z.object({
    comments: z.record(
      z.array(
        z.object({
          author: z.string(),
          body: z.string(),
          created_at: z.string(),
        }),
      ),
    ),
    reactions: z.record(z.record(z.number())),
  }),
  has_conflicts: z.boolean().optional(),
});

export const TasksFileWithConflictsSchema: z.ZodType<TasksFile> = z.object({
  tasks: z.array(TaskSchemaObject.passthrough()),
  cache: z.object({
    comments: z.record(
      z.array(
        z.object({
          author: z.string(),
          body: z.string(),
          created_at: z.string(),
        }),
      ),
    ),
    reactions: z.record(z.record(z.number())),
  }),
  has_conflicts: z.boolean().optional(),
});

export const SyncFieldsSchema: z.ZodType<SyncFields> = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  type: z.string(),
  assignees: z.array(z.string()),
  labels: z.array(z.string()),
  milestone: z.string().nullable(),
  custom_fields: z.record(z.unknown()),
  parent: z.string().nullable(),
  sub_tasks: z.array(z.string()),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  date: z.string().nullable(),
  blocked_by: z.array(DependencySchema),
});

export const SyncStateSchema: z.ZodType<SyncState> = z.object({
  last_synced_at: z.string(),
  project_node_id: z.string(),
  id_map: z.record(
    z.object({
      issue_number: z.number(),
      issue_node_id: z.string(),
      project_item_id: z.string(),
    }),
  ),
  field_ids: z.record(z.string()),
  snapshots: z.record(
    z.object({
      hash: z.string(),
      synced_at: z.string(),
      updated_at: z.string().optional(),
      syncFields: SyncFieldsSchema.optional(),
      remoteHash: z.string().optional(),
    }),
  ),
  option_ids: z.record(z.record(z.string())).optional(),
});
