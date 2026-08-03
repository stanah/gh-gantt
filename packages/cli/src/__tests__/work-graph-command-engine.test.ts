import { describe, expect, it } from "vitest";
import type { Config, Task } from "@gh-gantt/shared";
import { WorkGraphCommandEngine } from "../work-graph/command-engine.js";

const config: Config = {
  version: "1",
  project: { name: "公開fixture", github: { owner: "example", repo: "public", project_number: 1 } },
  sync: {
    auto_create_issues: true,
    auto_push: true,
    field_mapping: { start_date: "Start", end_date: "End" },
  },
  task_types: {
    epic: { label: "Epic", display: "summary", color: "#000", github_label: "epic" },
    feature: { label: "Feature", display: "summary", color: "#222", github_label: "feature" },
    task: { label: "Task", display: "bar", color: "#111", github_label: "task" },
  },
  type_hierarchy: { epic: ["epic", "task"], feature: ["task"], task: ["task"] },
  statuses: {
    field_name: "Status",
    values: { Todo: { color: "#000", done: false }, Done: { color: "#0f0", done: true } },
  },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: Number(id.split("#")[1]),
    github_repo: "example/public",
    parent: null,
    sub_tasks: [],
    title: id,
    body: null,
    acceptance_criteria: [],
    acceptance_criteria_slot: false,
    implementer: null,
    reviewer: null,
    require_review: false,
    review_approved_by: null,
    review_approved_at: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: ["task"],
    milestone: null,
    linked_prs: [],
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    closed_at: null,
    custom_fields: { Status: "Todo" },
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

describe("[NFR-STABILITY-014-AC8] Work Graph変更commandの共通engine", () => {
  const engine = new WorkGraphCommandEngine(config, {
    now: () => "2026-08-02T01:00:00.000Z",
  });

  it("通常completeは既存review/AC gateを維持する", () => {
    const current = task("example/public#1", {
      require_review: true,
      reviewer: "reviewer",
      acceptance_criteria: [{ description: "検証する", checked: false }],
    });
    const result = engine.complete(current);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("review_gate");
  });

  it("cancelはtrusted human receiptを必須にしNOT_PLANNEDへ閉じる", () => {
    const current = task("example/public#1", {
      acceptance_criteria: [{ description: "未完了", checked: false }],
    });
    expect(engine.cancel(current, { trustedHumanApproval: false }).ok).toBe(false);
    const result = engine.cancel(current, { trustedHumanApproval: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("closed");
      expect(result.task.state_reason).toBe("NOT_PLANNED");
      expect(result.recovery.beforeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("recover_cancelはbefore fingerprint一致時だけreopenを実行する", () => {
    const current = task("example/public#1");
    const cancelled = engine.cancel(current, { trustedHumanApproval: true });
    if (!cancelled.ok) throw new Error("fixture cancel failed");
    expect(engine.recoverCancelled(cancelled.task, "0".repeat(64)).ok).toBe(false);
    const recovered = engine.recoverCancelled(cancelled.task, cancelled.recovery.beforeFingerprint);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.task.state).toBe("open");
      expect(recovered.task.state_reason).toBeNull();
    }
  });

  it("reorderは同一parentの完全 sibling 集合だけを順序変更する", () => {
    const parent = task("example/public#1", {
      type: "epic",
      sub_tasks: ["example/public#2", "example/public#3"],
    });
    const children = [
      task("example/public#2", { parent: parent.id }),
      task("example/public#3", { parent: parent.id }),
    ];
    const result = engine.planMutation([parent, ...children], {
      kind: "reorder",
      semantics: "sibling_priority",
      parentTaskId: parent.id,
      orderedSubTaskIds: [children[1]!.id, children[0]!.id],
      movedSubTaskId: children[1]!.id,
      beforeSubTaskId: children[0]!.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks.find((item) => item.id === parent.id)?.sub_tasks).toEqual([
        children[1]!.id,
        children[0]!.id,
      ]);
      expect(result.steps[0]?.operation).toBe("reprioritize");
    }
    expect(
      engine.planMutation([parent, ...children], {
        kind: "reorder",
        semantics: "sibling_priority",
        parentTaskId: parent.id,
        orderedSubTaskIds: [children[0]!.id],
        movedSubTaskId: children[0]!.id,
        afterSubTaskId: children[1]!.id,
      }).ok,
    ).toBe(false);
  });

  it("dependency追加後の全graph cycleとscope driftを拒否する", () => {
    const root = task("example/public#1", {
      type: "epic",
      sub_tasks: ["example/public#2", "example/public#3"],
    });
    const left = task("example/public#2", {
      parent: root.id,
      blocked_by: [{ task: "example/public#3", type: "finish-to-start", lag: 0 }],
    });
    const right = task("example/public#3", { parent: root.id });
    const cycle = engine.planMutation([root, left, right], {
      kind: "dependency",
      operation: "add",
      taskId: right.id,
      blockerTaskId: left.id,
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.code).toBe("dependency_cycle");

    const outside = task("other/repo#1", { github_repo: "other/repo" });
    const drift = engine.planMutation([root, left, right, outside], {
      kind: "dependency",
      operation: "add",
      taskId: left.id,
      blockerTaskId: outside.id,
    });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.code).toBe("scope_drift");
  });

  it("既存依存の追加と存在しない依存の削除をno-opとして拒否する", () => {
    const blocker = task("example/public#1");
    const target = task("example/public#2", {
      blocked_by: [{ task: blocker.id, type: "finish-to-start", lag: 0 }],
    });

    expect(
      engine.planMutation([blocker, target], {
        kind: "dependency",
        operation: "add",
        taskId: target.id,
        blockerTaskId: blocker.id,
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
    expect(
      engine.planMutation([blocker, task("example/public#3")], {
        kind: "dependency",
        operation: "remove",
        taskId: "example/public#3",
        blockerTaskId: blocker.id,
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
  });

  it("type hierarchy未設定時はparent付きaddとsplitを許可する", () => {
    const hierarchyFreeEngine = new WorkGraphCommandEngine({ ...config, type_hierarchy: {} });
    const parent = task("example/public#1", { type: "epic" });

    expect(
      hierarchyFreeEngine.planMutation([parent], {
        kind: "add",
        parentTaskId: parent.id,
        task: { clientId: "child", title: "子task", type: "task" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      hierarchyFreeEngine.planMutation([parent], {
        kind: "split",
        targetTaskId: parent.id,
        children: [
          { clientId: "first", title: "first", type: "task" },
          { clientId: "second", title: "second", type: "task" },
        ],
        sourceDisposition: "keep",
      }),
    ).toMatchObject({ ok: true });
  });

  it("schemaを介さないmerge計画でもsource重複とtarget混入を拒否する", () => {
    const target = task("example/public#1");
    const source = task("example/public#2");

    expect(
      engine.planMutation([target, source], {
        kind: "merge",
        sourceTaskIds: [source.id, source.id],
        targetTaskId: target.id,
        sourceDisposition: "close",
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
    expect(
      engine.planMutation([target, source], {
        kind: "merge",
        sourceTaskIds: [source.id, target.id],
        targetTaskId: target.id,
        sourceDisposition: "close",
      }),
    ).toMatchObject({ ok: false, code: "invalid_command" });
  });

  it("Run subtree scope内のaddはtop-level root escapeを拒否する", () => {
    const root = task("example/public#1", { type: "epic" });
    const result = engine.planMutation(
      [root],
      {
        kind: "add",
        parentTaskId: null,
        task: { clientId: "escape", title: "scope外root", type: "task" },
      },
      { scopeRootTaskId: root.id },
    );
    expect(result).toMatchObject({ ok: false, code: "scope_drift" });
  });

  it("addとsplit keepはsub_tasksを変更するparent/originを明示対象に含める", () => {
    const root = task("example/public#1", { type: "epic" });
    const add = engine.planMutation(
      [root],
      {
        kind: "add",
        parentTaskId: root.id,
        task: { clientId: "add-child", title: "追加", type: "task" },
      },
      { scopeRootTaskId: root.id },
    );
    expect(add.ok).toBe(true);
    if (add.ok) {
      expect(add.targetTaskIds).toEqual([root.id, "example/public#draft-mutation-add-child"]);
      expect(add.diff.map((item) => item.taskId)).toEqual([
        root.id,
        "example/public#draft-mutation-add-child",
      ]);
    }

    const split = engine.planMutation(
      [root],
      {
        kind: "split",
        targetTaskId: root.id,
        children: [
          { clientId: "first", title: "first", type: "task" },
          { clientId: "second", title: "second", type: "task" },
        ],
        sourceDisposition: "keep",
      },
      { scopeRootTaskId: root.id },
    );
    expect(split.ok).toBe(true);
    if (split.ok) expect(split.targetTaskIds).toContain(root.id);
  });

  it("nested descendant mutationは全ancestorとscope originをaffected targetへ閉じる", () => {
    const root = task("example/public#1", {
      type: "epic",
      sub_tasks: ["example/public#2"],
    });
    const middle = task("example/public#2", {
      type: "epic",
      parent: root.id,
      sub_tasks: ["example/public#3"],
    });
    const leaf = task("example/public#3", { parent: middle.id });
    const result = engine.planMutation(
      [root, middle, leaf],
      { kind: "cancel", targetTaskId: leaf.id, reason: "nested plan change" },
      { scopeRootTaskId: root.id },
    );
    expect(result).toMatchObject({
      ok: true,
      targetTaskIds: [root.id, middle.id, leaf.id],
    });
  });

  it("direct create/update/linkとhard-delete reconciliationを共通typed seamで検証する", () => {
    const root = task("example/public#1", { type: "epic" });
    const child = task("example/public#2", { parent: root.id });
    const created = engine.executeCommand({ type: "create", tasks: [root], task: child });
    expect(created).toMatchObject({
      ok: true,
      operation: "create",
      affectedTaskIds: [root.id, child.id],
      primitives: [{ operation: "create", targetTaskId: child.id }],
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.tasks.find((item) => item.id === root.id)?.sub_tasks).toEqual([child.id]);
    const updated = engine.executeCommand({
      type: "update",
      tasks: created.tasks,
      taskId: child.id,
      updates: { title: "更新後" },
    });
    expect(updated).toMatchObject({
      ok: true,
      operation: "update",
      primitives: [{ operation: "update", targetTaskId: child.id }],
    });
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.tasks.find((item) => item.id === child.id)?.title).toBe("更新後");
    const blocker = task("example/public#3");
    const linked = engine.executeCommand({
      type: "link",
      tasks: [...updated.tasks, blocker],
      taskId: child.id,
      operations: [{ kind: "add_dependency", blockerTaskId: blocker.id }],
    });
    expect(linked).toMatchObject({
      ok: true,
      operation: "link",
      primitives: [{ operation: "link", targetTaskId: child.id }],
    });
    if (!linked.ok) throw new Error(linked.error);
    expect(linked.tasks.find((item) => item.id === child.id)?.blocked_by).toEqual([
      { task: blocker.id, type: "finish-to-start", lag: 0 },
    ]);
    const deleted = engine.executeCommand({
      type: "hard_delete_plan",
      deletedTaskId: child.id,
      tasks: linked.tasks,
    });
    expect(deleted).toMatchObject({
      ok: true,
      operation: "hard_delete_plan",
      primitives: [{ operation: "delete", targetTaskId: child.id, after: null }],
    });
    if (!deleted.ok) throw new Error(deleted.error);
    expect(deleted.tasks.find((item) => item.id === root.id)?.sub_tasks).toEqual([]);
    expect(
      engine.executeCommand({
        type: "hard_delete_reconciliation",
        deletedTaskId: "example/public#2",
        tasks: [root],
      }),
    ).toMatchObject({
      ok: true,
      operation: "hard_delete_reconciliation",
      primitives: [{ operation: "delete", targetTaskId: "example/public#2" }],
    });
    expect(
      engine.executeCommand({
        type: "hard_delete_reconciliation",
        deletedTaskId: root.id,
        tasks: [root],
      }),
    ).toMatchObject({ ok: false, code: "dangling_reference" });
    expect(
      engine.executeCommand({ type: "proposal_v1_hard_delete", targetTaskId: root.id }),
    ).toMatchObject({ ok: false, code: "scope_drift" });
  });

  it("create・update・link・proposalの全入口でtype hierarchy違反をremote I/O前に拒否する", () => {
    const root = task("example/public#1", { type: "epic", sub_tasks: ["example/public#2"] });
    const child = task("example/public#2", { parent: root.id });
    const invalidGrandchild = task("example/public#3", { type: "feature", parent: child.id });

    expect(
      engine.executeCommand({ type: "create", tasks: [root, child], task: invalidGrandchild }),
    ).toMatchObject({ ok: false, code: "invalid_hierarchy" });
    expect(
      engine.executeCommand({
        type: "update",
        tasks: [root, child],
        taskId: child.id,
        updates: { type: "feature" },
      }),
    ).toMatchObject({ ok: false, code: "invalid_hierarchy" });
    expect(
      engine.executeCommand({
        type: "link",
        tasks: [root, child, task("example/public#4", { type: "feature" })],
        taskId: "example/public#4",
        operations: [{ kind: "set_parent", parentTaskId: child.id }],
      }),
    ).toMatchObject({ ok: false, code: "invalid_hierarchy" });
    expect(
      engine.planMutation(
        [root, child],
        {
          kind: "add",
          parentTaskId: child.id,
          task: { clientId: "invalid", title: "不正階層", type: "feature" },
        },
        { scopeRootTaskId: root.id },
      ),
    ).toMatchObject({ ok: false, code: "invalid_hierarchy" });
  });

  it("任意深さのdescendantをparentにするcycleをdirect・proposal共通検証で拒否する", () => {
    const root = task("example/public#1", {
      type: "epic",
      sub_tasks: ["example/public#2"],
    });
    const child = task("example/public#2", {
      type: "feature",
      parent: root.id,
      sub_tasks: ["example/public#3"],
    });
    const grandchild = task("example/public#3", { parent: child.id });
    const cycle = {
      ...root,
      parent: grandchild.id,
    };
    grandchild.sub_tasks = [root.id];

    expect(
      engine.executeCommand({
        type: "link",
        tasks: [root, child, grandchild],
        taskId: root.id,
        operations: [{ kind: "set_parent", parentTaskId: grandchild.id }],
      }),
    ).toMatchObject({ ok: false, code: "invalid_hierarchy" });
    expect(engine.validateGraph([cycle, child, grandchild])).toMatchObject({
      ok: false,
      code: "invalid_hierarchy",
    });
    expect(
      engine.planMutation(
        [cycle, child, grandchild],
        {
          kind: "add",
          parentTaskId: grandchild.id,
          task: { clientId: "cycle-child", title: "追加", type: "task" },
        },
        { scopeRootTaskId: root.id },
      ),
    ).toMatchObject({ ok: false, code: "invalid_hierarchy" });
  });

  it("relation/cancel stepへGitHub直列化済みremote before imageを予約する", () => {
    const source = task("example/public#1", {
      body: "本文",
      acceptance_criteria: [{ description: "確認", checked: false }],
      acceptance_criteria_slot: true,
      implementer: "builder",
      reviewer: "reviewer",
      require_review: true,
    });
    const planned = engine.planMutation([source], {
      kind: "cancel",
      targetTaskId: source.id,
      reason: "要件変更",
    });
    expect(planned).toMatchObject({ ok: true });
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.steps[0]?.payload.remoteBeforeImage).toMatchObject({
      body: expect.stringContaining("gh-gantt"),
      state: "open",
    });
    const remoteBeforeImage = planned.steps[0]!.payload.remoteBeforeImage as { body: string };
    expect(remoteBeforeImage.body).not.toBe(source.body);
  });
});
