import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { z } from "zod";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import type { Config, SyncState, Task, StatusValue } from "@gh-gantt/shared";

const execFileAsync = promisify(execFile);
const DEFAULT_RECENT_DAYS = 7;
const DEFAULT_PR_LIMIT = 100;
const OPEN_PULL_REQUESTS_MAX_BUFFER = 10 * 1024 * 1024;
const PRIORITY_RANKS = new Map([
  ["critical", 0],
  ["high", 1],
  ["medium", 2],
  ["low", 3],
]);
const GhPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string().optional().default(""),
  url: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  reviewDecision: z.string().nullable().optional(),
  closingIssuesReferences: z
    .array(
      z.object({
        number: z.number().int(),
      }),
    )
    .optional()
    .default([]),
});
const GhPullRequestListSchema = z.array(GhPullRequestSchema);

export interface OpenPullRequestSummary {
  number: number;
  title: string;
  url: string | null;
  head_ref_name: string | null;
  updated_at: string | null;
  review_decision?: string | null;
  closing_issues: number[];
}

export interface ContextTaskSummary {
  id: string;
  issue: number | null;
  title: string;
  type: string;
  state: Task["state"];
  status: string | null;
  priority: string | null;
  assignees: string[];
  updated_at: string;
  start_date: string | null;
  end_date: string | null;
}

export interface BlockedTaskSummary extends ContextTaskSummary {
  blocked_by: Array<{
    id: string;
    issue: number | null;
    title: string | null;
    state: "open" | "missing";
  }>;
}

export interface RecommendedNextAction {
  kind: "continue_task" | "review_pr" | "resolve_blocker" | "start_task" | "sync";
  message: string;
  task_id?: string;
  pr_number?: number;
}

export interface ContextSummary {
  project: {
    name: string;
    owner: string;
    repo: string;
    project_number: number;
  };
  generated_at: string;
  last_synced_at: string;
  counts: {
    total_tasks: number;
    open_tasks: number;
    in_progress_tasks: number;
    open_pull_requests: number;
    blocked_tasks: number;
    recently_updated_tasks: number;
  };
  in_progress_tasks: ContextTaskSummary[];
  open_pull_requests: OpenPullRequestSummary[];
  recently_updated_tasks: ContextTaskSummary[];
  blocked_tasks: BlockedTaskSummary[];
  recommended_next_actions: RecommendedNextAction[];
  warnings: string[];
}

interface BuildContextSummaryInput {
  config: Config;
  tasks: Task[];
  syncState: SyncState;
  openPullRequests?: OpenPullRequestSummary[];
  now?: Date;
  recentDays?: number;
  warnings?: string[];
}

interface ContextCommandDeps {
  now?: () => Date;
  fetchOpenPullRequests?: (
    config: Config,
    options: { limit: number },
  ) => Promise<OpenPullRequestSummary[]>;
}

export function buildContextSummary(input: BuildContextSummaryInput): ContextSummary {
  const now = input.now ?? new Date();
  const recentDays = input.recentDays ?? DEFAULT_RECENT_DAYS;
  const generatedAt = now.toISOString();
  const taskMap = new Map(input.tasks.map((task) => [task.id, task]));
  const openPullRequests = [...(input.openPullRequests ?? [])].sort(comparePullRequestUpdatedDesc);
  const warnings = [...(input.warnings ?? [])];

  const inProgressTasks = input.tasks
    .filter((task) => task.state === "open" && isInProgressTask(task, input.config))
    .sort(compareTaskUpdatedDesc)
    .map((task) => summarizeTask(task, input.config));

  const recentCutoff = now.getTime() - recentDays * 24 * 60 * 60 * 1000;
  const recentlyUpdatedTasks = input.tasks
    .filter((task) => {
      const updatedAt = Date.parse(task.updated_at);
      return Number.isFinite(updatedAt) && updatedAt >= recentCutoff;
    })
    .sort(compareTaskUpdatedDesc)
    .slice(0, 10)
    .map((task) => summarizeTask(task, input.config));

  const blockedTasks = input.tasks
    .filter((task) => task.state === "open")
    .map((task) => summarizeBlockedTask(task, input.config, taskMap))
    .filter((task): task is BlockedTaskSummary => task.blocked_by.length > 0)
    .sort(compareSummaryEndDateThenUpdated);
  const blockedTaskIds = new Set(blockedTasks.map((task) => task.id));

  const nextStartTask = input.tasks
    .filter((task) => task.state === "open")
    .filter((task) => !isInProgressTask(task, input.config))
    .filter((task) => task.type !== "epic" && task.type !== "milestone")
    .filter((task) => !blockedTaskIds.has(task.id))
    .reduce<Task | null>((best, task) => {
      if (!best) return task;
      return compareCandidateTasks(task, best, input.config) < 0 ? task : best;
    }, null);

  const actions = buildRecommendedActions({
    inProgressTasks,
    openPullRequests,
    blockedTasks,
    nextStartTask: nextStartTask ? summarizeTask(nextStartTask, input.config) : null,
  });

  return {
    project: {
      name: input.config.project.name,
      owner: input.config.project.github.owner,
      repo: input.config.project.github.repo,
      project_number: input.config.project.github.project_number,
    },
    generated_at: generatedAt,
    last_synced_at: input.syncState.last_synced_at,
    counts: {
      total_tasks: input.tasks.length,
      open_tasks: input.tasks.filter((task) => task.state === "open").length,
      in_progress_tasks: inProgressTasks.length,
      open_pull_requests: openPullRequests.length,
      blocked_tasks: blockedTasks.length,
      recently_updated_tasks: recentlyUpdatedTasks.length,
    },
    in_progress_tasks: inProgressTasks,
    open_pull_requests: openPullRequests,
    recently_updated_tasks: recentlyUpdatedTasks,
    blocked_tasks: blockedTasks,
    recommended_next_actions: actions,
    warnings,
  };
}

export function createContextCommand(deps: ContextCommandDeps = {}): Command {
  return new Command("context")
    .description("Show a session-restoring project context summary")
    .option("--json", "Output as JSON")
    .option("--offline", "Skip live GitHub PR lookup")
    .option("--pr-limit <count>", "Maximum number of open PRs to fetch", String(DEFAULT_PR_LIMIT))
    .option(
      "--recent-days <days>",
      "Number of days for recent task activity",
      String(DEFAULT_RECENT_DAYS),
    )
    .action(async (opts) => {
      const projectRoot = process.cwd();
      const configStore = new ConfigStore(projectRoot);
      const tasksStore = new TasksStore(projectRoot);
      const stateStore = new SyncStateStore(projectRoot);

      const config = await configStore.read();
      const tasksFile = await tasksStore.read();
      const syncState = await stateStore.read();
      const warnings: string[] = [];
      const recentDays = parseRecentDays(opts.recentDays);
      const prLimit = parsePrLimit(opts.prLimit);

      let openPullRequests: OpenPullRequestSummary[] = [];
      if (opts.offline) {
        warnings.push("open PR の取得を --offline でスキップしました");
      } else {
        try {
          openPullRequests = await (deps.fetchOpenPullRequests ?? fetchOpenPullRequests)(config, {
            limit: prLimit,
          });
        } catch (err) {
          warnings.push(
            `open PR の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const summary = buildContextSummary({
        config,
        tasks: tasksFile.tasks,
        syncState,
        openPullRequests,
        now: deps.now?.() ?? new Date(),
        recentDays,
        warnings,
      });

      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(formatContextSummary(summary));
      }
    });
}

export const contextCommand = createContextCommand();

async function fetchOpenPullRequests(
  config: Config,
  options: { limit: number },
): Promise<OpenPullRequestSummary[]> {
  const { owner, repo } = config.project.github;
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${owner}/${repo}`,
      "--state",
      "open",
      "--limit",
      String(options.limit),
      "--json",
      "number,title,url,headRefName,updatedAt,closingIssuesReferences,reviewDecision",
    ],
    { timeout: 15000, maxBuffer: OPEN_PULL_REQUESTS_MAX_BUFFER },
  );
  return parseOpenPullRequestsJson(stdout);
}

export function parseOpenPullRequestsJson(stdout: string): OpenPullRequestSummary[] {
  const parsed = GhPullRequestListSchema.parse(JSON.parse(stdout));
  return parsed.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url ?? null,
    head_ref_name: pr.headRefName ?? null,
    updated_at: pr.updatedAt ?? null,
    review_decision: pr.reviewDecision ?? null,
    closing_issues: pr.closingIssuesReferences.map((issue) => issue.number),
  }));
}

function parseRecentDays(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_RECENT_DAYS);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_RECENT_DAYS;
  return parsed;
}

function parsePrLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PR_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PR_LIMIT;
  return parsed;
}

function summarizeTask(task: Task, config: Config): ContextTaskSummary {
  const status = readStatus(task, config);
  const priorityField = config.sync.field_mapping.priority;
  const priority =
    priorityField && task.custom_fields[priorityField] != null
      ? String(task.custom_fields[priorityField])
      : null;
  return {
    id: task.id,
    issue: task.github_issue,
    title: task.title,
    type: task.type,
    state: task.state,
    status,
    priority,
    assignees: task.assignees,
    updated_at: task.updated_at,
    start_date: task.start_date,
    end_date: task.end_date,
  };
}

function summarizeBlockedTask(
  task: Task,
  config: Config,
  taskMap: Map<string, Task>,
): BlockedTaskSummary {
  const unresolved: BlockedTaskSummary["blocked_by"] = [];
  for (const dep of task.blocked_by) {
    const blocker = taskMap.get(dep.task);
    if (!blocker) {
      unresolved.push({
        id: dep.task,
        issue: extractIssueNumber(dep.task),
        title: null,
        state: "missing",
      });
      continue;
    }
    if (blocker.state === "closed") continue;
    unresolved.push({
      id: blocker.id,
      issue: blocker.github_issue,
      title: blocker.title,
      state: blocker.state,
    });
  }

  return { ...summarizeTask(task, config), blocked_by: unresolved };
}

function buildRecommendedActions(input: {
  inProgressTasks: ContextTaskSummary[];
  openPullRequests: OpenPullRequestSummary[];
  blockedTasks: BlockedTaskSummary[];
  nextStartTask: ContextTaskSummary | null;
}): RecommendedNextAction[] {
  const actions: RecommendedNextAction[] = [];

  const firstInProgress = input.inProgressTasks[0];
  if (firstInProgress) {
    actions.push({
      kind: "continue_task",
      task_id: firstInProgress.id,
      message: `作業中の ${formatIssue(firstInProgress)} ${firstInProgress.title} を続行する`,
    });
  }

  const firstPr = input.openPullRequests[0];
  if (firstPr) {
    actions.push({
      kind: "review_pr",
      pr_number: firstPr.number,
      message: `open PR #${firstPr.number} ${firstPr.title} の状態を確認する`,
    });
  }

  const firstBlocked = input.blockedTasks[0];
  if (firstBlocked) {
    actions.push({
      kind: "resolve_blocker",
      task_id: firstBlocked.id,
      message: `${formatIssue(firstBlocked)} ${firstBlocked.title} のブロッカーを確認する`,
    });
  }

  if (input.nextStartTask) {
    actions.push({
      kind: "start_task",
      task_id: input.nextStartTask.id,
      message: `次に ${formatIssue(input.nextStartTask)} ${input.nextStartTask.title} に着手する`,
    });
  }

  if (actions.length === 0) {
    actions.push({ kind: "sync", message: "gh-gantt pull/status/list で最新状態を確認する" });
  }

  return actions;
}

function isInProgressTask(task: Task, config: Config): boolean {
  const statusName = readStatus(task, config);
  if (!statusName) return false;
  const status = config.statuses.values[statusName];
  if (!status) return isKnownWorkStatusName(statusName);
  return isWorkStatus(status);
}

function isWorkStatus(status: StatusValue): boolean {
  if (status.done) return false;
  return (
    status.starts_work === true ||
    status.category === "in_progress" ||
    status.category === "in_review"
  );
}

function isKnownWorkStatusName(statusName: string): boolean {
  const normalized = statusName.toLowerCase();
  return normalized === "in progress" || normalized === "in review" || normalized === "active";
}

function readStatus(task: Task, config: Config): string | null {
  const value = task.custom_fields[config.statuses.field_name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compareTaskUpdatedDesc(a: Task, b: Task): number {
  return compareTimestampDesc(a.updated_at, b.updated_at);
}

function compareSummaryEndDateThenUpdated(a: ContextTaskSummary, b: ContextTaskSummary): number {
  const dateCompare = compareNullableDate(a.end_date, b.end_date);
  if (dateCompare !== 0) return dateCompare;
  return compareTimestampDesc(a.updated_at, b.updated_at);
}

function compareCandidateTasks(a: Task, b: Task, config: Config): number {
  const dateCompare = compareNullableDate(a.end_date, b.end_date);
  if (dateCompare !== 0) return dateCompare;
  const priorityCompare = comparePriority(a, b, config);
  if (priorityCompare !== 0) return priorityCompare;
  return compareTimestampDesc(a.updated_at, b.updated_at);
}

function compareNullableDate(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function compareTimestampDesc(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return bTime - aTime;
}

function comparePullRequestUpdatedDesc(
  a: OpenPullRequestSummary,
  b: OpenPullRequestSummary,
): number {
  return compareNullableTimestampDesc(a.updated_at, b.updated_at);
}

function compareNullableTimestampDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareTimestampDesc(a, b);
}

function comparePriority(a: Task, b: Task, config: Config): number {
  const priorityField = config.sync.field_mapping.priority;
  if (!priorityField) return 0;
  const aRank =
    PRIORITY_RANKS.get(String(a.custom_fields[priorityField] ?? "").toLowerCase()) ?? 99;
  const bRank =
    PRIORITY_RANKS.get(String(b.custom_fields[priorityField] ?? "").toLowerCase()) ?? 99;
  return aRank - bRank;
}

function formatContextSummary(summary: ContextSummary): string {
  const lines = [
    `Project: ${summary.project.name} (${summary.project.owner}/${summary.project.repo}#${summary.project.project_number})`,
    `Generated: ${summary.generated_at}`,
    `Last synced: ${summary.last_synced_at}`,
    "",
    `In progress (${summary.in_progress_tasks.length}):`,
    ...formatTaskList(summary.in_progress_tasks),
    "",
    `Open PRs (${summary.open_pull_requests.length}):`,
    ...formatPrList(summary.open_pull_requests),
    "",
    `Recent updates (${summary.recently_updated_tasks.length}):`,
    ...formatTaskList(summary.recently_updated_tasks),
    "",
    `Blockers (${summary.blocked_tasks.length}):`,
    ...formatBlockedTaskList(summary.blocked_tasks),
    "",
    "Recommended next actions:",
    ...summary.recommended_next_actions.map((action, index) => `  ${index + 1}. ${action.message}`),
  ];

  if (summary.warnings.length > 0) {
    lines.push("", "Warnings:", ...summary.warnings.map((warning) => `  - ${warning}`));
  }

  return lines.join("\n");
}

function formatTaskList(tasks: ContextTaskSummary[]): string[] {
  if (tasks.length === 0) return ["  - none"];
  return tasks.map((task) => {
    const status = task.status ? ` [${task.status}]` : "";
    return `  - ${formatIssue(task)} ${task.title}${status} updated=${task.updated_at}`;
  });
}

function formatPrList(prs: OpenPullRequestSummary[]): string[] {
  if (prs.length === 0) return ["  - none"];
  return prs.map((pr) => {
    const closes =
      pr.closing_issues.length > 0
        ? ` closes=${pr.closing_issues.map((n) => `#${n}`).join(",")}`
        : "";
    return `  - #${pr.number} ${pr.title}${closes}`;
  });
}

function formatBlockedTaskList(tasks: BlockedTaskSummary[]): string[] {
  if (tasks.length === 0) return ["  - none"];
  return tasks.map((task) => {
    const blockers = task.blocked_by
      .map((dep) => `${dep.issue ? `#${dep.issue}` : dep.id}(${dep.state})`)
      .join(", ");
    return `  - ${formatIssue(task)} ${task.title}: ${blockers}`;
  });
}

function formatIssue(task: ContextTaskSummary): string {
  return task.issue ? `#${task.issue}` : task.id;
}

function extractIssueNumber(id: string): number | null {
  const match = id.match(/#(\d+)$/);
  if (!match) return null;
  const issue = Number(match[1]);
  return Number.isInteger(issue) ? issue : null;
}
