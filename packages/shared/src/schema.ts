import { z } from "zod";

const TaskDisplaySchema = z.enum(["bar", "summary", "milestone"]);
const DependencyTypeSchema = z.enum(["finish-to-start", "finish-to-finish", "start-to-start", "start-to-finish"]);
const ConflictStrategySchema = z.enum(["remote-wins", "local-wins", "manual"]);
const ViewScaleSchema = z.enum(["day", "week", "month", "quarter"]);

const TaskTypeSchema = z.object({
  label: z.string(),
  display: TaskDisplaySchema,
  color: z.string(),
  github_label: z.string().nullable(),
  github_field_value: z.string().nullable().optional(),
  default_collapsed: z.boolean().optional(),
});

const StatusValueSchema = z.object({
  color: z.string(),
  done: z.boolean(),
  starts_work: z.boolean().optional(),
});

const StatusesSchema = z.object({
  field_name: z.string(),
  values: z.record(StatusValueSchema),
});

const DependencySchema = z.object({
  task: z.string(),
  type: DependencyTypeSchema,
  lag: z.number(),
});

const TaskSchema = z.object({
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

export const ConfigSchema = z.object({
  version: z.string(),
  project: z.object({
    name: z.string(),
    github: z.object({
      owner: z.string(),
      repo: z.string(),
      project_number: z.number(),
    }),
  }),
  sync: z.object({
    conflict_strategy: ConflictStrategySchema,
    auto_create_issues: z.boolean(),
    field_mapping: z.object({
      start_date: z.string(),
      end_date: z.string(),
      status: z.string(),
      type: z.string().nullable().optional(),
    }),
  }),
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
});

export const TasksFileSchema = z.object({
  tasks: z.array(TaskSchema),
  cache: z.object({
    comments: z.record(z.array(z.object({
      author: z.string(),
      body: z.string(),
      created_at: z.string(),
    }))),
    reactions: z.record(z.record(z.number())),
  }),
});

export const SyncStateSchema = z.object({
  last_synced_at: z.string(),
  project_node_id: z.string(),
  id_map: z.record(z.object({
    issue_number: z.number(),
    issue_node_id: z.string(),
    project_item_id: z.string(),
  })),
  field_ids: z.record(z.string()),
  snapshots: z.record(z.object({
    hash: z.string(),
    synced_at: z.string(),
    updated_at: z.string().optional(),
    syncFields: z.object({
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
    }).optional(),
    remoteHash: z.string().optional(),
  })),
  option_ids: z.record(z.record(z.string())).optional(),
});

export { TaskSchema, DependencySchema, StatusesSchema };
