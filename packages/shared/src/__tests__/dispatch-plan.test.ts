import { describe, expect, it } from "vitest";
import type { Config, Task } from "../types.js";
import {
  DispatchGateSnapshotSchema,
  DispatchPlanSchema,
  buildDispatchPlan,
  type DispatchPlanInput,
} from "../project-map.js";

const WORK_GRAPH_FINGERPRINT = "1".repeat(64);
const GATE_SNAPSHOT_FINGERPRINT = "2".repeat(64);
const SNAPSHOT_FINGERPRINT = "3".repeat(64);

const config: Config = {
  version: "1",
  project: { name: "P", github: { owner: "stanah", repo: "gh-gantt", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
    epic: { label: "Epic", display: "summary", color: "#111", github_label: null },
  },
  type_hierarchy: { task: [], epic: ["task"] },
  statuses: {
    field_name: "Status",
    values: {
      Todo: { color: "#000", done: false, category: "todo" },
      Doing: { color: "#000", done: false, category: "in_progress" },
      Done: { color: "#000", done: true, category: "done" },
    },
  },
  gantt: {
    default_view: "month",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#000", on_track: "#000", at_risk: "#000", overdue: "#000" },
  },
  dispatch: {
    max_concurrency: 2,
    state_concurrency: { Todo: 2 },
    repository_concurrency: { "stanah/gh-gantt": 2 },
  },
};

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  type: "task",
  github_issue: Number(id.split("#").at(-1) ?? 1),
  github_repo: "stanah/gh-gantt",
  parent: null,
  sub_tasks: [],
  title: id,
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: [],
  milestone: null,
  linked_prs: [],
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  closed_at: null,
  custom_fields: { Status: "Todo" },
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
  ...overrides,
});

const input = (tasks: Task[]): DispatchPlanInput => ({
  tasks,
  config,
  now: "2026-08-02T00:00:00.000Z",
  syncConflictTaskIds: [] as string[],
  openIterationTaskIds: [] as string[],
  reviewGateTaskIds: [] as string[],
  humanGateTaskIds: [] as string[],
  claims: [],
  registryEntityVersion: 0,
  workGraphFingerprint: WORK_GRAPH_FINGERPRINT,
  gateSnapshotFingerprint: GATE_SNAPSHOT_FINGERPRINT,
  gateSnapshotSourceRevision: "review-system:42",
  snapshotFingerprint: SNAPSHOT_FINGERPRINT,
  workspaceByTaskId: Object.fromEntries(tasks.map((item) => [item.id, `workspace:${item.id}`])),
});

describe("dispatch plan の公開 schema", () => {
  it("root の未知 field を拒否する", () => {
    const plan = buildDispatchPlan(input([task("stanah/gh-gantt#1")]));

    expect(DispatchPlanSchema.safeParse({ ...plan, unexpected: true }).success).toBe(false);
  });

  it("context・item・excluded・capacity 内の未知 field も拒否する", () => {
    const plan = buildDispatchPlan(input([task("stanah/gh-gantt#1")]));
    const invalidPlans = [
      { ...plan, context: { ...plan.context, unexpected: true } },
      { ...plan, selected: [{ ...plan.selected[0]!, unexpected: true }] },
      {
        ...plan,
        excluded: [{ taskId: "stanah/gh-gantt#2", reason: "already_done", unexpected: true }],
      },
      { ...plan, capacity: { ...plan.capacity, unexpected: true } },
      {
        ...plan,
        capacity: {
          ...plan.capacity,
          global: { ...plan.capacity.global, unexpected: true },
        },
      },
    ];

    expect(
      invalidPlans.every((candidate) => !DispatchPlanSchema.safeParse(candidate).success),
    ).toBe(true);
  });

  it("generatedAt の不正な日時を拒否する", () => {
    const plan = buildDispatchPlan(input([task("stanah/gh-gantt#1")]));

    expect(DispatchPlanSchema.safeParse({ ...plan, generatedAt: "not-a-timestamp" }).success).toBe(
      false,
    );
  });

  it("未知の exclusion reason を拒否する", () => {
    const plan = buildDispatchPlan(input([task("stanah/gh-gantt#1")]));

    expect(
      DispatchPlanSchema.safeParse({
        ...plan,
        excluded: [{ taskId: "stanah/gh-gantt#2", reason: "unknown_reason" }],
      }).success,
    ).toBe(false);
  });

  it("capacity の負数と導出値の不整合を拒否する", () => {
    const plan = buildDispatchPlan(input([task("stanah/gh-gantt#1")]));
    const negative = {
      ...plan,
      capacity: {
        ...plan.capacity,
        global: { ...plan.capacity.global, used: -1 },
      },
    };
    const inconsistent = {
      ...plan,
      capacity: {
        ...plan.capacity,
        global: { ...plan.capacity.global, remaining: plan.capacity.global.remaining + 1 },
      },
    };

    expect([
      DispatchPlanSchema.safeParse(negative).success,
      DispatchPlanSchema.safeParse(inconsistent).success,
    ]).toEqual([false, false]);
  });

  it("builder の返却前に fingerprint を含む完全な plan を検証する", () => {
    const invalidInput = input([task("stanah/gh-gantt#1")]);
    invalidInput.snapshotFingerprint = "not-a-fingerprint";

    expect(() => buildDispatchPlan(invalidInput)).toThrow();
  });
});

describe("dispatch gate snapshot の公開 schema", () => {
  it("authoritative source の revision と観測時刻を含む strict snapshot だけを受理する", () => {
    const snapshot = {
      schemaVersion: "1",
      sourceRevision: "review-system:42",
      observedAt: "2026-08-02T00:00:00.000Z",
      reviewGateTaskIds: ["stanah/gh-gantt#1"],
      humanGateTaskIds: ["stanah/gh-gantt#2"],
    } as const;

    expect(DispatchGateSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(DispatchGateSnapshotSchema.safeParse({ ...snapshot, unexpected: true }).success).toBe(
      false,
    );
    expect(
      DispatchGateSnapshotSchema.safeParse({ ...snapshot, observedAt: "not-a-timestamp" }).success,
    ).toBe(false);
  });
});

describe("[NFR-STABILITY-014-AC9] ready frontier を gate と容量の交差から安定導出する", () => {
  it("stable task ID 順に global concurrency まで選ぶ", () => {
    const result = buildDispatchPlan(
      input([task("stanah/gh-gantt#3"), task("stanah/gh-gantt#1"), task("stanah/gh-gantt#2")]),
    );

    expect(result.selected.map((item) => item.taskId)).toEqual([
      "stanah/gh-gantt#1",
      "stanah/gh-gantt#2",
    ]);
    expect(result.excluded).toContainEqual({
      taskId: "stanah/gh-gantt#3",
      reason: "global_capacity",
    });
    expect(result).toMatchObject({ planVersion: "1", registryEntityVersion: 0 });
    expect(result.planId).toContain("dispatch-plan:v1:r0:selected:stanah/gh-gantt#1");
  });

  it("dependency・review/human・sync conflict・open iteration・親コンテナを除外する", () => {
    const upstream = task("stanah/gh-gantt#1");
    const blocked = task("stanah/gh-gantt#2", {
      blocked_by: [{ task: upstream.id, type: "finish-to-start", lag: 0 }],
    });
    const review = task("stanah/gh-gantt#3");
    const human = task("stanah/gh-gantt#4");
    const conflict = task("stanah/gh-gantt#5");
    const iteration = task("stanah/gh-gantt#6");
    const parent = task("stanah/gh-gantt#7", { type: "epic", sub_tasks: [upstream.id] });
    const data = input([upstream, blocked, review, human, conflict, iteration, parent]);
    data.reviewGateTaskIds = [review.id];
    data.humanGateTaskIds = [human.id];
    data.syncConflictTaskIds = [conflict.id];
    data.openIterationTaskIds = [iteration.id];

    const result = buildDispatchPlan(data);
    expect(
      Object.fromEntries(result.excluded.map((item) => [item.taskId, item.reason])),
    ).toMatchObject({
      [blocked.id]: "dependency_blocked",
      [review.id]: "review_gate",
      [human.id]: "human_gate",
      [conflict.id]: "sync_conflict",
      [iteration.id]: "open_iteration",
      [parent.id]: "parent_container",
    });
  });

  it("未知の gate task ID が一件でもあれば frontier 全体を停止する", () => {
    const data = input([task("stanah/gh-gantt#1"), task("stanah/gh-gantt#2")]);
    data.humanGateTaskIds = ["stanah/gh-gantt#999"];

    expect(buildDispatchPlan(data)).toMatchObject({
      selected: [],
      excluded: [
        { taskId: "stanah/gh-gantt#1", reason: "gate_snapshot_inconsistent" },
        { taskId: "stanah/gh-gantt#2", reason: "gate_snapshot_inconsistent" },
      ],
    });
  });

  it("active claim を三層の使用数に含めて task と workspace の二重選択を防ぐ", () => {
    const first = task("stanah/gh-gantt#1");
    const second = task("stanah/gh-gantt#2");
    const third = task("stanah/gh-gantt#3");
    const data = input([first, second, third]);
    data.claims = [
      {
        taskId: first.id,
        repository: "stanah/gh-gantt",
        state: "Todo",
        ownerId: "owner:1",
        workspaceId: "workspace:occupied",
        runId: "run:1",
        claimId: "claim:1",
        entityVersion: 1,
        acquiredAt: "2026-08-01T23:00:00.000Z",
        expiresAt: "2026-08-02T01:00:00.000Z",
      },
    ];
    data.workspaceByTaskId[second.id] = "workspace:occupied";

    const result = buildDispatchPlan(data);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.taskId).toBe(third.id);
    expect(result.excluded).toContainEqual({ taskId: first.id, reason: "active_claim" });
    expect(result.excluded).toContainEqual({ taskId: second.id, reason: "workspace_claimed" });
  });

  it("state と repository の残 slot の交差だけを選ぶ", () => {
    const first = task("stanah/gh-gantt#1");
    const sameState = task("stanah/gh-gantt#2", { github_repo: "other/repository" });
    const sameRepository = task("stanah/gh-gantt#3", {
      custom_fields: { Status: "Queued" },
    });
    const data = input([first, sameState, sameRepository]);
    data.config = {
      ...config,
      statuses: {
        ...config.statuses,
        values: {
          ...config.statuses.values,
          Queued: { color: "#000", done: false, category: "todo" },
        },
      },
      dispatch: {
        max_concurrency: 3,
        state_concurrency: { Todo: 1 },
        repository_concurrency: { "stanah/gh-gantt": 1 },
      },
    };

    expect(buildDispatchPlan(data)).toMatchObject({
      selected: [{ taskId: first.id }],
      excluded: [
        { taskId: sameState.id, reason: "state_capacity" },
        { taskId: sameRepository.id, reason: "repository_capacity" },
      ],
    });
  });

  it("上流完了後の再評価だけで fan-in を frontier に入れる", () => {
    const upstreamA = task("stanah/gh-gantt#1");
    const upstreamB = task("stanah/gh-gantt#2");
    const downstream = task("stanah/gh-gantt#3", {
      blocked_by: [
        { task: upstreamA.id, type: "finish-to-start", lag: 0 },
        { task: upstreamB.id, type: "finish-to-start", lag: 0 },
      ],
    });
    expect(
      buildDispatchPlan(input([upstreamA, upstreamB, downstream])).selected.map(
        (item) => item.taskId,
      ),
    ).not.toContain(downstream.id);

    const completed = [
      { ...upstreamA, state: "closed" as const },
      { ...upstreamB, state: "closed" as const },
      downstream,
    ];
    expect(buildDispatchPlan(input(completed)).selected.map((item) => item.taskId)).toContain(
      downstream.id,
    );
  });

  it("期限切れ claim は reclaim まで再 dispatch せず、不整合 snapshot は全候補を停止する", () => {
    const candidate = task("stanah/gh-gantt#1");
    const expired = input([candidate]);
    expired.claims = [
      {
        taskId: candidate.id,
        repository: "stanah/gh-gantt",
        state: "Todo",
        ownerId: "owner:expired",
        workspaceId: expired.workspaceByTaskId[candidate.id]!,
        runId: "run:expired",
        claimId: "claim:expired",
        entityVersion: 1,
        acquiredAt: "2026-08-01T22:00:00.000Z",
        expiresAt: "2026-08-01T23:00:00.000Z",
      },
    ];
    expect(buildDispatchPlan(expired)).toMatchObject({
      selected: [],
      excluded: [{ taskId: candidate.id, reason: "claim_reclaim_required" }],
    });

    const inconsistent = input([candidate]);
    inconsistent.claims = [expired.claims[0]!, { ...expired.claims[0]!, claimId: "claim:other" }];
    expect(buildDispatchPlan(inconsistent)).toMatchObject({
      selected: [],
      excluded: [{ taskId: candidate.id, reason: "registry_snapshot_inconsistent" }],
    });

    const unknownClaimState = input([candidate]);
    unknownClaimState.claims = [
      {
        ...expired.claims[0]!,
        state: "Unknown",
        expiresAt: "2026-08-02T01:00:00.000Z",
      },
    ];
    expect(buildDispatchPlan(unknownClaimState)).toMatchObject({
      selected: [],
      excluded: [{ taskId: candidate.id, reason: "registry_snapshot_inconsistent" }],
    });
  });
});
