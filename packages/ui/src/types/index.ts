import type { ViewScale } from "@gh-gantt/shared";

export interface TaskType {
  label: string;
  display: "bar" | "summary" | "milestone";
  color: string;
  github_label: string | null;
  default_collapsed?: boolean;
}

export type StatusCategory = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done";

export interface StatusValue {
  color: string;
  done: boolean;
  category?: StatusCategory;
}

export interface Dependency {
  task: string;
  type: "finish-to-start" | "finish-to-finish" | "start-to-start" | "start-to-finish";
  lag: number;
}

export interface LinkedPullRequest {
  number: number;
  title: string;
  state: string;
  url: string | null;
}

export type LinkedPullRequestRef = number | LinkedPullRequest;

export interface AcceptanceCriterion {
  description: string;
  checked: boolean;
}

export interface Task {
  id: string;
  type: string;
  github_issue: number | null;
  github_repo: string;
  parent: string | null;
  sub_tasks: string[];
  title: string;
  body: string | null;
  acceptance_criteria?: AcceptanceCriterion[];
  acceptance_criteria_slot?: boolean;
  implementer?: string | null;
  reviewer?: string | null;
  require_review?: boolean;
  review_approved_by?: string | null;
  review_approved_at?: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  linked_prs: LinkedPullRequestRef[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  custom_fields: Record<string, unknown>;
  start_date: string | null;
  end_date: string | null;
  date: string | null;
  blocked_by: Dependency[];
  _progress?: number;
}

export interface SprintConfig {
  name: string;
  start_date: string;
  end_date: string;
  color: string;
}

export interface GroupingFacet {
  key: string;
  label: string;
  label_prefix: string;
}

export interface GroupingConfig {
  label_prefix?: string;
  facets?: GroupingFacet[];
}

export interface CalendarHoliday {
  date: string;
  name?: string;
}

export interface Config {
  version: string;
  project: {
    name: string;
    github: { owner: string; repo: string; project_number: number };
  };
  sync: {
    auto_create_issues: boolean;
    field_mapping: {
      start_date: string;
      end_date: string;
      status: string;
      priority?: string;
      estimate_hours?: string;
    };
  };
  task_types: Record<string, TaskType>;
  type_hierarchy: Record<string, string[]>;
  statuses: {
    field_name: string;
    values: Record<string, StatusValue>;
  };
  gantt: {
    default_view: ViewScale;
    working_days: number[];
    holidays?: CalendarHoliday[];
    at_risk_threshold_days?: number;
    colors: { critical_path: string; on_track: string; at_risk: string; overdue: string };
  };
  grouping?: GroupingConfig;
  sprints?: SprintConfig[];
  require_review_for_types?: string[];
  require_close_evidence?: boolean;
  max_task_size_hours?: number;
}

export interface TasksResponse {
  tasks: Task[];
  cache: {
    comments: Record<string, Array<{ author: string; body: string; created_at: string }>>;
    reactions: Record<string, Record<string, number>>;
  };
}
