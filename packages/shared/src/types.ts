export type TaskDisplay = "bar" | "summary" | "milestone";
export type DependencyType = "finish-to-start" | "finish-to-finish" | "start-to-start" | "start-to-finish";
export type ConflictStrategy = "remote-wins" | "local-wins" | "manual";
export type ViewScale = "day" | "week" | "month" | "quarter";

export interface TaskType {
  label: string;
  display: TaskDisplay;
  color: string;
  github_label: string | null;
  github_field_value?: string | null;
  default_collapsed?: boolean;
}

export interface StatusValue {
  color: string;
  done: boolean;
}

export interface Statuses {
  field_name: string;
  values: Record<string, StatusValue>;
}

export interface Dependency {
  task: string;
  type: DependencyType;
  lag: number;
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
  state: "open" | "closed";
  state_reason: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  linked_prs: number[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;

  custom_fields: Record<string, unknown>;

  start_date: string | null;
  end_date: string | null;
  date: string | null;
  blocked_by: Dependency[];
}

export interface TasksFile {
  tasks: Task[];
  cache: {
    comments: Record<string, Array<{ author: string; body: string; created_at: string }>>;
    reactions: Record<string, Record<string, number>>;
  };
}

export interface GithubConfig {
  owner: string;
  repo: string;
  project_number: number;
}

export interface SyncConfig {
  conflict_strategy: ConflictStrategy;
  auto_create_issues: boolean;
  field_mapping: {
    start_date: string;
    end_date: string;
    status: string;
    type?: string | null;
  };
}

export interface GanttColors {
  critical_path: string;
  on_track: string;
  at_risk: string;
  overdue: string;
}

export interface GanttConfig {
  default_view: ViewScale;
  working_days: number[];
  colors: GanttColors;
}

export interface Config {
  version: string;
  project: {
    name: string;
    github: GithubConfig;
  };
  sync: SyncConfig;
  task_types: Record<string, TaskType>;
  type_hierarchy: Record<string, string[]>;
  statuses: Statuses;
  gantt: GanttConfig;
}

export interface IdMapping {
  issue_number: number;
  issue_node_id: string;
  project_item_id: string;
}

export interface Snapshot {
  hash: string;
  synced_at: string;
}

export interface SyncState {
  last_synced_at: string;
  project_node_id: string;
  id_map: Record<string, IdMapping>;
  field_ids: Record<string, string>;
  snapshots: Record<string, Snapshot>;
  option_ids?: Record<string, Record<string, string>>;
}
