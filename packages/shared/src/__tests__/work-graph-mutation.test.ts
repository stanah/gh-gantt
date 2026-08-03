import { describe, expect, it } from "vitest";
import {
  MutationPolicyConfigSchema,
  MutationProposalCommandSchema,
  MutationPrimitiveStepSchema,
  MutationProposalViewSchema,
  WorkGraphMutationIntentSchema,
  mutationCommandFingerprint,
} from "../work-graph-mutation.js";

const actor = { id: "planner-1", role: "planner" as const };

describe("[NFR-STABILITY-014-AC8] Work Graph mutation 公開 contract", () => {
  it("split/add/merge/reorder/cancel/dependency を strict intent として受理する", () => {
    const intents = [
      {
        kind: "split",
        targetTaskId: "stanah/gh-gantt#10",
        children: [
          { clientId: "child-a", title: "子A", type: "task" },
          { clientId: "child-b", title: "子B", type: "task" },
        ],
        sourceDisposition: "keep",
      },
      {
        kind: "add",
        parentTaskId: "stanah/gh-gantt#10",
        task: { clientId: "child-b", title: "子B", type: "task" },
      },
      {
        kind: "merge",
        sourceTaskIds: ["stanah/gh-gantt#11", "stanah/gh-gantt#12"],
        targetTaskId: "stanah/gh-gantt#10",
        sourceDisposition: "close",
      },
      {
        kind: "reorder",
        semantics: "sibling_priority",
        parentTaskId: "stanah/gh-gantt#10",
        orderedSubTaskIds: ["stanah/gh-gantt#12", "stanah/gh-gantt#11"],
        movedSubTaskId: "stanah/gh-gantt#12",
        beforeSubTaskId: "stanah/gh-gantt#11",
      },
      { kind: "cancel", targetTaskId: "stanah/gh-gantt#10", reason: "要件が失効した" },
      {
        kind: "dependency",
        operation: "add",
        taskId: "stanah/gh-gantt#12",
        blockerTaskId: "stanah/gh-gantt#11",
      },
    ];

    expect(intents.every((intent) => WorkGraphMutationIntentSchema.safeParse(intent).success)).toBe(
      true,
    );
  });

  it("caller supplied diff/risk/approval と表示行順 reorder と永久 delete を拒否する", () => {
    const base = {
      schemaVersion: "1",
      commandId: "cmd-1",
      type: "propose",
      actor,
      originRunId: "run-331",
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
      intent: {
        kind: "cancel",
        targetTaskId: "stanah/gh-gantt#10",
        reason: "要件が失効した",
      },
    };
    expect(MutationProposalCommandSchema.safeParse({ ...base, risk: "low" }).success).toBe(false);
    expect(MutationProposalCommandSchema.safeParse({ ...base, approval: "auto" }).success).toBe(
      false,
    );
    expect(
      MutationProposalCommandSchema.safeParse({ ...base, before: {}, after: {} }).success,
    ).toBe(false);
    expect(
      WorkGraphMutationIntentSchema.safeParse({
        kind: "reorder",
        semantics: "project_item_position",
        orderedTaskIds: ["stanah/gh-gantt#10"],
      }).success,
    ).toBe(false);
    expect(
      WorkGraphMutationIntentSchema.safeParse({
        kind: "reorder",
        semantics: "sibling_priority",
        parentTaskId: "stanah/gh-gantt#10",
        orderedSubTaskIds: ["stanah/gh-gantt#11", "stanah/gh-gantt#11"],
        movedSubTaskId: "stanah/gh-gantt#11",
        beforeSubTaskId: "stanah/gh-gantt#12",
        afterSubTaskId: "stanah/gh-gantt#10",
      }).success,
    ).toBe(false);
    expect(
      WorkGraphMutationIntentSchema.safeParse({
        kind: "merge",
        sourceTaskIds: ["stanah/gh-gantt#11", "stanah/gh-gantt#11"],
        targetTaskId: "stanah/gh-gantt#10",
        sourceDisposition: "close",
      }).success,
    ).toBe(false);
    expect(
      WorkGraphMutationIntentSchema.safeParse({ kind: "delete", targetTaskId: "x/y#1" }).success,
    ).toBe(false);
  });

  it("同じ command は key 順に依存しない fingerprint へ収束する", () => {
    const left = {
      schemaVersion: "1",
      commandId: "cmd-1",
      type: "apply",
      actor,
      proposalId: "proposal-1",
      expectedRevision: 2,
    } as const;
    const right = {
      proposalId: "proposal-1",
      actor: { role: "planner", id: "planner-1" },
      type: "apply",
      expectedRevision: 2,
      commandId: "cmd-1",
      schemaVersion: "1",
    } as const;
    const leftFingerprint = mutationCommandFingerprint(left);
    expect(leftFingerprint).toBe(mutationCommandFingerprint(right));
    expect(leftFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("human decide は caller actor/evidenceを拒否しcomment refだけを受理する", () => {
    const decide = {
      schemaVersion: "1",
      commandId: "decide-1",
      type: "decide",
      proposalId: "proposal-1",
      expectedRevision: 1,
      approvalCommentRef: {
        repository: "stanah/gh-gantt",
        issueNumber: 331,
        commentId: "IC_kwDOExample",
      },
    };
    expect(MutationProposalCommandSchema.safeParse(decide).success).toBe(true);
    expect(MutationProposalCommandSchema.safeParse({ ...decide, actor }).success).toBe(false);
    expect(
      MutationProposalCommandSchema.safeParse({
        ...decide,
        evidence: { id: "fake", kind: "human_decision" },
      }).success,
    ).toBe(false);
  });

  it("policy 未設定を許容し、rule は全 dimension の明示一致を要求する", () => {
    expect(MutationPolicyConfigSchema.safeParse(undefined).success).toBe(true);
    const policy = {
      schema_version: "1",
      policy_id: "safe-local-edits",
      version: "1",
      rules: [
        {
          id: "rule-1",
          mutation_kinds: ["dependency"],
          repositories: ["stanah/gh-gantt"],
          root_task_ids: ["stanah/gh-gantt#331"],
          task_types: ["task"],
          max_operations: 2,
          max_affected_tasks: 3,
          max_risk: "low",
        },
      ],
    };
    expect(MutationPolicyConfigSchema.safeParse(policy).success).toBe(true);
    expect(
      MutationPolicyConfigSchema.safeParse({
        ...policy,
        rules: [{ ...policy.rules[0], repositories: undefined }],
      }).success,
    ).toBe(false);
    expect(MutationPolicyConfigSchema.safeParse({ ...policy, schema_version: "2" }).success).toBe(
      false,
    );
  });

  it("default view は bounded summary だけを受理する", () => {
    const view = {
      schemaVersion: "1",
      total: 2,
      limit: 1,
      truncated: true,
      items: [
        {
          proposalId: "proposal-1",
          revision: 1,
          status: "awaiting_human",
          mutationKind: "cancel",
          targetTaskIds: ["stanah/gh-gantt#10"],
          risk: "destructive",
          proposedBy: actor,
          createdAt: "2026-08-02T00:00:00.000Z",
          expiresAt: "2026-08-03T00:00:00.000Z",
        },
      ],
    };
    expect(MutationProposalViewSchema.parse(view)).toEqual(view);
    expect(
      MutationProposalViewSchema.safeParse({ ...view, items: [...view.items, ...view.items] })
        .success,
    ).toBe(false);
  });

  it("remote identifiers付きprimitive stepをstrict schemaで保存できる", () => {
    expect(
      MutationPrimitiveStepSchema.parse({
        stepId: "step-0001",
        operation: "create",
        targetTaskId: "stanah/gh-gantt#draft-mutation-child",
        payload: {},
        beforeImage: null,
        expectedPostcondition: {},
        state: "unknown",
        diagnostic: "remote commit後のlocal finalize未確認",
        remoteIdentifiers: {
          issueId: "I_PUBLIC_331",
          issueNumber: 331,
          projectItemId: "PVTI_PUBLIC_331",
        },
        correlationToken: "proposal-331:plan:step-0001",
        recoveryIntent: null,
      }).remoteIdentifiers,
    ).toEqual({
      issueId: "I_PUBLIC_331",
      issueNumber: 331,
      projectItemId: "PVTI_PUBLIC_331",
    });
  });
});
