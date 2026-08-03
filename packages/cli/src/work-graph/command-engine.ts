import {
  detectCycles,
  computeStatusDateUpdates,
  mutationCommandFingerprint,
  normalizeAcceptanceCriteria,
  normalizeTaskRoleLogin,
  serializeTaskCloseEvidenceBody,
  type Config,
  type MutationPrimitiveStep,
  type MutationTaskDiff,
  type Task,
  type WorkGraphMutationIntent,
} from "@gh-gantt/shared";
import {
  createMutationRemoteProjection,
  mutationRemoteBeforeProjection,
} from "../sync/mutation-remote-projection.js";

export type WorkGraphCommandErrorCode =
  | "invalid_command"
  | "task_not_found"
  | "invalid_task_type"
  | "invalid_hierarchy"
  | "dangling_reference"
  | "dependency_cycle"
  | "scope_drift"
  | "review_gate"
  | "acceptance_criteria_gate"
  | "human_gate_required"
  | "invalid_recovery"
  | "invalid_reorder";

export type DirectWorkGraphCommand =
  | {
      type: "create";
      tasks: Task[];
      task: Task;
    }
  | { type: "update"; tasks: Task[]; taskId: string; updates: WorkGraphTaskUpdate }
  | {
      type: "link";
      tasks: Task[];
      taskId: string;
      operations: Array<
        | { kind: "add_dependency"; blockerTaskId: string }
        | { kind: "remove_dependency"; blockerTaskId: string; rawInput?: string }
        | { kind: "set_parent"; parentTaskId: string }
        | { kind: "remove_parent" }
      >;
    }
  | { type: "hard_delete_plan"; deletedTaskId: string; tasks: Task[] }
  | { type: "hard_delete_reconciliation"; deletedTaskId: string; tasks: Task[] }
  | { type: "proposal_v1_hard_delete"; targetTaskId: string }
  | {
      type: "proposal_intent";
      tasks: Task[];
      intent: WorkGraphMutationIntent;
      scopeRootTaskId?: string;
    };

export interface DirectWorkGraphPlan {
  operation: "create" | "update" | "link" | "hard_delete_plan" | "hard_delete_reconciliation";
  tasks: Task[];
  affectedTaskIds: string[];
  primitives: Array<{
    operation: "create" | "update" | "link" | "delete";
    targetTaskId: string;
    before: Task | null;
    after: Task | null;
  }>;
}

export interface WorkGraphTaskUpdate {
  title?: string;
  body?: string;
  type?: string;
  state?: "open" | "closed";
  status?: string;
  priority?: string;
  startDate?: string;
  endDate?: string;
  assignee?: string;
  removeAssignee?: string;
  assignImplementer?: string;
  assignReviewer?: string;
  requireReview?: boolean;
  approveReview?: string;
  clearReviewApproval?: boolean;
  evidence?: string;
  milestone?: string;
  label?: string;
  removeLabel?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRoleOption(
  optionName: "--assign-implementer" | "--assign-reviewer" | "--approve-review",
  value: string,
): { value: string | null; error?: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { value: null, error: `${optionName} requires a GitHub login or "none".` };
  }
  if (trimmed.toLowerCase() === "none") return { value: null };
  const normalized = normalizeTaskRoleLogin(trimmed);
  return normalized
    ? { value: normalized }
    : { value: null, error: `${optionName} requires a GitHub login or "none".` };
}

function sameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return left == null && right == null;
  return left.toLowerCase() === right.toLowerCase();
}

export type WorkGraphCommandResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: WorkGraphCommandErrorCode; error: string };

export interface WorkGraphMutationPlan {
  operation?: "proposal_intent";
  tasks: Task[];
  targetTaskIds: string[];
  steps: MutationPrimitiveStep[];
  diff: MutationTaskDiff[];
  affectedUpstream: string[];
  affectedDownstream: string[];
  risk: "low" | "medium" | "high" | "destructive";
}

export interface WorkGraphCommandEngineDependencies {
  now?: () => string;
}

export interface CancelRecovery {
  kind: "reopen_cancelled_task";
  beforeFingerprint: string;
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    acceptance_criteria: task.acceptance_criteria?.map((item) => ({ ...item })),
    assignees: [...task.assignees],
    labels: [...task.labels],
    linked_prs: [...task.linked_prs],
    custom_fields: { ...task.custom_fields },
    sub_tasks: [...task.sub_tasks],
    blocked_by: task.blocked_by.map((dependency) => ({ ...dependency })),
  };
}

/** CLI adapterとEngineが共有する依存関係projection。 */
export function projectDependencyChange(
  task: Task,
  operation:
    | { kind: "add_dependency"; blockerTaskId: string }
    | { kind: "remove_dependency"; blockerTaskId: string; rawInput?: string },
  now = new Date().toISOString(),
): WorkGraphCommandResult<{ task: Task }> {
  const projected = cloneTask(task);
  if (operation.kind === "add_dependency") {
    if (operation.blockerTaskId === task.id) {
      return {
        ok: false,
        code: "dependency_cycle",
        error: "A task cannot be blocked by itself.",
      };
    }
    if (!projected.blocked_by.some((item) => item.task === operation.blockerTaskId)) {
      projected.blocked_by.push({
        task: operation.blockerTaskId,
        type: "finish-to-start",
        lag: 0,
      });
    }
  } else {
    const keys = new Set([operation.blockerTaskId]);
    if (operation.rawInput) {
      keys.add(operation.rawInput);
      if (operation.rawInput.startsWith("#")) keys.add(operation.rawInput.slice(1));
    }
    projected.blocked_by = projected.blocked_by.filter((item) => !keys.has(item.task));
  }
  projected.updated_at = now;
  return { ok: true, task: projected };
}

/** CLI adapterとEngineが共有するparent projection。 */
export function projectParentChange(
  tasks: Task[],
  taskId: string,
  operation: { kind: "set_parent"; parentTaskId: string } | { kind: "remove_parent" },
  now = new Date().toISOString(),
): WorkGraphCommandResult<{ tasks: Task[] }> {
  const projected = tasks.map(cloneTask);
  const target = projected.find((task) => task.id === taskId);
  if (!target) return { ok: false, code: "task_not_found", error: `Task not found: ${taskId}` };
  if (operation.kind === "set_parent") {
    if (operation.parentTaskId === target.id) {
      return {
        ok: false,
        code: "invalid_hierarchy",
        error: "A task cannot be its own parent.",
      };
    }
    const parent = projected.find((task) => task.id === operation.parentTaskId);
    if (!parent) {
      return {
        ok: false,
        code: "task_not_found",
        error: `Parent task not found: ${operation.parentTaskId}`,
      };
    }
    let ancestor: Task | undefined = parent;
    const visited = new Set<string>();
    while (ancestor) {
      if (ancestor.id === target.id) {
        return {
          ok: false,
          code: "invalid_hierarchy",
          error: `parent cycle が発生します: ${target.id}`,
        };
      }
      if (!ancestor.parent || visited.has(ancestor.parent)) break;
      visited.add(ancestor.parent);
      ancestor = projected.find((task) => task.id === ancestor!.parent);
    }
    for (const task of projected) {
      if (task.sub_tasks.includes(target.id) && task.id !== parent.id) {
        task.sub_tasks = task.sub_tasks.filter((id) => id !== target.id);
      }
    }
    target.parent = parent.id;
    target.updated_at = now;
    if (!parent.sub_tasks.includes(target.id)) parent.sub_tasks.push(target.id);
  } else {
    const oldParent = target.parent;
    target.parent = null;
    target.updated_at = now;
    if (oldParent) {
      const parent = projected.find((task) => task.id === oldParent);
      if (parent) {
        parent.sub_tasks = parent.sub_tasks.filter((id) => id !== target.id);
        parent.updated_at = now;
      }
    }
  }
  return { ok: true, tasks: projected };
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((item) => right.includes(item))
  );
}

function primitive(
  index: number,
  operation: MutationPrimitiveStep["operation"],
  targetTaskId: string,
  payload: Record<string, unknown>,
  beforeImage: Record<string, unknown> | null,
  expectedPostcondition: Record<string, unknown>,
  recovery: CancelRecovery | null = null,
): MutationPrimitiveStep {
  return {
    stepId: `step-${String(index + 1).padStart(4, "0")}`,
    operation,
    targetTaskId,
    payload,
    beforeImage,
    expectedPostcondition,
    state: "not_started",
    diagnostic: null,
    remoteIdentifiers: null,
    // proposalId/plan fingerprintはcontrol planeで確定後にbindする。
    correlationToken: null,
    recoveryIntent: recovery,
  };
}

function taskProjection(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    type: task.type,
    github_repo: task.github_repo,
    parent: task.parent,
    sub_tasks: task.sub_tasks,
    title: task.title,
    body: task.body,
    state: task.state,
    state_reason: task.state_reason,
    blocked_by: task.blocked_by,
  };
}

function changedDiff(before: Task[], after: Task[]): MutationTaskDiff[] {
  const beforeMap = new Map(before.map((task) => [task.id, task]));
  const afterMap = new Map(after.map((task) => [task.id, task]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort().flatMap((taskId) => {
    const left = beforeMap.get(taskId);
    const right = afterMap.get(taskId);
    const leftProjection = left ? taskProjection(left) : null;
    const rightProjection = right ? taskProjection(right) : null;
    if (JSON.stringify(leftProjection) === JSON.stringify(rightProjection)) return [];
    return [{ taskId, before: leftProjection, after: rightProjection }];
  });
}

function descendants(tasks: Task[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const task = tasks.find((item) => item.id === current);
    for (const child of task?.sub_tasks ?? []) {
      if (result.has(child)) continue;
      result.add(child);
      queue.push(child);
    }
  }
  return result;
}

/** mutation対象からrootまでのparent lineageを、予約・Run invalidation対象へ閉じる。 */
function ancestorClosure(tasks: Task[], targetIds: Iterable<string>): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const result = new Set<string>();
  for (const targetId of targetIds) {
    let current = byId.get(targetId);
    const visited = new Set<string>();
    while (current?.parent) {
      if (visited.has(current.parent)) break;
      visited.add(current.parent);
      result.add(current.parent);
      current = byId.get(current.parent);
    }
  }
  return result;
}

function impact(tasks: Task[], targetIds: string[]): { upstream: string[]; downstream: string[] } {
  const targets = new Set(targetIds);
  const upstream = new Set<string>();
  const downstream = new Set<string>();
  const reverse = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.blocked_by) {
      reverse.set(dependency.task, [...(reverse.get(dependency.task) ?? []), task.id]);
    }
  }
  const visit = (seed: string[], direction: "upstream" | "downstream") => {
    const queue = [...seed];
    const seen = new Set(seed);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const next =
        direction === "upstream"
          ? (tasks.find((task) => task.id === current)?.blocked_by.map((item) => item.task) ?? [])
          : (reverse.get(current) ?? []);
      for (const item of next) {
        if (seen.has(item)) continue;
        seen.add(item);
        if (!targets.has(item)) (direction === "upstream" ? upstream : downstream).add(item);
        queue.push(item);
      }
    }
  };
  visit(targetIds, "upstream");
  visit(targetIds, "downstream");
  return { upstream: [...upstream].sort(), downstream: [...downstream].sort() };
}

/**
 * Work Graphの全mutationをvalidation・planning・primitive executionへ閉じ込める深いModule。
 * CLIとproposal control planeはこの入口を共有し、CommanderやGraphQLを相互に呼び出さない。
 */
export class WorkGraphCommandEngine {
  private readonly now: () => string;

  constructor(
    private readonly config: Config,
    dependencies: WorkGraphCommandEngineDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /** direct CLI updateの入力からprojectionを作り、proposalと同じgateへ渡す。 */
  projectTaskUpdate(
    task: Task,
    updates: WorkGraphTaskUpdate,
  ): WorkGraphCommandResult<{ task: Task }> {
    if (!Object.values(updates).some((value) => value !== undefined)) {
      return { ok: false, code: "invalid_recovery", error: "Specify at least one update option." };
    }
    if (updates.type && !this.config.task_types[updates.type]) {
      return {
        ok: false,
        code: "invalid_task_type",
        error: `Unknown task type: "${updates.type}". Available: ${Object.keys(this.config.task_types).join(", ")}`,
      };
    }
    if (updates.evidence !== undefined && updates.state !== "closed") {
      return {
        ok: false,
        code: "invalid_recovery",
        error: "--evidence can only be used when closing a task.",
      };
    }
    if (updates.startDate && updates.startDate !== "none" && !DATE_RE.test(updates.startDate)) {
      return {
        ok: false,
        code: "invalid_hierarchy",
        error: `Invalid start date format: "${updates.startDate}". Use YYYY-MM-DD.`,
      };
    }
    if (updates.endDate && updates.endDate !== "none" && !DATE_RE.test(updates.endDate)) {
      return {
        ok: false,
        code: "invalid_hierarchy",
        error: `Invalid end date format: "${updates.endDate}". Use YYYY-MM-DD.`,
      };
    }
    const updated = cloneTask(task);
    const oldReviewer = task.reviewer ?? null;
    if (updates.title) updated.title = updates.title;
    if (updates.body !== undefined) updated.body = updates.body;
    if (updates.type) {
      const oldLabel = this.config.task_types[task.type]?.github_label;
      const newLabel = this.config.task_types[updates.type]?.github_label;
      if (oldLabel) updated.labels = updated.labels.filter((label) => label !== oldLabel);
      if (newLabel && !updated.labels.includes(newLabel)) updated.labels.push(newLabel);
      updated.type = updates.type;
    }
    if (updates.state) updated.state = updates.state;
    if (updates.startDate)
      updated.start_date = updates.startDate === "none" ? null : updates.startDate;
    if (updates.endDate) updated.end_date = updates.endDate === "none" ? null : updates.endDate;
    if (updates.assignee && !updated.assignees.includes(updates.assignee))
      updated.assignees.push(updates.assignee);
    if (updates.removeAssignee)
      updated.assignees = updated.assignees.filter((item) => item !== updates.removeAssignee);
    if (updates.assignImplementer !== undefined) {
      const parsed = parseRoleOption("--assign-implementer", updates.assignImplementer);
      if (parsed.error) return { ok: false, code: "invalid_recovery", error: parsed.error };
      updated.implementer = parsed.value;
    }
    if (updates.assignReviewer !== undefined) {
      const parsed = parseRoleOption("--assign-reviewer", updates.assignReviewer);
      if (parsed.error) return { ok: false, code: "invalid_recovery", error: parsed.error };
      updated.reviewer = parsed.value;
      if (!sameLogin(oldReviewer, updated.reviewer)) {
        updated.review_approved_by = null;
        updated.review_approved_at = null;
      }
    }
    if (
      updated.implementer &&
      updated.reviewer &&
      sameLogin(updated.implementer, updated.reviewer)
    ) {
      return {
        ok: false,
        code: "review_gate",
        error: `Reviewer must be different from implementer: "${updated.reviewer}".`,
      };
    }
    if (updates.requireReview !== undefined) updated.require_review = updates.requireReview;
    if (updates.clearReviewApproval) {
      updated.review_approved_by = null;
      updated.review_approved_at = null;
    }
    if (updates.approveReview !== undefined) {
      const parsed = parseRoleOption("--approve-review", updates.approveReview);
      if (parsed.error) return { ok: false, code: "review_gate", error: parsed.error };
      if (!updated.reviewer)
        return {
          ok: false,
          code: "review_gate",
          error: "Cannot approve review before assigning a reviewer.",
        };
      if (!sameLogin(parsed.value, updated.reviewer)) {
        return {
          ok: false,
          code: "review_gate",
          error: `Review must be approved by assigned reviewer "${updated.reviewer}".`,
        };
      }
      updated.review_approved_by = updated.reviewer;
      updated.review_approved_at = this.now();
    }
    if (updates.milestone !== undefined)
      updated.milestone = updates.milestone === "none" ? null : updates.milestone;
    if (updates.status) {
      const statusField = this.config.statuses.field_name;
      if (!this.config.statuses.values[updates.status]) {
        return {
          ok: false,
          code: "invalid_recovery",
          error: `Unknown status: "${updates.status}". Available: ${Object.keys(this.config.statuses.values).join(", ")}`,
        };
      }
      const oldStatus = updated.custom_fields[statusField] as string | undefined;
      updated.custom_fields[statusField] = updates.status;
      const dates = computeStatusDateUpdates(
        oldStatus,
        updates.status,
        this.config.statuses.values,
        {
          start_date: updated.start_date,
          end_date: updated.end_date,
        },
      );
      if (dates.start_date && !updates.startDate) updated.start_date = dates.start_date;
      if (dates.end_date && !updates.endDate) updated.end_date = dates.end_date;
    }
    if (updates.priority) {
      const priority = updates.priority.toLowerCase();
      if (!["critical", "high", "medium", "low"].includes(priority)) {
        return {
          ok: false,
          code: "invalid_recovery",
          error: `Invalid priority: "${updates.priority}". Available: critical, high, medium, low`,
        };
      }
      const field = this.config.sync?.field_mapping?.priority;
      if (!field)
        return {
          ok: false,
          code: "invalid_recovery",
          error: "Priority field is not configured. Set sync.field_mapping.priority in config.",
        };
      updated.custom_fields[field] = priority;
    }
    if (updates.label && !updated.labels.includes(updates.label))
      updated.labels.push(updates.label);
    if (updates.removeLabel)
      updated.labels = updated.labels.filter((label) => label !== updates.removeLabel);
    if (updated.start_date && updated.end_date && updated.start_date > updated.end_date) {
      return {
        ok: false,
        code: "invalid_hierarchy",
        error: `Invalid date range: start_date (${updated.start_date}) is after end_date (${updated.end_date}).`,
      };
    }
    if (updates.state === "closed") {
      const evidence = updates.evidence?.trim() ?? "";
      if (this.config.require_close_evidence === true && evidence.length === 0) {
        return {
          ok: false,
          code: "human_gate_required",
          error: 'Close evidence is required. Provide --evidence "<summary>".',
        };
      }
      if (evidence)
        updated.body = serializeTaskCloseEvidenceBody(updated.body, evidence, this.now());
      const completed = this.complete(updated);
      if (!completed.ok) return completed;
      Object.assign(updated, completed.task);
    }
    updated.updated_at = this.now();
    return { ok: true, task: updated };
  }

  /** direct CLIとproposal adapterが共有する型付きcommand/result seam。 */
  executeCommand(
    command: DirectWorkGraphCommand,
  ): WorkGraphCommandResult<DirectWorkGraphPlan | WorkGraphMutationPlan> {
    if (command.type === "proposal_v1_hard_delete") {
      return {
        ok: false,
        code: "scope_drift",
        error: `proposal v1はhard deleteを扱いません: ${command.targetTaskId}`,
      };
    }
    if (command.type === "proposal_intent") {
      const planned = this.planMutationInternal(command.tasks, command.intent, {
        scopeRootTaskId: command.scopeRootTaskId,
      });
      return planned.ok ? { ...planned, operation: "proposal_intent" } : planned;
    }
    if (
      command.type === "hard_delete_reconciliation" &&
      command.tasks.some(
        (task) =>
          task.id === command.deletedTaskId ||
          task.parent === command.deletedTaskId ||
          task.sub_tasks.includes(command.deletedTaskId) ||
          task.blocked_by.some((dependency) => dependency.task === command.deletedTaskId),
      )
    ) {
      return {
        ok: false,
        code: "dangling_reference",
        error: `hard delete reconciliationに参照が残っています: ${command.deletedTaskId}`,
      };
    }
    const before = command.tasks.map(cloneTask);
    let tasks = command.tasks.map(cloneTask);
    let affectedTaskIds: string[] = [];
    let primitiveOperation: DirectWorkGraphPlan["primitives"][number]["operation"] = "update";
    let targetTaskId: string;
    if (command.type === "create") {
      targetTaskId = command.task.id;
      primitiveOperation = "create";
      if (tasks.some((task) => task.id === command.task.id)) {
        return {
          ok: false,
          code: "dangling_reference",
          error: `Task IDが重複しています: ${command.task.id}`,
        };
      }
      const created = cloneTask(command.task);
      tasks.push(created);
      if (created.parent) {
        const parent = tasks.find((task) => task.id === created.parent);
        if (!parent)
          return {
            ok: false,
            code: "task_not_found",
            error: `Parent task not found: ${created.parent}`,
          };
        if (!parent.sub_tasks.includes(created.id)) parent.sub_tasks.push(created.id);
        affectedTaskIds.push(parent.id);
      }
    } else if (command.type === "update") {
      targetTaskId = command.taskId;
      const index = tasks.findIndex((task) => task.id === command.taskId);
      if (index < 0)
        return { ok: false, code: "task_not_found", error: `Task not found: ${command.taskId}` };
      const projection = this.projectTaskUpdate(tasks[index]!, command.updates);
      if (!projection.ok) return projection;
      tasks[index] = projection.task;
    } else if (command.type === "link") {
      targetTaskId = command.taskId;
      primitiveOperation = "link";
      for (const operation of command.operations) {
        const target = tasks.find((task) => task.id === command.taskId);
        if (!target)
          return { ok: false, code: "task_not_found", error: `Task not found: ${command.taskId}` };
        if (operation.kind === "add_dependency") {
          if (!tasks.some((task) => task.id === operation.blockerTaskId))
            return {
              ok: false,
              code: "task_not_found",
              error: `Task not found: ${operation.blockerTaskId}`,
            };
          const result = projectDependencyChange(target, operation, this.now());
          if (!result.ok) return result;
          tasks[tasks.indexOf(target)] = result.task;
        } else if (operation.kind === "remove_dependency") {
          const result = projectDependencyChange(target, operation, this.now());
          if (!result.ok) return result;
          tasks[tasks.indexOf(target)] = result.task;
        } else {
          const parentId = operation.kind === "set_parent" ? operation.parentTaskId : target.parent;
          const result = projectParentChange(tasks, command.taskId, operation, this.now());
          if (!result.ok) return result;
          tasks = result.tasks;
          if (parentId) affectedTaskIds.push(parentId);
        }
      }
    } else if (command.type === "hard_delete_plan") {
      targetTaskId = command.deletedTaskId;
      primitiveOperation = "delete";
      if (!tasks.some((task) => task.id === targetTaskId))
        return { ok: false, code: "task_not_found", error: `Task not found: ${targetTaskId}` };
      tasks = tasks
        .filter((task) => task.id !== targetTaskId)
        .map((task) => ({
          ...task,
          parent: task.parent === targetTaskId ? null : task.parent,
          sub_tasks: task.sub_tasks.filter((id) => id !== targetTaskId),
          blocked_by: task.blocked_by.filter((dependency) => dependency.task !== targetTaskId),
        }));
    } else {
      targetTaskId = command.deletedTaskId;
      primitiveOperation = "delete";
    }
    const validation = this.validateGraph(tasks);
    if (!validation.ok) return validation;
    const beforeTask = before.find((task) => task.id === targetTaskId) ?? null;
    const afterTask = validation.tasks.find((task) => task.id === targetTaskId) ?? null;
    return {
      ok: true,
      tasks: validation.tasks,
      operation: command.type,
      affectedTaskIds: [...new Set([targetTaskId, ...affectedTaskIds])].sort(),
      primitives: [
        { operation: primitiveOperation, targetTaskId, before: beforeTask, after: afterTask },
      ],
    };
  }

  /** create/update/link/proposalが共有するWork Graph全体の整合性検証。 */
  validateGraph(
    tasks: Task[],
    options: { enforceHierarchy?: boolean } = {},
  ): WorkGraphCommandResult<{ tasks: Task[] }> {
    const ids = new Set<string>();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const configuredRepository =
      `${this.config.project.github.owner}/${this.config.project.github.repo}`.toLowerCase();
    for (const task of tasks) {
      if (ids.has(task.id)) {
        return {
          ok: false,
          code: "dangling_reference",
          error: `Task IDが重複しています: ${task.id}`,
        };
      }
      ids.add(task.id);
      if (task.github_repo.toLowerCase() !== configuredRepository) {
        return { ok: false, code: "scope_drift", error: `repository scope 外です: ${task.id}` };
      }
      if (!this.config.task_types[task.type]) {
        return {
          ok: false,
          code: "invalid_task_type",
          error: `Unknown task type: "${task.type}".`,
        };
      }
      if (task.start_date && task.end_date && task.start_date > task.end_date) {
        return {
          ok: false,
          code: "invalid_hierarchy",
          error: `Invalid date range: start_date (${task.start_date}) is after end_date (${task.end_date}).`,
        };
      }
      if (task.parent) {
        const parent = byId.get(task.parent);
        if (!parent) {
          return {
            ok: false,
            code: "dangling_reference",
            error: `Parent task not found: ${task.parent}`,
          };
        }
        if (
          options.enforceHierarchy !== false &&
          Object.keys(this.config.type_hierarchy).length > 0 &&
          !(this.config.type_hierarchy[parent.type] ?? []).includes(task.type)
        ) {
          return {
            ok: false,
            code: "invalid_hierarchy",
            error: `${parent.type} は ${task.type} を子にできません`,
          };
        }
        if (!parent.sub_tasks.includes(task.id)) {
          return {
            ok: false,
            code: "dangling_reference",
            error: `parent/sub_tasksが一致しません: ${task.id}`,
          };
        }
      }
      for (const childId of task.sub_tasks) {
        const child = byId.get(childId);
        if (!child || child.parent !== task.id) {
          return {
            ok: false,
            code: "dangling_reference",
            error: `parent/sub_tasksが一致しません: ${childId}`,
          };
        }
      }
      for (const dependency of task.blocked_by) {
        if (!byId.has(dependency.task)) {
          return {
            ok: false,
            code: "dangling_reference",
            error: `Dependency task not found: ${dependency.task}`,
          };
        }
      }
    }
    if (detectCycles(tasks).length > 0) {
      return { ok: false, code: "dependency_cycle", error: "dependency cycle が発生します" };
    }
    for (const task of tasks) {
      const visited = new Set<string>([task.id]);
      let parentId = task.parent;
      while (parentId) {
        if (visited.has(parentId)) {
          return {
            ok: false,
            code: "invalid_hierarchy",
            error: `parent cycle が発生します: ${task.id}`,
          };
        }
        visited.add(parentId);
        parentId = byId.get(parentId)?.parent ?? null;
      }
    }
    return { ok: true, tasks: tasks.map(cloneTask) };
  }

  complete(task: Task): WorkGraphCommandResult<{ task: Task }> {
    const reviewRequired =
      task.require_review === true ||
      (this.config.require_review_for_types ?? []).includes(task.type);
    if (reviewRequired && !task.reviewer) {
      return {
        ok: false,
        code: "review_gate",
        error: "Review is required before closing. Assign a reviewer first.",
      };
    }
    if (reviewRequired && !task.review_approved_by) {
      return {
        ok: false,
        code: "review_gate",
        error: `Review is required before closing. Approve with --approve-review ${task.reviewer}.`,
      };
    }
    if (reviewRequired && task.reviewer!.toLowerCase() !== task.review_approved_by!.toLowerCase()) {
      return {
        ok: false,
        code: "review_gate",
        error: `Review must be approved by assigned reviewer "${task.reviewer}".`,
      };
    }
    const unchecked = normalizeAcceptanceCriteria(task.acceptance_criteria).filter(
      (criterion) => !criterion.checked,
    );
    if (unchecked.length > 0) {
      return {
        ok: false,
        code: "acceptance_criteria_gate",
        error: `Acceptance criteria must be checked before closing: ${unchecked
          .map((criterion) => criterion.description)
          .join(", ")}`,
      };
    }
    return {
      ok: true,
      task: {
        ...cloneTask(task),
        state: "closed",
        state_reason: "COMPLETED",
        closed_at: this.now(),
        updated_at: this.now(),
      },
    };
  }

  cancel(
    task: Task,
    input: { trustedHumanApproval: boolean },
  ): WorkGraphCommandResult<{ task: Task; recovery: CancelRecovery }> {
    if (!input.trustedHumanApproval) {
      return {
        ok: false,
        code: "human_gate_required",
        error: "cancel は trusted human approval receipt が必要です",
      };
    }
    const beforeFingerprint = mutationCommandFingerprint(taskProjection(task));
    return {
      ok: true,
      task: {
        ...cloneTask(task),
        state: "closed",
        state_reason: "NOT_PLANNED",
        closed_at: this.now(),
        updated_at: this.now(),
      },
      recovery: { kind: "reopen_cancelled_task", beforeFingerprint },
    };
  }

  recoverCancelled(task: Task, beforeFingerprint: string): WorkGraphCommandResult<{ task: Task }> {
    if (task.state !== "closed" || task.state_reason !== "NOT_PLANNED") {
      return { ok: false, code: "invalid_recovery", error: "cancelled task ではありません" };
    }
    const beforeImage = {
      ...taskProjection(task),
      state: "open",
      state_reason: null,
    };
    if (mutationCommandFingerprint(beforeImage) !== beforeFingerprint) {
      return {
        ok: false,
        code: "invalid_recovery",
        error: "cancel before fingerprint が一致しません",
      };
    }
    return {
      ok: true,
      task: {
        ...cloneTask(task),
        state: "open",
        state_reason: null,
        closed_at: null,
        updated_at: this.now(),
      },
    };
  }

  planMutation(
    currentTasks: Task[],
    intent: WorkGraphMutationIntent,
    options: { scopeRootTaskId?: string } = {},
  ): WorkGraphCommandResult<WorkGraphMutationPlan> {
    const result = this.executeCommand({
      type: "proposal_intent",
      tasks: currentTasks,
      intent,
      scopeRootTaskId: options.scopeRootTaskId,
    });
    if (!result.ok) return result;
    if (!("steps" in result)) {
      throw new Error("proposal_intent planning resultが不正です");
    }
    return result;
  }

  private planMutationInternal(
    currentTasks: Task[],
    intent: WorkGraphMutationIntent,
    options: { scopeRootTaskId?: string } = {},
  ): WorkGraphCommandResult<WorkGraphMutationPlan> {
    const currentValidation = this.validateGraph(currentTasks);
    if (!currentValidation.ok) return currentValidation;
    const before = currentTasks.map(cloneTask);
    const tasks = currentTasks.map(cloneTask);
    const configuredRepository = `${this.config.project.github.owner}/${this.config.project.github.repo}`;
    const byId = () => new Map(tasks.map((task) => [task.id, task]));
    const requireTask = (taskId: string): WorkGraphCommandResult<{ task: Task }> => {
      const found = byId().get(taskId);
      if (!found) return { ok: false, code: "task_not_found", error: `Task not found: ${taskId}` };
      if (found.github_repo.toLowerCase() !== configuredRepository.toLowerCase()) {
        return { ok: false, code: "scope_drift", error: `repository scope 外です: ${taskId}` };
      }
      if (options.scopeRootTaskId) {
        const allowed = descendants(tasks, options.scopeRootTaskId);
        if (!allowed.has(taskId)) {
          return { ok: false, code: "scope_drift", error: `Run subtree scope 外です: ${taskId}` };
        }
      }
      return { ok: true, task: found };
    };
    const steps: MutationPrimitiveStep[] = [];
    const targets = new Set<string>();
    const addStep = (
      operation: MutationPrimitiveStep["operation"],
      targetTaskId: string,
      payload: Record<string, unknown>,
      beforeImage: Record<string, unknown> | null,
      expectedPostcondition: Record<string, unknown>,
      recovery: CancelRecovery | null = null,
    ) => {
      targets.add(targetTaskId);
      const beforeTask = before.find((task) => task.id === targetTaskId);
      const remoteAwarePayload = beforeTask
        ? { ...payload, remoteBeforeImage: mutationRemoteBeforeProjection(beforeTask) }
        : payload;
      steps.push(
        primitive(
          steps.length,
          operation,
          targetTaskId,
          remoteAwarePayload,
          beforeImage,
          expectedPostcondition,
          recovery,
        ),
      );
    };
    const validateNewType = (type: string, parentType?: string) => {
      if (!this.config.task_types[type]) {
        return {
          ok: false as const,
          code: "invalid_task_type" as const,
          error: `Unknown type: ${type}`,
        };
      }
      if (
        parentType &&
        Object.keys(this.config.type_hierarchy).length > 0 &&
        !(this.config.type_hierarchy[parentType] ?? []).includes(type)
      ) {
        return {
          ok: false as const,
          code: "invalid_hierarchy" as const,
          error: `${parentType} は ${type} を子にできません`,
        };
      }
      return { ok: true as const };
    };

    if (intent.kind === "reorder") {
      const parentResult = requireTask(intent.parentTaskId);
      if (!parentResult.ok) return parentResult;
      const parent = parentResult.task;
      if (!sameMembers(parent.sub_tasks, intent.orderedSubTaskIds)) {
        return {
          ok: false,
          code: "invalid_reorder",
          error: "orderedSubTaskIds は current sibling 集合と完全一致する必要があります",
        };
      }
      for (const childId of intent.orderedSubTaskIds) {
        const childResult = requireTask(childId);
        if (!childResult.ok) return childResult;
        if (childResult.task.parent !== parent.id) {
          return {
            ok: false,
            code: "invalid_reorder",
            error: "別 parent の task は並べ替えできません",
          };
        }
      }
      parent.sub_tasks = [...intent.orderedSubTaskIds];
      parent.updated_at = this.now();
      addStep(
        "reprioritize",
        parent.id,
        {
          movedSubTaskId: intent.movedSubTaskId,
          beforeSubTaskId: intent.beforeSubTaskId,
          afterSubTaskId: intent.afterSubTaskId,
          orderedSubTaskIds: intent.orderedSubTaskIds,
        },
        taskProjection(before.find((task) => task.id === parent.id)!),
        { sub_tasks: parent.sub_tasks },
      );
    } else if (intent.kind === "dependency") {
      const taskResult = requireTask(intent.taskId);
      if (!taskResult.ok) return taskResult;
      const blockerResult = requireTask(intent.blockerTaskId);
      if (!blockerResult.ok) return blockerResult;
      const task = taskResult.task;
      const dependencyExists = task.blocked_by.some((item) => item.task === intent.blockerTaskId);
      if (
        (intent.operation === "add" && dependencyExists) ||
        (intent.operation === "remove" && !dependencyExists)
      ) {
        return {
          ok: false,
          code: "invalid_command",
          error: `依存関係が変化しない操作です: ${intent.operation} ${intent.blockerTaskId}`,
        };
      }
      task.blocked_by =
        intent.operation === "add"
          ? [...task.blocked_by, { task: intent.blockerTaskId, type: "finish-to-start", lag: 0 }]
          : task.blocked_by.filter((item) => item.task !== intent.blockerTaskId);
      task.updated_at = this.now();
      addStep(
        "link",
        task.id,
        { operation: intent.operation, blockerTaskId: intent.blockerTaskId },
        taskProjection(before.find((item) => item.id === task.id)!),
        { blocked_by: task.blocked_by },
      );
    } else if (intent.kind === "add" || intent.kind === "split") {
      const specs = intent.kind === "add" ? [intent.task] : intent.children;
      const parentId = intent.kind === "add" ? intent.parentTaskId : intent.targetTaskId;
      if (options.scopeRootTaskId && parentId === null) {
        return {
          ok: false,
          code: "scope_drift",
          error: "Run subtree scope内ではtop-level taskを追加できません",
        };
      }
      let parent: Task | null = null;
      if (parentId) {
        const parentResult = requireTask(parentId);
        if (!parentResult.ok) return parentResult;
        parent = parentResult.task;
      }
      for (const spec of specs) {
        const typeResult = validateNewType(spec.type, parent?.type);
        if (!typeResult.ok) return typeResult;
        // 既存push executorが認識するdraft IDを使い、proposal専用create経路を作らない。
        const taskId = `${configuredRepository}#draft-mutation-${spec.clientId}`;
        if (byId().has(taskId)) {
          return {
            ok: false,
            code: "dangling_reference",
            error: `clientId が重複しています: ${spec.clientId}`,
          };
        }
        const created: Task = {
          id: taskId,
          type: spec.type,
          github_issue: null,
          github_repo: configuredRepository,
          parent: parent?.id ?? null,
          sub_tasks: [],
          title: spec.title,
          body: spec.body ?? null,
          state: "open",
          state_reason: null,
          assignees: [],
          labels: this.config.task_types[spec.type]?.github_label
            ? [this.config.task_types[spec.type]!.github_label!]
            : [],
          milestone: null,
          linked_prs: [],
          created_at: this.now(),
          updated_at: this.now(),
          closed_at: null,
          acceptance_criteria: [],
          acceptance_criteria_slot: false,
          implementer: null,
          reviewer: null,
          require_review: spec.requireReview ?? false,
          review_approved_by: null,
          review_approved_at: null,
          custom_fields: {},
          start_date: spec.startDate ?? null,
          end_date: spec.endDate ?? null,
          date: null,
          blocked_by: [],
        };
        tasks.push(created);
        if (parent) parent.sub_tasks.push(taskId);
        addStep(
          "create",
          taskId,
          {
            task: structuredClone(created),
            affectedTaskIds: parent ? [parent.id] : [],
          },
          null,
          createMutationRemoteProjection(created, this.config),
        );
      }
      if (parent) {
        parent.updated_at = this.now();
        targets.add(parent.id);
      }
      if (intent.kind === "split" && intent.sourceDisposition === "close") {
        const source = parent!;
        const beforeImage = taskProjection(before.find((task) => task.id === source.id)!);
        const beforeFingerprint = mutationCommandFingerprint(beforeImage);
        source.state = "closed";
        source.state_reason = "NOT_PLANNED";
        source.closed_at = this.now();
        addStep(
          "cancel",
          source.id,
          { state: "closed", stateReason: "NOT_PLANNED" },
          beforeImage,
          { state: "closed", state_reason: "NOT_PLANNED" },
          { kind: "reopen_cancelled_task", beforeFingerprint },
        );
      }
    } else if (intent.kind === "cancel") {
      const taskResult = requireTask(intent.targetTaskId);
      if (!taskResult.ok) return taskResult;
      const source = taskResult.task;
      const beforeImage = taskProjection(before.find((task) => task.id === source.id)!);
      const beforeFingerprint = mutationCommandFingerprint(beforeImage);
      source.state = "closed";
      source.state_reason = "NOT_PLANNED";
      source.closed_at = this.now();
      addStep(
        "cancel",
        source.id,
        { reason: intent.reason, state: "closed", stateReason: "NOT_PLANNED" },
        beforeImage,
        { state: "closed", state_reason: "NOT_PLANNED" },
        { kind: "reopen_cancelled_task", beforeFingerprint },
      );
    } else {
      if (new Set(intent.sourceTaskIds).size !== intent.sourceTaskIds.length) {
        return {
          ok: false,
          code: "invalid_command",
          error: "merge sourceTaskIds に重複は許可されません",
        };
      }
      if (intent.sourceTaskIds.includes(intent.targetTaskId)) {
        return {
          ok: false,
          code: "invalid_command",
          error: "merge target は source と別 task である必要があります",
        };
      }
      const targetResult = requireTask(intent.targetTaskId);
      if (!targetResult.ok) return targetResult;
      for (const sourceId of intent.sourceTaskIds) {
        const sourceResult = requireTask(sourceId);
        if (!sourceResult.ok) return sourceResult;
        const source = sourceResult.task;
        const beforeImage = taskProjection(before.find((task) => task.id === source.id)!);
        const beforeFingerprint = mutationCommandFingerprint(beforeImage);
        source.state = "closed";
        source.state_reason = "NOT_PLANNED";
        source.closed_at = this.now();
        addStep(
          "cancel",
          source.id,
          { mergedInto: targetResult.task.id, stateReason: "NOT_PLANNED" },
          beforeImage,
          { state: "closed", state_reason: "NOT_PLANNED" },
          { kind: "reopen_cancelled_task", beforeFingerprint },
        );
      }
      targets.add(targetResult.task.id);
    }

    const dangling = tasks.flatMap((task) => [
      ...task.blocked_by.filter((dependency) => !byId().has(dependency.task)).map(() => task.id),
      ...(task.parent && !byId().has(task.parent) ? [task.id] : []),
      ...task.sub_tasks.filter((child) => !byId().has(child)).map(() => task.id),
    ]);
    if (dangling.length > 0) {
      return { ok: false, code: "dangling_reference", error: `dangling reference: ${dangling[0]}` };
    }
    if (detectCycles(tasks).length > 0) {
      return { ok: false, code: "dependency_cycle", error: "dependency cycle が発生します" };
    }
    const finalValidation = this.validateGraph(tasks);
    if (!finalValidation.ok) return finalValidation;
    for (const ancestorId of ancestorClosure(tasks, targets)) targets.add(ancestorId);
    if (options.scopeRootTaskId) targets.add(options.scopeRootTaskId);
    const targetTaskIds = [...targets].sort();
    const affected = impact(tasks, targetTaskIds);
    const destructive = steps.some((step) => step.operation === "cancel");
    return {
      ok: true,
      tasks,
      targetTaskIds,
      steps,
      diff: changedDiff(before, tasks),
      affectedUpstream: affected.upstream,
      affectedDownstream: affected.downstream,
      risk: destructive
        ? "destructive"
        : steps.length > 5
          ? "high"
          : steps.length > 2
            ? "medium"
            : "low",
    };
  }
}
