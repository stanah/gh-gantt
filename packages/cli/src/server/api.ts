import { Router, json } from "express";
import { z } from "zod";
import { ConfigStore } from "../store/config.js";
import { withProjectStorage } from "../store/project-storage.js";
import { setParent, removeParent } from "../commands/task/link.js";
import { validateTaskCloseReview } from "../commands/task/update.js";
import { hashTask } from "../sync/hash.js";
import { computeLocalDiff, formatDiffPreview } from "../sync/diff.js";
import { executePush } from "../sync/push-executor.js";
import { executePull } from "../sync/pull-executor.js";
import { createGraphQLClient } from "../github/client.js";
import { buildDraftTaskId, getNextDraftNumber } from "../github/issues.js";
import { resolveTaskId } from "../util/task-id.js";
import type { Task, StatusValue, Dependency } from "@gh-gantt/shared";
import {
  buildProjectMapRunGraphViewModel,
  computeStatusDateUpdates,
  DependencySchema,
  ProjectMapRunGraphViewModelSchema,
  TaskSchema,
} from "@gh-gantt/shared";
import { GraphContractStore } from "../store/graph-contract.js";
import {
  RunGraphEventStore,
  RunGraphLocatorIndexBusyError,
  RunGraphLocatorIndexNotReadyError,
} from "../store/run-graph.js";
import { RunGraphControlPlane } from "../run-graph/control-plane.js";

const CreateTaskRequestSchema = z
  .object({
    title: z.string().trim().min(1),
    type: z.string().trim().min(1),
    body: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
  })
  .strict();

const UpdateTaskRequestSchema = z
  .object({
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
    custom_fields: z.record(z.string(), z.unknown()).optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
    blocked_by: z.array(DependencySchema).optional(),
    sub_tasks: z.unknown().optional(),
  })
  .strict();

const ProjectMapRunGraphQuerySchema = z
  .object({
    taskId: z.string().trim().min(1).max(500),
    runId: z.string().trim().min(1).max(200).optional(),
    nodeId: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.nodeId && !query.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodeId"],
        message: "nodeId requires runId",
      });
    }
  });

/** newParentId から親方向へ遡り taskId に到達する場合 true (循環になる)。 */
function wouldCreateCycle(tasks: Task[], taskId: string, newParentId: string): boolean {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  let current: string | null = newParentId;
  while (current) {
    if (current === taskId) return true;
    current = taskMap.get(current)?.parent ?? null;
  }
  return false;
}

export function createApiRouter(projectRoot: string): Router {
  const router = Router();
  router.use(json());

  const configStore = new ConfigStore(projectRoot);

  // 設定取得: GET /api/config
  router.get("/api/config", async (_req, res) => {
    try {
      const config = await configStore.read();
      res.json(config);
    } catch {
      res.status(500).json({ error: "Failed to read config" });
    }
  });

  // task一覧取得: GET /api/tasks
  router.get("/api/tasks", async (_req, res) => {
    try {
      await withProjectStorage(
        projectRoot,
        { mode: "read", scope: "shared-cache" },
        async ({ configStore, tasksStore, commentsStore }) => {
          const config = await configStore.read();
          const tasksFile = await tasksStore.read();
          const commentsFile = await commentsStore.read();
          const normalizedComments: Record<
            string,
            Array<{ author: string; body: string; created_at: string }>
          > = {};
          for (const [key, arr] of Object.entries(commentsFile.comments)) {
            normalizedComments[key] = arr.map((c) => ({
              author: c.author,
              body: c.body,
              created_at: c.created_at,
            }));
          }
          const mergedCache = {
            ...tasksFile.cache,
            comments: { ...tasksFile.cache.comments, ...normalizedComments },
          };
          const tasksWithProgress = attachProgress(
            tasksFile.tasks,
            config.statuses.values,
            config.statuses.field_name,
          );
          res.json({ tasks: tasksWithProgress, cache: mergedCache });
        },
      );
    } catch {
      res.status(500).json({ error: "Failed to read tasks" });
    }
  });

  // draft task作成: POST /api/tasks
  router.post("/api/tasks", async (req, res) => {
    try {
      await withProjectStorage(
        projectRoot,
        { mode: "write", scope: "shared-cache" },
        async (storage) => {
          const { configStore, tasksStore } = storage;
          const config = await configStore.read();
          const tasksFile = await tasksStore.read();
          const rawBody = req.body as unknown;

          if (
            typeof rawBody !== "object" ||
            rawBody === null ||
            Array.isArray(rawBody) ||
            !("title" in rawBody) ||
            !("type" in rawBody) ||
            !(rawBody as Record<string, unknown>).title ||
            !(rawBody as Record<string, unknown>).type
          ) {
            res.status(400).json({ error: "title and type are required" });
            return;
          }

          // parent 参照の正規化と存在検証 (#319)
          // 生の "draft-1" / "293" のまま保存すると push の replaceTaskIdReferences /
          // id_map 照合 (正規形の完全一致) が効かず sub-issue 関係がスキップされるため、
          // CLI の create --parent (#302) と同じく resolveTaskId で正規形へ解決してから保存する
          const rawParent = (rawBody as Record<string, unknown>).parent ?? null;
          if (rawParent !== null && typeof rawParent !== "string") {
            res.status(400).json({ error: "parent must be a string or null" });
            return;
          }
          let parent: string | null = rawParent;
          // 空文字・空白のみは正規化をすり抜けて参照整合性を壊すため明示的に拒否する
          if (parent !== null && parent.trim() === "") {
            res.status(400).json({ error: "parent must be a non-empty string or null" });
            return;
          }
          const parsedBody = CreateTaskRequestSchema.safeParse(rawBody);
          if (!parsedBody.success) {
            res.status(400).json({ error: "Invalid task create request" });
            return;
          }
          const { title, type, body, start_date, end_date } = parsedBody.data;
          if (!config.task_types[type]) {
            res.status(400).json({ error: `Unknown task type: "${type}"` });
            return;
          }
          if (parent) {
            parent = resolveTaskId(parent, config);
            if (!tasksFile.tasks.some((t) => t.id === parent)) {
              res.status(400).json({ error: `Parent task not found: ${parent}` });
              return;
            }
          }

          const { owner, repo } = config.project.github;
          const repoFullName = `${owner}/${repo}`;
          const draftNumber = getNextDraftNumber(tasksFile.tasks);
          const taskId = buildDraftTaskId(repoFullName, draftNumber);

          const labels: string[] = [];
          const taskType = config.task_types[type];
          if (taskType.github_label) labels.push(taskType.github_label);

          const now = new Date().toISOString();
          const task = TaskSchema.parse({
            id: taskId,
            type,
            github_issue: null,
            github_repo: repoFullName,
            parent,
            sub_tasks: [],
            title,
            body: body ?? null,
            state: "open",
            state_reason: null,
            assignees: [],
            labels,
            milestone: null,
            linked_prs: [],
            created_at: now,
            updated_at: now,
            closed_at: null,
            acceptance_criteria: [],
            acceptance_criteria_slot: false,
            implementer: null,
            reviewer: null,
            require_review: false,
            review_approved_by: null,
            review_approved_at: null,
            custom_fields: {},
            start_date: start_date ?? null,
            end_date: end_date ?? null,
            date: null,
            blocked_by: [],
          });

          // parent の存在は正規化時に検証済み (#319)
          if (parent) {
            const parentTask = tasksFile.tasks.find((t) => t.id === parent);
            if (parentTask && !parentTask.sub_tasks.includes(taskId)) {
              parentTask.sub_tasks.push(taskId);
            }
          }

          tasksFile.tasks.push(task);
          await tasksStore.write(tasksFile);
          await storage.flush();

          res.status(201).json(task);
        },
      );
    } catch (err) {
      res.status(500).json({
        error: "Failed to create task: " + (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // task更新: PATCH /api/tasks/:id
  router.patch("/api/tasks/:id", async (req, res) => {
    try {
      await withProjectStorage(
        projectRoot,
        { mode: "write", scope: "shared-cache" },
        async (storage) => {
          const { configStore, tasksStore } = storage;
          const taskId = decodeURIComponent(req.params.id);
          let updates = req.body as Record<string, unknown>;
          if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
            res.status(400).json({ error: "Invalid task update request" });
            return;
          }
          const config = await configStore.read();
          const tasksFile = await tasksStore.read();
          const idx = tasksFile.tasks.findIndex((t) => t.id === taskId);

          if (idx === -1) {
            res.status(404).json({ error: "Task not found" });
            return;
          }

          const UPDATABLE_FIELDS = [
            "title",
            "body",
            "type",
            "state",
            "state_reason",
            "assignees",
            "implementer",
            "reviewer",
            "require_review",
            "review_approved_by",
            "review_approved_at",
            "labels",
            "milestone",
            "custom_fields",
            "start_date",
            "end_date",
            "date",
            "parent",
            "blocked_by",
          ] as const;

          const oldTask = tasksFile.tasks[idx];
          if ("type" in updates) {
            if (typeof updates.type !== "string" || !config.task_types[updates.type]) {
              res.status(400).json({ error: `Unknown task type: "${updates.type}"` });
              return;
            }
          }
          if ("labels" in updates) {
            if (
              !Array.isArray(updates.labels) ||
              updates.labels.some((label: unknown) => typeof label !== "string")
            ) {
              res.status(400).json({ error: "labels must be an array of strings" });
              return;
            }
          }
          for (const roleField of ["implementer", "reviewer"] as const) {
            if (
              roleField in updates &&
              updates[roleField] !== null &&
              typeof updates[roleField] !== "string"
            ) {
              res.status(400).json({ error: `${roleField} must be a string or null` });
              return;
            }
          }
          if ("require_review" in updates && typeof updates.require_review !== "boolean") {
            res.status(400).json({ error: "require_review must be a boolean" });
            return;
          }
          // parent 参照の正規化と存在検証 (#319, POST /api/tasks と同じ規律)
          if ("parent" in updates && updates.parent !== null) {
            if (typeof updates.parent !== "string") {
              res.status(400).json({ error: "parent must be a string or null" });
              return;
            }
            // 空文字・空白のみは resolveTaskId の fallback で "o/r#" に化けて
            // 「存在しない親」と区別できなくなるため明示的に拒否する (POST と同一)
            if (updates.parent.trim() === "") {
              res.status(400).json({ error: "parent must be a non-empty string or null" });
              return;
            }
            const resolvedParent = resolveTaskId(updates.parent, config);
            if (!tasksFile.tasks.some((t) => t.id === resolvedParent)) {
              res.status(400).json({ error: `Parent task not found: ${resolvedParent}` });
              return;
            }
            updates.parent = resolvedParent;
          }
          for (const reviewField of ["review_approved_by", "review_approved_at"] as const) {
            if (
              reviewField in updates &&
              updates[reviewField] !== null &&
              typeof updates[reviewField] !== "string"
            ) {
              res.status(400).json({ error: `${reviewField} must be a string or null` });
              return;
            }
          }
          // sub_tasks は parent から導出される逆リンクで、setParent / removeParent が
          // parent と対で維持する。直接書き換えは child.parent と parent.sub_tasks の
          // 食い違いを作れるため拒否し、parent 更新 / reparent へ誘導する (#321)
          if ("sub_tasks" in updates) {
            res.status(400).json({
              error:
                "sub_tasks is derived from parent and cannot be updated directly; " +
                "update the child's parent or use POST /api/tasks/:id/reparent",
            });
            return;
          }
          // blocked_by 参照の正規化と存在検証 (#321, parent と同じ規律)
          // TasksStore.write は無検証・read は Zod 検証のため、形状不正なエントリを
          // 生保存すると以後の全 read が失敗する。保存前に正規形へ解決して検証する
          if ("blocked_by" in updates) {
            if (!Array.isArray(updates.blocked_by)) {
              res.status(400).json({ error: "blocked_by must be an array of dependencies" });
              return;
            }
            const normalizedDeps: Dependency[] = [];
            const seenBlockers = new Set<string>();
            for (const entry of updates.blocked_by as unknown[]) {
              if (typeof entry !== "object" || entry === null) {
                res
                  .status(400)
                  .json({ error: "blocked_by must be an array of dependency objects" });
                return;
              }
              const { task: blockerRef, type, lag } = entry as Record<string, unknown>;
              if (typeof blockerRef !== "string") {
                res.status(400).json({ error: "blocked_by[].task must be a string" });
                return;
              }
              // 空文字・空白のみは resolveTaskId の fallback で "o/r#" に化けて
              // 「存在しないブロッカー」と区別できなくなるため明示的に拒否する (parent と同一)
              if (blockerRef.trim() === "") {
                res.status(400).json({ error: "blocked_by[].task must be a non-empty string" });
                return;
              }
              const resolvedBlocker = resolveTaskId(blockerRef, config);
              // type / lag は shared の DependencySchema で検証し、未知プロパティは
              // 正規形 { task, type, lag } へ落として保存する
              const parsed = DependencySchema.safeParse({ task: resolvedBlocker, type, lag });
              if (!parsed.success) {
                res.status(400).json({
                  error: "blocked_by entry is invalid (expected { task, type, lag })",
                });
                return;
              }
              // 短縮形の自己参照も正規化後に検出する (CLI addDependency と同一文言)
              if (resolvedBlocker === taskId) {
                res.status(400).json({ error: "A task cannot be blocked by itself." });
                return;
              }
              if (!tasksFile.tasks.some((t) => t.id === resolvedBlocker)) {
                res.status(400).json({ error: `Blocker task not found: ${resolvedBlocker}` });
                return;
              }
              // 正規化後に同一ブロッカーへ潰れた重複は最初の 1 件を優先する
              // (CLI addDependency の重複 skip と同じ挙動)
              if (seenBlockers.has(resolvedBlocker)) continue;
              seenBlockers.add(resolvedBlocker);
              normalizedDeps.push(parsed.data);
            }
            updates.blocked_by = normalizedDeps;
          }

          const parsedUpdates = UpdateTaskRequestSchema.safeParse(updates);
          if (!parsedUpdates.success) {
            res.status(400).json({ error: "Invalid task update request" });
            return;
          }
          updates = parsedUpdates.data;

          const safeUpdates: Partial<Task> = {};
          for (const key of UPDATABLE_FIELDS) {
            // parent は単純マージすると旧親・新親の sub_tasks 逆リンクが壊れるため、
            // 書き込み直前に setParent / removeParent で階層ごと更新する
            if (key === "parent") continue;
            if (key in updates) {
              (safeUpdates as Record<string, unknown>)[key] = updates[key];
            }
          }
          const updatedTask = { ...oldTask, ...safeUpdates };

          if (
            updatedTask.implementer &&
            updatedTask.reviewer &&
            updatedTask.implementer.toLowerCase() === updatedTask.reviewer.toLowerCase()
          ) {
            res.status(400).json({ error: "reviewer must be different from implementer" });
            return;
          }
          if (updates.state === "closed") {
            const reviewError = validateTaskCloseReview(updatedTask, config);
            if (reviewError) {
              res.status(400).json({ error: reviewError });
              return;
            }
          }

          if (safeUpdates.type && safeUpdates.type !== oldTask.type) {
            const oldTypeDef = config.task_types[oldTask.type];
            const newTypeDef = config.task_types[safeUpdates.type];
            if (oldTypeDef?.github_label) {
              updatedTask.labels = updatedTask.labels.filter(
                (label) => label !== oldTypeDef.github_label,
              );
            }
            if (newTypeDef?.github_label && !updatedTask.labels.includes(newTypeDef.github_label)) {
              updatedTask.labels = [...updatedTask.labels, newTypeDef.github_label];
            }
          }

          // status遷移に応じて日付を自動更新する
          const statusField = config.statuses.field_name;
          const oldStatus = oldTask.custom_fields[statusField] as string | undefined;
          const newStatus = updatedTask.custom_fields[statusField] as string | undefined;
          if (newStatus && oldStatus !== newStatus) {
            const dateUpdates = computeStatusDateUpdates(
              oldStatus,
              newStatus,
              config.statuses.values,
              {
                start_date: updatedTask.start_date,
                end_date: updatedTask.end_date,
              },
            );
            if (dateUpdates.start_date && !safeUpdates.start_date)
              updatedTask.start_date = dateUpdates.start_date;
            if (dateUpdates.end_date && !safeUpdates.end_date)
              updatedTask.end_date = dateUpdates.end_date;
          }

          // 日付の変更経路にかかわらずstart > endを拒否する
          if (
            updatedTask.start_date &&
            updatedTask.end_date &&
            updatedTask.start_date > updatedTask.end_date
          ) {
            res.status(400).json({
              error: `start_date (${updatedTask.start_date}) must not be after end_date (${updatedTask.end_date})`,
            });
            return;
          }

          const effectiveParentId = "parent" in updates ? (updates.parent ?? null) : oldTask.parent;
          if (("type" in updates || "parent" in updates) && effectiveParentId) {
            const effectiveParent = tasksFile.tasks.find((task) => task.id === effectiveParentId);
            if (effectiveParent) {
              const allowed = config.type_hierarchy[effectiveParent.type];
              if (allowed && allowed.length > 0 && !allowed.includes(updatedTask.type)) {
                res.status(400).json({
                  error: `Cannot place "${updatedTask.type}" under "${effectiveParent.type}"`,
                });
                return;
              }
            }
          }

          const parsedTask = TaskSchema.safeParse(updatedTask);
          if (!parsedTask.success) {
            res.status(400).json({ error: "Invalid task update request" });
            return;
          }

          tasksFile.tasks[idx] = parsedTask.data;

          // parent の変更は /reparent と同一の setParent / removeParent に委譲し、
          // 自己参照の拒否と旧親・新親の sub_tasks 逆リンク維持を保証する
          if ("parent" in updates) {
            if (updates.parent === null) {
              tasksFile.tasks = removeParent(tasksFile.tasks, taskId);
            } else {
              // 循環検出・階層制約は setParent の責務外のため reparent と同じ検査を通す
              if (wouldCreateCycle(tasksFile.tasks, taskId, updates.parent as string)) {
                res.status(400).json({ error: "This operation would create a cycle" });
                return;
              }
              const parentResult = setParent(tasksFile.tasks, taskId, updates.parent as string);
              if (parentResult.error) {
                res.status(400).json({ error: parentResult.error });
                return;
              }
              tasksFile.tasks = parentResult.tasks!;
            }
          }

          await tasksStore.write(tasksFile);
          await storage.flush();

          const finalTask = tasksFile.tasks.find((t) => t.id === taskId) ?? updatedTask;
          res.json(finalTask);
        },
      );
    } catch {
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  // 親変更: POST /api/tasks/:id/reparent
  router.post("/api/tasks/:id/reparent", async (req, res) => {
    try {
      await withProjectStorage(
        projectRoot,
        { mode: "write", scope: "shared-cache" },
        async (storage) => {
          const { configStore, tasksStore } = storage;
          const taskId = decodeURIComponent(req.params.id);
          // 親解除の意図は newParentId: null の明示を要求する。キー欠落を null と
          // 同一視すると、無関係な body での呼び出しが意図しない親解除になる
          if (!("newParentId" in req.body)) {
            res.status(400).json({ error: "newParentId is required (use null to remove parent)" });
            return;
          }
          let { newParentId } = req.body;

          const config = await configStore.read();
          const tasksFile = await tasksStore.read();
          const task = tasksFile.tasks.find((t) => t.id === taskId);

          if (!task) {
            res.status(404).json({ error: "Task not found", code: "TASK_NOT_FOUND" });
            return;
          }

          // newParentId を正規形へ解決してから検証する (#319, CLI link --set-parent と同じ規律)
          if (newParentId != null) {
            if (typeof newParentId !== "string") {
              res.status(400).json({ error: "newParentId must be a string or null" });
              return;
            }
            if (newParentId.trim() === "") {
              res.status(400).json({ error: "newParentId must be a non-empty string or null" });
              return;
            }
            newParentId = resolveTaskId(newParentId, config);
          }

          if (newParentId === taskId) {
            res
              .status(400)
              .json({ error: "Cannot set a task as its own parent", code: "SELF_REFERENCE" });
            return;
          }

          if (newParentId != null) {
            const parent = tasksFile.tasks.find((t) => t.id === newParentId);
            if (!parent) {
              res.status(404).json({ error: "Parent task not found", code: "TASK_NOT_FOUND" });
              return;
            }

            // newParentIdから親方向へ辿り、taskIdへ到達する循環を検出する
            if (wouldCreateCycle(tasksFile.tasks, taskId, newParentId)) {
              res
                .status(400)
                .json({ error: "This operation would create a cycle", code: "CYCLE_DETECTED" });
              return;
            }

            // task typeの階層制約を検証する
            const allowed = config.type_hierarchy[parent.type];
            if (allowed && allowed.length > 0 && !allowed.includes(task.type)) {
              res.status(400).json({
                error: `Cannot place "${task.type}" under "${parent.type}"`,
                code: "TYPE_HIERARCHY_VIOLATION",
              });
              return;
            }

            const parentResult = setParent(tasksFile.tasks, taskId, newParentId);
            if (parentResult.error) {
              res.status(400).json({ error: parentResult.error });
              return;
            }
            tasksFile.tasks = parentResult.tasks!;
          } else {
            tasksFile.tasks = removeParent(tasksFile.tasks, taskId);
          }

          await tasksStore.write(tasksFile);
          await storage.flush();

          const tasksWithProgress = attachProgress(
            tasksFile.tasks,
            config.statuses.values,
            config.statuses.field_name,
          );
          res.json({ tasks: tasksWithProgress });
        },
      );
    } catch (err) {
      res.status(500).json({
        error: "Failed to reparent task: " + (err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // planned-vs-actual Run Graph: GET /api/project-map/run-graph
  router.get("/api/project-map/run-graph", async (req, res) => {
    const query = ProjectMapRunGraphQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid Project Map Run Graph query" });
      return;
    }

    try {
      const selectedTask = await withProjectStorage(
        projectRoot,
        { mode: "read", scope: "shared-cache" },
        async ({ tasksStore }) => {
          const tasksFile = await tasksStore.read();
          return tasksFile.tasks.find((task) => task.id === query.data.taskId) ?? null;
        },
      );
      if (!selectedTask) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      if (selectedTask.github_issue == null) {
        res.status(400).json({ error: "Draft task does not have a Run Graph target" });
        return;
      }

      const eventStore = new RunGraphEventStore(projectRoot);
      const controlPlane = new RunGraphControlPlane(projectRoot);
      const [owner, repo] = selectedTask.github_repo.split("/");
      if (!owner || !repo) throw new Error("Task github_repo が owner/repo 形式ではありません");
      const locators = await eventStore.listRunLocators({
        task: { owner, repo, issueNumber: selectedTask.github_issue },
        limit: query.data.limit,
        ...(query.data.runId ? { selectedRunId: query.data.runId } : {}),
      });
      if (query.data.runId && !locators.items.some((item) => item.runId === query.data.runId)) {
        res.status(404).json({ error: "Run Graph not found for the selected task" });
        return;
      }
      const views = [];
      for (const locator of locators.items) {
        views.push(
          await controlPlane.inspect(
            locator.runId,
            query.data.limit,
            locator.runId === query.data.runId ? query.data.nodeId : undefined,
          ),
        );
      }
      const selectedView = query.data.runId
        ? (views.find((view) => view.runId === query.data.runId) ?? null)
        : (views[0] ?? null);
      if (
        query.data.nodeId &&
        !selectedView?.nodes.items.some((node) => node.id === query.data.nodeId)
      ) {
        res.status(404).json({ error: "Run Graph node not found" });
        return;
      }
      const contract = selectedView
        ? await new GraphContractStore(projectRoot).read(selectedView.contract)
        : null;
      const taskId = selectedTask.id;

      res.json(
        ProjectMapRunGraphViewModelSchema.parse(
          buildProjectMapRunGraphViewModel({
            taskId,
            contract,
            runViews: views,
            selectedRunId: selectedView?.runId ?? null,
            selectedNodeId: query.data.nodeId ?? null,
            limit: query.data.limit,
            totalRuns: locators.total,
          }),
        ),
      );
    } catch (error) {
      if (
        error instanceof RunGraphLocatorIndexBusyError ||
        error instanceof RunGraphLocatorIndexNotReadyError
      ) {
        res.status(503).json({ error: "Run Graph locator index is temporarily unavailable" });
        return;
      }
      res.status(500).json({
        error:
          "Failed to build Project Map Run Graph: " +
          (error instanceof Error ? error.message : String(error)),
      });
    }
  });

  // pull実行: POST /api/sync/pull
  router.post("/api/sync/pull", async (req, res) => {
    try {
      await withProjectStorage(
        projectRoot,
        { mode: "write", scope: "shared-cache" },
        async (storage) => {
          const { configStore, tasksStore, stateStore } = storage;
          const config = await configStore.read();
          const tasksFile = await tasksStore.read();
          const syncState = await stateStore.read();

          // 未解決conflictがある場合は次のpullを拒否する
          if (tasksFile.has_conflicts) {
            res.status(409).json({
              message: "未解決のコンフリクトがあります。先に resolve してください",
            });
            return;
          }

          const gql = await createGraphQLClient();
          const {
            result,
            tasksFile: newTasksFile,
            syncState: newSyncState,
          } = await executePull(gql, config, tasksFile, syncState);

          if (result.skipped) {
            await stateStore.write(newSyncState);
            await storage.flush();
            res.json({ added: 0, updated: 0, removed: 0, conflicts: 0 });
            return;
          }

          await tasksStore.write(newTasksFile);
          await stateStore.write(newSyncState);
          await storage.flush();

          res.json({
            added: result.added,
            updated: result.updated,
            removed: result.removed,
            conflicts: result.conflicts,
          });
        },
      );
    } catch (err) {
      res
        .status(500)
        .json({ error: "Pull failed: " + (err instanceof Error ? err.message : String(err)) });
    }
  });

  // push実行: POST /api/sync/push
  router.post("/api/sync/push", async (req, res) => {
    try {
      await withProjectStorage(
        projectRoot,
        { mode: "write", scope: "shared-cache" },
        async (storage) => {
          const { configStore, tasksStore, stateStore } = storage;
          const { dry_run, force } = req.body ?? {};
          const tasksFile = await tasksStore.read();
          const syncState = await stateStore.read();

          // 未解決conflictはforceでも迂回させない
          if (tasksFile.has_conflicts) {
            res.status(409).json({
              message: "未解決のコンフリクトがあります。先に resolve してください",
            });
            return;
          }

          const diffs = computeLocalDiff(tasksFile.tasks, syncState);
          if (diffs.length === 0) {
            if (dry_run) {
              res.json(formatDiffPreview([]));
              return;
            }
            res.json({ created: 0, updated: 0, skipped: 0, message: "No local changes to push" });
            return;
          }

          const config = await configStore.read();

          if (dry_run) {
            res.json(
              formatDiffPreview(diffs, { autoCreateIssues: config.sync.auto_create_issues }),
            );
            return;
          }
          const gql = await createGraphQLClient();
          const {
            result,
            tasksFile: updatedTasksFile,
            syncState: updatedSyncState,
          } = await executePush(gql, config, tasksFile, syncState, {
            force,
            saveProgress: async (tf, ss) => {
              await tasksStore.write(tf);
              await stateStore.write(ss);
              await storage.flush();
            },
          });

          await tasksStore.write(updatedTasksFile);
          await stateStore.write(updatedSyncState);
          await storage.flush();

          res.json(result);
        },
      );
    } catch (err) {
      res
        .status(500)
        .json({ error: "Push failed: " + (err instanceof Error ? err.message : String(err)) });
    }
  });

  // 同期状態取得: GET /api/sync/status
  router.get("/api/sync/status", async (_req, res) => {
    try {
      await withProjectStorage(
        projectRoot,
        { mode: "read", scope: "shared-cache" },
        async ({ tasksStore, stateStore }) => {
          const syncState = await stateStore.read();
          const tasksFile = await tasksStore.read();
          const localChanges = tasksFile.tasks.filter((task) => {
            const snapshot = syncState.snapshots[task.id];
            return !snapshot || hashTask(task) !== snapshot.hash;
          });
          res.json({
            last_synced_at: syncState.last_synced_at,
            local_changes: localChanges.length,
            total_tasks: tasksFile.tasks.length,
          });
        },
      );
    } catch {
      res.status(500).json({ error: "Failed to get sync status" });
    }
  });

  return router;
}

function computeProgress(
  task: Task,
  taskMap: Map<string, Task>,
  statusValues: Record<string, StatusValue>,
  statusFieldName: string,
  visited: Set<string> = new Set(),
): number {
  if (task.state === "closed") return 100;

  const statusName = task.custom_fields[statusFieldName] as string | undefined;
  if (statusName && statusValues[statusName]?.done) return 100;

  if (task.sub_tasks.length > 0) {
    visited.add(task.id);
    let total = 0;
    let done = 0;
    for (const childId of task.sub_tasks) {
      if (visited.has(childId)) continue;
      const child = taskMap.get(childId);
      if (child) {
        total++;
        visited.add(childId);
        done += computeProgress(child, taskMap, statusValues, statusFieldName, visited) / 100;
      }
    }
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }

  return 0;
}

function attachProgress(
  tasks: Task[],
  statusValues: Record<string, StatusValue>,
  statusFieldName: string,
): Array<Task & { _progress: number }> {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => ({
    ...task,
    _progress: computeProgress(task, taskMap, statusValues, statusFieldName),
  }));
}
