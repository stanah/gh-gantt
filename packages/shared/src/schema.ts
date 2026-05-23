import { z } from "zod";
import type {
  AcceptanceCriterion,
  CalendarHoliday,
  Config,
  Dependency,
  DoctorConfig,
  LinkedPullRequest,
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
  github_issue_type: z.string().nullable().optional(),
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

export const LinkedPullRequestSchema: z.ZodType<LinkedPullRequest> = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string().nullable(),
});

const LinkedPullRequestRefSchema = z.union([z.number(), LinkedPullRequestSchema]);

export const AcceptanceCriterionSchema: z.ZodType<AcceptanceCriterion> = z.object({
  description: z.string().trim().min(1),
  checked: z.boolean(),
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
  linked_prs: z.array(LinkedPullRequestRefSchema),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).default([]),
  acceptance_criteria_slot: z.boolean().default(false),
  implementer: z.string().nullable().default(null),
  reviewer: z.string().nullable().default(null),
  require_review: z.boolean().default(false),
  review_approved_by: z.string().nullable().default(null),
  review_approved_at: z.string().nullable().default(null),
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

const GroupingSchema = z.object({
  label_prefix: z.string().trim().min(1),
});

const TaskTemplatesSchema = z.object({
  path: z.string().trim().min(1),
  mapping: z.record(z.string().trim().min(1)).optional(),
});

const CalendarHolidaySchema: z.ZodType<CalendarHoliday> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().trim().min(1).optional(),
});

const DoctorConfigSchema: z.ZodType<DoctorConfig> = z.object({
  stale_in_progress_days: z.number().int().positive().optional(),
});

// `default_view` の z.preprocess が input 型を unknown に広げるため、
// Input 引数を unknown に明示して TS の input 型不整合を回避する。
export const ConfigSchema: z.ZodType<Config, z.ZodTypeDef, unknown> = z.object({
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
        estimate_hours: z.string().optional(),
      }),
    })
    .passthrough(),
  task_types: z.record(TaskTypeSchema),
  type_hierarchy: z.record(z.array(z.string())),
  statuses: StatusesSchema,
  gantt: z.object({
    default_view: z.preprocess((v) => (v === "day" ? "week" : v), ViewScaleSchema),
    working_days: z.array(z.number()),
    holidays: z.array(CalendarHolidaySchema).optional(),
    at_risk_threshold_days: z.number().int().positive().optional(),
    colors: z.object({
      critical_path: z.string(),
      on_track: z.string(),
      at_risk: z.string(),
      overdue: z.string(),
    }),
  }),
  grouping: GroupingSchema.optional(),
  sprints: z.array(SprintSchema).optional(),
  task_templates: TaskTemplatesSchema.optional(),
  doctor: DoctorConfigSchema.optional(),
  require_review_for_types: z.array(z.string().trim().min(1)).default([]),
  require_close_evidence: z.boolean().default(false),
  max_task_size_hours: z.number().positive().optional(),
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
  acceptance_criteria: z.array(AcceptanceCriterionSchema).optional(),
  acceptance_criteria_slot: z.boolean().optional(),
  implementer: z.string().nullable().optional(),
  reviewer: z.string().nullable().optional(),
  require_review: z.boolean().optional(),
  review_approved_by: z.string().nullable().optional(),
  review_approved_at: z.string().nullable().optional(),
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
