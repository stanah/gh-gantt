import { describe, expect, it, vi } from "vitest";
import { mutationCommandFingerprint } from "@gh-gantt/shared";
import type { Config, MutationProposal, MutationProposalReceipt, Task } from "@gh-gantt/shared";
import { WorkGraphCommandEngine } from "../work-graph/command-engine.js";
import {
  MutationProposalControlPlane,
  type MutationProposalAuditEvent,
  type MutationCoordinationCapability,
  type MutationProposalEnvironment,
  type MutationProposalRepository,
} from "../work-graph/mutation-control-plane.js";
import type { TrustedHumanApprovalReceipt } from "../work-graph/human-approval-authority.js";
import type {
  MutationApplicationClaimInput,
  MutationApplicationLease,
  MutationProposalRecordOptions,
  MutationProposalRecordResult,
  MutationProposalRegistry,
} from "../store/mutation-proposals.js";

function memoryMutationCoordination(): MutationCoordinationCapability {
  let fencingToken = 0;
  return {
    async reserveMutation(proposal, _expectedEntityVersion, ownerNonce) {
      fencingToken += 1;
      return {
        accepted: true,
        entityVersion: fencingToken,
        reservation: {
          proposalId: proposal.proposalId,
          ownerNonce,
          fencingToken,
          affectedTaskIds: [...proposal.targetTaskIds],
          expiresAt: "2099-01-01T00:00:00.000Z",
          sideEffectState: "idle",
        },
      };
    },
    async beginMutationSideEffect(proof) {
      return { ...proof, sideEffectState: "in_flight" };
    },
    async completeMutationSideEffect(proof) {
      return { ...proof, sideEffectState: "idle" };
    },
    async releaseMutationReservation() {
      return true;
    },
    async withMutationReservation(_proof, operation) {
      return operation();
    },
  };
}

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
    task: { label: "Task", display: "bar", color: "#111", github_label: "task" },
  },
  type_hierarchy: { epic: ["task"], task: [] },
  statuses: { field_name: "Status", values: { Todo: { color: "#000", done: false } } },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

const epic: Task = {
  id: "example/public#331",
  type: "epic",
  github_issue: 331,
  github_repo: "example/public",
  parent: null,
  sub_tasks: [],
  title: "Epic",
  body: null,
  acceptance_criteria: [],
  state: "open",
  state_reason: null,
  assignees: [],
  labels: ["epic"],
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
};

class MemoryRepository implements MutationProposalRepository {
  now = "2026-08-02T01:00:00.000Z";
  retainApplicationLease = false;
  registry: MutationProposalRegistry = {
    schemaVersion: "1",
    projectIdentity: "example/public#1",
    revision: 0,
    proposals: [],
    commandReceipts: [],
    applicationLeases: [],
  };
  async readAll() {
    return structuredClone(this.registry);
  }
  async recordReceipt(
    proposal: MutationProposal,
    receipt: MutationProposalReceipt,
    options: MutationProposalRecordOptions = {},
  ): Promise<MutationProposalRecordResult> {
    const proposalIndex = this.registry.proposals.findIndex(
      (item) => item.proposalId === proposal.proposalId,
    );
    const currentProposal = proposalIndex >= 0 ? this.registry.proposals[proposalIndex]! : null;
    if (
      options.expectedProposalRevision === null
        ? currentProposal !== null
        : options.expectedProposalRevision !== undefined &&
          currentProposal?.revision !== options.expectedProposalRevision
    ) {
      return {
        ok: false,
        code: "stale_revision",
        currentProposal: structuredClone(currentProposal),
      };
    }
    if (
      currentProposal &&
      options.allowedStatuses &&
      !options.allowedStatuses.includes(currentProposal.status)
    ) {
      return {
        ok: false,
        code: "invalid_lifecycle",
        currentProposal: structuredClone(currentProposal),
      };
    }
    if (proposalIndex >= 0) this.registry.proposals[proposalIndex] = structuredClone(proposal);
    else this.registry.proposals.push(structuredClone(proposal));
    const receiptIndex = this.registry.commandReceipts.findIndex(
      (item) => item.commandId === receipt.commandId,
    );
    const stored = {
      commandId: receipt.commandId,
      commandFingerprint: receipt.commandFingerprint,
      receipt: structuredClone(receipt),
    };
    if (receiptIndex >= 0) this.registry.commandReceipts[receiptIndex] = stored;
    else this.registry.commandReceipts.push(stored);
    this.registry.revision += 1;
    return { ok: true };
  }
  async acknowledgeAudit(proposalId: string, eventId: string, expectedRevision: number) {
    const proposal = this.registry.proposals.find((item) => item.proposalId === proposalId);
    if (!proposal || proposal.revision !== expectedRevision) return false;
    proposal.pendingAudits = proposal.pendingAudits.filter((item) => item.eventId !== eventId);
    proposal.pendingAuditEventIds = proposal.pendingAuditEventIds.filter((id) => id !== eventId);
    return true;
  }
  async claimApplication(input: MutationApplicationClaimInput) {
    const current = this.registry.applicationLeases.find(
      (lease) => lease.proposalId === input.proposalId,
    );
    if (
      current &&
      Date.parse(current.expiresAt) > Date.parse(this.now) &&
      current.ownerNonce !== input.ownerNonce
    ) {
      return { ok: false as const, code: "application_in_progress" as const, lease: current };
    }
    const lease: MutationApplicationLease = {
      proposalId: input.proposalId,
      commandId: input.commandId,
      commandFingerprint: input.commandFingerprint,
      ownerNonce: input.ownerNonce,
      fencingToken: (current?.fencingToken ?? 0) + 1,
      stepId: null,
      expiresAt: new Date(Date.parse(this.now) + input.leaseDurationSeconds * 1000).toISOString(),
    };
    this.registry.applicationLeases = [lease];
    return { ok: true as const, lease: structuredClone(lease) };
  }
  async fenceApplication(input: {
    lease: MutationApplicationLease;
    stepId: string;
    leaseDurationSeconds: number;
  }) {
    const next = {
      ...input.lease,
      fencingToken: input.lease.fencingToken + 1,
      stepId: input.stepId,
      expiresAt: new Date(Date.parse(this.now) + input.leaseDurationSeconds * 1000).toISOString(),
    };
    this.registry.applicationLeases = [next];
    return { ok: true as const, lease: structuredClone(next) };
  }
  async releaseApplication(lease: MutationApplicationLease) {
    if (this.retainApplicationLease) return false;
    this.registry.applicationLeases = this.registry.applicationLeases.filter(
      (candidate) => candidate.ownerNonce !== lease.ownerNonce,
    );
    return true;
  }
}

describe("[NFR-STABILITY-014-AC8] mutation proposal制御プレーン", () => {
  it.each([
    "reserveMutation",
    "beginMutationSideEffect",
    "completeMutationSideEffect",
    "releaseMutationReservation",
    "withMutationReservation",
  ] as const)("coordination capabilityの%s欠落を副作用前に拒否する", (missingMethod) => {
    const repositoryMethods = {
      readAll: vi.fn(),
      recordReceipt: vi.fn(),
      acknowledgeAudit: vi.fn(),
      claimApplication: vi.fn(),
      fenceApplication: vi.fn(),
      releaseApplication: vi.fn(),
    };
    const coordinationMethods: Record<string, ReturnType<typeof vi.fn>> = {
      reserveMutation: vi.fn(),
      beginMutationSideEffect: vi.fn(),
      completeMutationSideEffect: vi.fn(),
      releaseMutationReservation: vi.fn(),
      withMutationReservation: vi.fn(),
    };
    const lifecycleMethods = {
      loadSnapshot: vi.fn(),
      resolveOrigin: vi.fn(),
      validateApply: vi.fn(),
      verifyHumanApproval: vi.fn(),
      appendAudit: vi.fn(),
    };
    const remoteExecutor = vi.fn();
    delete coordinationMethods[missingMethod];

    expect(
      () =>
        new MutationProposalControlPlane(
          repositoryMethods as never,
          new WorkGraphCommandEngine(config),
          {
            ...lifecycleMethods,
            executeStep: remoteExecutor,
            mutationCoordination: coordinationMethods,
          } as never,
        ),
    ).toThrow(`mutation coordination capabilityが不完全です: ${missingMethod}`);
    for (const method of Object.values(repositoryMethods)) expect(method).not.toHaveBeenCalled();
    for (const method of Object.values(lifecycleMethods)) expect(method).not.toHaveBeenCalled();
    for (const method of Object.values(coordinationMethods)) expect(method).not.toHaveBeenCalled();
    expect(remoteExecutor).not.toHaveBeenCalled();
  });

  it("human approval→partial apply→explicit reconcile→auditへexact retryで収束する", async () => {
    const repository = new MemoryRepository();
    const audits: MutationProposalAuditEvent[] = [];
    const executed: string[] = [];
    let failInvalidationOnce = true;
    let reservation:
      | {
          proposalId: string;
          ownerNonce: string;
          fencingToken: number;
          affectedTaskIds: string[];
          expiresAt: string;
          sideEffectState: "idle" | "in_flight";
        }
      | undefined;
    let completedReconcileReservation = false;
    let failReconcileReadOnce = true;
    let failIdleReleaseOnce = false;
    const mutationCoordination: MutationCoordinationCapability = {
      async reserveMutation(proposal, _version, ownerNonce) {
        reservation = {
          proposalId: proposal.proposalId,
          ownerNonce,
          fencingToken: (reservation?.fencingToken ?? 0) + 1,
          affectedTaskIds: proposal.targetTaskIds,
          expiresAt: "2026-08-02T02:00:00.000Z",
          sideEffectState: reservation?.sideEffectState ?? "idle",
        };
        return { accepted: true, entityVersion: reservation.fencingToken, reservation };
      },
      async beginMutationSideEffect(proof) {
        reservation = {
          ...proof,
          fencingToken: proof.fencingToken + 1,
          sideEffectState: "in_flight",
        };
        return reservation;
      },
      async completeMutationSideEffect(proof) {
        completedReconcileReservation = true;
        reservation = {
          ...proof,
          fencingToken: proof.fencingToken + 1,
          sideEffectState: "idle",
        };
        return reservation;
      },
      async releaseMutationReservation(proof) {
        if (proof.sideEffectState === "in_flight") return false;
        if (failIdleReleaseOnce) {
          failIdleReleaseOnce = false;
          throw new Error("reservation release unavailable");
        }
        reservation = undefined;
        return true;
      },
      async withMutationReservation(_proof, operation) {
        return operation();
      },
    };
    const environment: MutationProposalEnvironment = {
      mutationCoordination,
      async loadSnapshot() {
        return {
          config,
          tasks: [epic],
          sourceRevision: "revision-1",
          snapshotFingerprint: "b".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "dev-role-fixed@1",
            mutationCheckpointId: "checkpoint-331",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "c".repeat(64) };
      },
      async verifyHumanApproval(boundDecision, commentRef) {
        const receipt: TrustedHumanApprovalReceipt = {
          schemaVersion: "1",
          decision: "approve",
          actor: { id: "U_reviewer", role: "human" },
          repository: commentRef.repository,
          issueNumber: commentRef.issueNumber,
          commentId: commentRef.commentId,
          bodyHash: "d".repeat(64),
          commentUpdatedAt: "2026-08-02T01:00:00.000Z",
          verifiedAt: "2026-08-02T01:01:00.000Z",
          viewerNodeId: "U_agent",
          authorityConfigFingerprint: "e".repeat(64),
          boundDecision,
        };
        return { ok: true, receipt };
      },
      async executeStep(step, _proposal, _fence, recordRemoteOutcome) {
        executed.push(step.stepId);
        if (step.stepId === "step-0002") {
          const unknown = {
            state: "unknown" as const,
            diagnostic: "create response unknown",
            remoteIdentifiers: { issueId: "I_PUBLIC_UNKNOWN" },
          };
          await recordRemoteOutcome?.(unknown);
          return unknown;
        }
        return { state: "committed", diagnostic: null };
      },
      async reconcileStep() {
        if (failReconcileReadOnce) {
          failReconcileReadOnce = false;
          throw new Error("live query unavailable");
        }
        return { state: "reconciled", diagnostic: null };
      },
      async appendAudit(event) {
        if (event.type === "work_graph_invalidated" && failInvalidationOnce) {
          failInvalidationOnce = false;
          throw new Error("active_attempt_conflict");
        }
        audits.push(event);
      },
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(config, { now: () => "2026-08-02T01:00:00.000Z" }),
      environment,
      { now: () => "2026-08-02T01:00:00.000Z", nextId: () => "proposal-331" },
    );

    const proposed = await control.execute({
      schemaVersion: "1",
      commandId: "propose-1",
      type: "propose",
      actor: { id: "planner-1", role: "planner" },
      originRunId: "run-331",
      intent: {
        kind: "split",
        targetTaskId: epic.id,
        children: [
          { clientId: "a", title: "子A", type: "task" },
          { clientId: "b", title: "子B", type: "task" },
        ],
        sourceDisposition: "keep",
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    expect(proposed).toMatchObject({ accepted: true, status: "awaiting_human" });
    expect(proposed.approvalRequest?.machineBlock).toContain("mutation-approval:v1");
    await expect(
      control.inspect({ proposalId: "proposal-331", full: true, limit: 1, offset: 0 }),
    ).resolves.toMatchObject({
      approvalRequests: [
        expect.objectContaining({
          purpose: "decision",
          proposalId: "proposal-331",
          revision: proposed.revision,
          proposalFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          expiresAt: "2026-08-03T00:00:00.000Z",
          machineBlock: expect.stringContaining("mutation-approval:v1"),
        }),
      ],
    });
    const proposedSteps = repository.registry.proposals[0]!.steps;
    expect(proposedSteps[0]!.correlationToken).toBe(
      `mutation:proposal-331:${repository.registry.proposals[0]!.planFingerprint}:step-0001`,
    );
    expect(proposedSteps[1]!.correlationToken).toBe(
      `mutation:proposal-331:${repository.registry.proposals[0]!.planFingerprint}:step-0002`,
    );

    const decided = await control.execute({
      schemaVersion: "1",
      commandId: "decide-1",
      type: "decide",
      proposalId: "proposal-331",
      expectedRevision: 1,
      approvalCommentRef: {
        repository: "example/public",
        issueNumber: 331,
        commentId: "IC_public",
      },
    });
    expect(decided).toMatchObject({ accepted: true, status: "approved" });

    const apply = {
      schemaVersion: "1" as const,
      commandId: "apply-1",
      type: "apply" as const,
      actor: { id: "orchestrator-1", role: "orchestrator" as const },
      proposalId: "proposal-331",
      expectedRevision: 2,
    };
    const partial = await control.execute(apply);
    expect(partial).toMatchObject({
      accepted: false,
      status: "partially_applied",
      errorCode: "side_effect_unknown",
    });
    expect(executed).toEqual(["step-0001", "step-0002"]);
    expect(repository.registry.proposals[0]!.steps[1]!.remoteIdentifiers).toEqual({
      issueId: "I_PUBLIC_UNKNOWN",
    });
    expect(reservation?.sideEffectState).toBe("in_flight");
    completedReconcileReservation = false;
    const retry = await control.execute(apply);
    expect(retry).toEqual(partial);
    expect(executed).toEqual(["step-0001", "step-0002"]);

    const reconcileCommand = {
      schemaVersion: "1",
      commandId: "reconcile-unavailable",
      type: "reconcile" as const,
      actor: { id: "orchestrator-1", role: "orchestrator" as const },
      proposalId: "proposal-331",
      expectedRevision: partial.revision,
      stepId: "step-0002",
      resolution: "confirm_committed" as const,
      evidence: {
        id: "evidence-remote-postcondition",
        kind: "side_effect_reconciliation" as const,
        source: "github-live-query",
        summary: "correlation tokenに一致するIssueがexactly one",
        observedAt: "2026-08-02T01:02:00.000Z",
        sideEffectState: "reconciled" as const,
      },
    };
    const unavailable = await control.execute(reconcileCommand);
    expect(unavailable).toMatchObject({
      accepted: false,
      status: "partially_applied",
      errorCode: "side_effect_unknown",
    });
    expect(unavailable.diagnostic).toContain("live query unavailable");
    expect(reservation?.sideEffectState).toBe("in_flight");

    const exactReconcile = {
      ...reconcileCommand,
      commandId: "reconcile-1",
      expectedRevision: unavailable.revision,
    };
    failIdleReleaseOnce = true;
    await expect(control.execute(exactReconcile)).rejects.toThrow(
      "reservation release unavailable",
    );
    expect(repository.registry.proposals[0]).toMatchObject({ status: "reconciling" });
    const reconciled = await control.execute(exactReconcile);
    expect(reconciled).toMatchObject({ accepted: true, status: "approved" });
    expect(completedReconcileReservation).toBe(true);
    expect(reservation).toBeUndefined();

    const applyAudit = {
      ...apply,
      commandId: "apply-2",
      expectedRevision: reconciled.revision,
    };
    const auditPending = await control.execute(applyAudit);
    expect(auditPending).toMatchObject({
      accepted: false,
      status: "pending_audit",
      errorCode: "audit_pending",
    });
    const completed = await control.execute(applyAudit);
    expect(completed).toMatchObject({ accepted: true, status: "applied" });
    expect(audits.some((event) => event.type === "work_graph_invalidated")).toBe(true);
  });

  it("同じcommandIdのpayload mismatchをstate unchangedで拒否しbounded viewを返す", async () => {
    const repository = new MemoryRepository();
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        return {
          config,
          tasks: [epic],
          sourceRevision: "r1",
          snapshotFingerprint: "b".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "p",
            planVersion: "1",
            authorityId: "p@1",
            mutationCheckpointId: "checkpoint",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "c".repeat(64) };
      },
      async verifyHumanApproval() {
        return { ok: false, code: "human_gate_required", diagnostic: "not configured" };
      },
      async executeStep() {
        return { state: "committed", diagnostic: null };
      },
      async appendAudit() {},
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(config),
      environment,
      { now: () => "2026-08-02T01:00:00.000Z", nextId: () => "proposal-1" },
    );
    const command = {
      schemaVersion: "1" as const,
      commandId: "same",
      type: "propose" as const,
      actor: { id: "planner", role: "planner" as const },
      originRunId: "run",
      intent: { kind: "cancel" as const, targetTaskId: epic.id, reason: "不要" },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    };
    await control.execute(command);
    const mismatch = await control.execute({ ...command, expiresAt: "2026-08-04T00:00:00.000Z" });
    expect(mismatch).toMatchObject({
      accepted: false,
      errorCode: "command_payload_mismatch",
      stateUnchanged: true,
    });
    const view = await control.inspect({ limit: 1 });
    expect(view).toMatchObject({ total: 1, limit: 1, truncated: false });
    expect(view.items[0]).not.toHaveProperty("steps");
  });

  it("apply予約後のcrashは同じcommand fingerprintで未完了stepから再開する", async () => {
    const policyConfig: Config = {
      ...config,
      mutation_policy: {
        schema_version: "1",
        policy_id: "public-policy",
        version: "1",
        rules: [
          {
            id: "add-task",
            mutation_kinds: ["add"],
            repositories: ["example/public"],
            root_task_ids: [epic.id],
            task_types: ["task", "epic"],
            max_operations: 2,
            max_affected_tasks: 2,
            max_risk: "low",
          },
        ],
      },
    };
    const repository = new MemoryRepository();
    const executed: string[] = [];
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        return {
          config: policyConfig,
          tasks: [epic],
          sourceRevision: "revision-1",
          snapshotFingerprint: "b".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "dev-role-fixed@1",
            mutationCheckpointId: "checkpoint-331",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "c".repeat(64) };
      },
      async verifyHumanApproval() {
        return { ok: false, code: "human_gate_required", diagnostic: "unused" };
      },
      async executeStep(step) {
        executed.push(step.stepId);
        return { state: "committed", diagnostic: null, resolvedTaskId: "example/public#400" };
      },
      async appendAudit() {},
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(policyConfig),
      environment,
      { now: () => "2026-08-02T01:00:00.000Z", nextId: () => "proposal-crash" },
    );
    const proposed = await control.execute({
      schemaVersion: "1",
      commandId: "propose-crash",
      type: "propose",
      actor: { id: "planner", role: "planner" },
      originRunId: "run-crash",
      intent: {
        kind: "add",
        parentTaskId: epic.id,
        task: { clientId: "created-after-crash", title: "追加", type: "task" },
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    expect(proposed).toMatchObject({ accepted: true, status: "approved" });
    const applyCommand = {
      schemaVersion: "1" as const,
      commandId: "apply-crash",
      type: "apply" as const,
      actor: { id: "orchestrator", role: "orchestrator" as const },
      proposalId: "proposal-crash",
      expectedRevision: proposed.revision,
    };
    const reserved = repository.registry.proposals[0]!;
    reserved.status = "applying";
    reserved.revision += 1;
    const fingerprint = mutationCommandFingerprint(applyCommand);
    repository.registry.commandReceipts.push({
      commandId: applyCommand.commandId,
      commandFingerprint: fingerprint,
      receipt: {
        schemaVersion: "1",
        accepted: true,
        commandId: applyCommand.commandId,
        commandFingerprint: fingerprint,
        proposalId: reserved.proposalId,
        revision: reserved.revision,
        status: "applying",
        stateUnchanged: false,
        errorCode: null,
        diagnostic: null,
        changedTaskIds: [],
        successorPlanRevision: null,
      },
    });

    const resumed = await control.execute(applyCommand);
    expect(resumed).toMatchObject({ accepted: true, status: "applied" });
    expect(executed).toEqual(["step-0001"]);
  });

  it("成功済みcancelは別のtrusted compensation stepでreopenしてcompensatedへ終端する", async () => {
    const repository = new MemoryRepository();
    const operations: string[] = [];
    const audits: MutationProposalAuditEvent[] = [];
    let compensationFinalizeCrash = true;
    let validationCount = 0;
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        return {
          config,
          tasks: [epic],
          sourceRevision: "revision-cancel",
          snapshotFingerprint: "7".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "dev-role-fixed@1",
            mutationCheckpointId: "checkpoint-cancel",
          },
        };
      },
      async validateApply() {
        validationCount += 1;
        const originRun = {
          workspaceId: "workspace:fixture",
          projectRoot: "/fixture",
          runId: "run-cancel",
          taskId: epic.id,
          planId: "dev-role-fixed",
          planVersion: "1",
          schemaVersion: "1",
          currentNodeId: "node-cancel",
          successorPlanRevision: {
            planId: "dev-role-fixed",
            fromVersion: "1",
            proposedVersion: "1+proposal.proposal-cancel",
            reasonProposalId: "proposal-cancel",
          },
        };
        return {
          ok: true,
          coverageFingerprint: validationCount === 1 ? "8".repeat(64) : "a".repeat(64),
          affectedRuns: [
            originRun,
            ...(validationCount === 1
              ? []
              : [
                  {
                    ...originRun,
                    workspaceId: "workspace:late",
                    projectRoot: "/late",
                    runId: "run-late",
                    currentNodeId: "node-late",
                  },
                ]),
          ],
        };
      },
      async verifyHumanApproval(boundDecision, commentRef) {
        return {
          ok: true,
          receipt: {
            schemaVersion: "1",
            decision: "approve",
            actor: { id: "U_reviewer", role: "human" },
            repository: commentRef.repository,
            issueNumber: commentRef.issueNumber,
            commentId: commentRef.commentId,
            bodyHash: mutationCommandFingerprint(boundDecision),
            commentUpdatedAt: "2026-08-02T01:00:00.000Z",
            verifiedAt: "2026-08-02T01:00:00.000Z",
            viewerNodeId: "U_agent",
            authorityConfigFingerprint: "9".repeat(64),
            boundDecision,
          },
        };
      },
      async executeStep(step, _proposal, _fence, recordRemoteOutcome) {
        operations.push(step.operation);
        if (step.operation === "recover_cancel" && compensationFinalizeCrash) {
          compensationFinalizeCrash = false;
          await recordRemoteOutcome?.({ state: "committed", diagnostic: null });
          throw new Error("compensation local finalize crash");
        }
        return { state: "committed", diagnostic: null };
      },
      async reconcileStep(step) {
        if (step.operation !== "recover_cancel") {
          return { state: "unknown", diagnostic: "unexpected" };
        }
        return { state: "reconciled", diagnostic: null };
      },
      async acceptReplan() {
        return { ok: true };
      },
      async appendAudit(event) {
        audits.push(event);
      },
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(config, { now: () => "2026-08-02T01:00:00.000Z" }),
      environment,
      { now: () => "2026-08-02T01:00:00.000Z", nextId: () => "proposal-cancel" },
    );
    const proposed = await control.execute({
      schemaVersion: "1",
      commandId: "propose-cancel",
      type: "propose",
      actor: { id: "planner", role: "planner" },
      originRunId: "run-cancel",
      intent: { kind: "cancel", targetTaskId: epic.id, reason: "要件変更" },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    const decided = await control.execute({
      schemaVersion: "1",
      commandId: "decide-cancel",
      type: "decide",
      proposalId: "proposal-cancel",
      expectedRevision: proposed.revision,
      approvalCommentRef: {
        repository: "example/public",
        issueNumber: 331,
        commentId: "IC_CANCEL",
      },
    });
    const applied = await control.execute({
      schemaVersion: "1",
      commandId: "apply-cancel",
      type: "apply",
      actor: { id: "orchestrator", role: "orchestrator" },
      proposalId: "proposal-cancel",
      expectedRevision: decided.revision,
    });
    expect(applied).toMatchObject({ accepted: true, status: "applied" });
    repository.registry.proposals[0]!.invalidationTargets = [
      {
        workspaceId: "workspace:fixture",
        projectRoot: "/fixture",
        runId: "run-cancel",
        taskId: epic.id,
        planId: "dev-role-fixed",
        planVersion: "1",
        schemaVersion: "1",
        currentNodeId: "node-cancel",
        successorPlanRevision: {
          planId: "dev-role-fixed",
          fromVersion: "1",
          proposedVersion: "1+proposal.proposal-cancel",
          reasonProposalId: "proposal-cancel",
        },
      },
    ];
    const approvalView = await control.inspect({
      proposalId: "proposal-cancel",
      full: true,
      limit: 1,
      offset: 0,
    });
    expect(approvalView).toMatchObject({
      approvalRequests: [
        expect.objectContaining({ purpose: "compensation", stepId: "step-0001" }),
        expect.objectContaining({
          purpose: "replan",
          targetRunId: "run-cancel",
          targetProjectRoot: "/fixture",
          successorPlanRevision: expect.objectContaining({ planId: "dev-role-fixed" }),
        }),
      ],
    });
    const sourceStep = repository.registry.proposals[0]!.steps[0]!;
    const compensationCommand = {
      schemaVersion: "1" as const,
      commandId: "compensate-cancel",
      type: "reconcile" as const,
      actor: { id: "U_reviewer", role: "human" as const },
      proposalId: "proposal-cancel",
      expectedRevision: applied.revision,
      stepId: sourceStep.stepId,
      resolution: "reopen_cancelled_task" as const,
      beforeFingerprint: sourceStep.recoveryIntent!.beforeFingerprint,
      approvalCommentRef: {
        repository: "example/public",
        issueNumber: 331,
        commentId: "IC_COMPENSATE",
      },
      evidence: {
        id: "compensation-approval",
        kind: "human_decision" as const,
        source: "github-live-comment",
        summary: "成功済みcancelをreopenする",
        observedAt: "2026-08-02T01:00:00.000Z",
      },
    };
    const unknown = await control.execute(compensationCommand);
    expect(unknown).toMatchObject({
      accepted: false,
      status: "compensating",
      errorCode: "side_effect_unknown",
    });
    const compensated = await control.execute(compensationCommand);
    expect(compensated).toMatchObject({ accepted: true, status: "compensated" });
    expect(repository.registry.proposals[0]).toMatchObject({
      status: "compensated",
      steps: [
        { operation: "cancel", state: "committed" },
        { operation: "recover_cancel", state: "reconciled" },
      ],
    });
    expect(operations).toEqual(["cancel", "recover_cancel"]);
    expect(audits.some((event) => event.type === "proposal_compensated")).toBe(true);
    expect(audits).toContainEqual(
      expect.objectContaining({
        type: "work_graph_invalidated",
        actorId: "gh-gantt:mutation-control-plane",
        actorRole: "orchestrator",
      }),
    );
    const compensatedTarget = repository.registry.proposals[0]!.invalidationTargets[0]!;
    expect(repository.registry.proposals[0]!.applyCoverageFingerprint).toBe("a".repeat(64));
    expect(repository.registry.proposals[0]!.invalidationTargets).toHaveLength(2);
    expect(compensatedTarget.successorPlanRevision.proposedVersion).toBe(
      "1+compensation.proposal-cancel",
    );
    const compensatedApprovalView = await control.inspect({
      proposalId: "proposal-cancel",
      full: true,
      limit: 1,
      offset: 0,
    });
    expect(compensatedApprovalView).toMatchObject({
      approvalRequests: expect.arrayContaining([
        expect.objectContaining({
          purpose: "replan",
          targetRunId: "run-cancel",
          successorPlanRevision: compensatedTarget.successorPlanRevision,
        }),
        expect.objectContaining({ purpose: "replan", targetRunId: "run-late" }),
      ]),
    });
    const recoveredRun = await control.execute({
      schemaVersion: "1",
      commandId: "accept-compensated-replan",
      type: "accept_replan",
      actor: { id: "U_reviewer", role: "human" },
      proposalId: "proposal-cancel",
      expectedRevision: compensated.revision,
      approvalCommentRef: {
        repository: "example/public",
        issueNumber: 331,
        commentId: "IC_COMPENSATED_REPLAN",
      },
      successorPlanRevision: compensatedTarget.successorPlanRevision,
      successorNodeId: "node-after-compensation",
      targetRunId: "run-cancel",
      targetProjectRoot: "/fixture",
    });
    expect(recoveredRun).toMatchObject({ accepted: true, status: "compensated" });
    await expect(control.execute(compensationCommand)).resolves.toEqual(compensated);
    expect(operations).toEqual(["cancel", "recover_cancel"]);
  });

  it("reserved apply再開時にhuman approvalが失効していればside effect前に拒否する", async () => {
    const repository = new MemoryRepository();
    let approvalAvailable = true;
    let executeCount = 0;
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        return {
          config,
          tasks: [epic],
          sourceRevision: "revision-revocation",
          snapshotFingerprint: "4".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "checkpoint",
            mutationCheckpointId: "checkpoint",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "5".repeat(64) };
      },
      async verifyHumanApproval(boundDecision, commentRef) {
        if (!approvalAvailable) {
          return {
            ok: false,
            code: "human_gate_required",
            diagnostic: "approval comment was deleted",
          };
        }
        return {
          ok: true,
          receipt: {
            schemaVersion: "1",
            decision: "approve",
            actor: { id: "U_reviewer", role: "human" },
            repository: commentRef.repository,
            issueNumber: commentRef.issueNumber,
            commentId: commentRef.commentId,
            bodyHash: "6".repeat(64),
            commentUpdatedAt: "2026-08-02T01:00:00.000Z",
            verifiedAt: "2026-08-02T01:00:00.000Z",
            viewerNodeId: "U_agent",
            authorityConfigFingerprint: "7".repeat(64),
            boundDecision,
          },
        };
      },
      async executeStep() {
        executeCount += 1;
        return { state: "committed", diagnostic: null };
      },
      async appendAudit() {},
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(config),
      environment,
      { now: () => "2026-08-02T01:00:00.000Z", nextId: () => "proposal-revoked" },
    );
    const proposed = await control.execute({
      schemaVersion: "1",
      commandId: "propose-revoked",
      type: "propose",
      actor: { id: "planner", role: "planner" },
      originRunId: "run-revoked",
      intent: { kind: "cancel", targetTaskId: epic.id, reason: "不要" },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    const decided = await control.execute({
      schemaVersion: "1",
      commandId: "decide-revoked",
      type: "decide",
      proposalId: "proposal-revoked",
      expectedRevision: proposed.revision,
      approvalCommentRef: {
        repository: "example/public",
        issueNumber: 331,
        commentId: "IC_REVOKED",
      },
    });
    const applyCommand = {
      schemaVersion: "1" as const,
      commandId: "apply-revoked",
      type: "apply" as const,
      actor: { id: "orchestrator", role: "orchestrator" as const },
      proposalId: "proposal-revoked",
      expectedRevision: decided.revision,
    };
    const reserved = repository.registry.proposals[0]!;
    reserved.status = "applying";
    reserved.revision += 1;
    const commandFingerprint = mutationCommandFingerprint(applyCommand);
    repository.registry.commandReceipts.push({
      commandId: applyCommand.commandId,
      commandFingerprint,
      receipt: {
        schemaVersion: "1",
        accepted: true,
        commandId: applyCommand.commandId,
        commandFingerprint,
        proposalId: reserved.proposalId,
        revision: reserved.revision,
        status: "applying",
        stateUnchanged: false,
        errorCode: null,
        diagnostic: null,
        changedTaskIds: [],
        successorPlanRevision: null,
      },
    });
    approvalAvailable = false;
    await expect(control.execute(applyCommand)).resolves.toMatchObject({
      accepted: false,
      status: "applying",
      errorCode: "human_gate_required",
    });
    expect(executeCount).toBe(0);
  });

  it("lifecycle audit失敗後のexact retryは同じoutbox envelopeをdrainする", async () => {
    const repository = new MemoryRepository();
    const attempts: MutationProposalAuditEvent[] = [];
    let failOnce = true;
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        return {
          config,
          tasks: [epic],
          sourceRevision: "revision-outbox",
          snapshotFingerprint: "8".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "checkpoint",
            mutationCheckpointId: "checkpoint",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "9".repeat(64) };
      },
      async verifyHumanApproval() {
        return { ok: false, code: "human_gate_required", diagnostic: "unused" };
      },
      async executeStep() {
        return { state: "committed", diagnostic: null };
      },
      async appendAudit(event) {
        attempts.push(structuredClone(event));
        if (failOnce) {
          failOnce = false;
          throw new Error("journal unavailable");
        }
      },
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(config),
      environment,
      { now: () => "2026-08-02T01:00:00.000Z", nextId: () => "proposal-outbox" },
    );
    const command = {
      schemaVersion: "1" as const,
      commandId: "propose-outbox",
      type: "propose" as const,
      actor: { id: "planner", role: "planner" as const },
      originRunId: "run-outbox",
      intent: {
        kind: "add" as const,
        parentTaskId: epic.id,
        task: { clientId: "child", title: "追加task", type: "task" },
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    };
    const first = await control.execute(command);
    expect(repository.registry.proposals[0]!.pendingAudits).toHaveLength(1);
    const retry = await control.execute(command);
    expect(retry).toEqual(first);
    expect(repository.registry.proposals[0]!.pendingAudits).toEqual([]);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it("policy max_affected_tasksはtargetと依存fan-outの一意unionで判定する", async () => {
    const child: Task = {
      ...structuredClone(epic),
      id: "example/public#332",
      github_issue: 332,
      type: "task",
      parent: epic.id,
      sub_tasks: [],
      title: "child",
      labels: ["task"],
    };
    const root = { ...structuredClone(epic), sub_tasks: [child.id] };
    const boundedConfig: Config = {
      ...config,
      mutation_policy: {
        schema_version: "1",
        policy_id: "fanout-policy",
        version: "1",
        rules: [
          {
            id: "one-task-only",
            mutation_kinds: ["dependency"],
            repositories: ["example/public"],
            root_task_ids: [root.id],
            task_types: ["task"],
            max_operations: 1,
            max_affected_tasks: 1,
            max_risk: "low",
          },
        ],
      },
    };
    const repository = new MemoryRepository();
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        return {
          config: boundedConfig,
          tasks: [root, child],
          sourceRevision: "revision-fanout",
          snapshotFingerprint: "a".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: root.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "checkpoint",
            mutationCheckpointId: "checkpoint",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "b".repeat(64) };
      },
      async verifyHumanApproval() {
        return { ok: false, code: "human_gate_required", diagnostic: "unused" };
      },
      async executeStep() {
        return { state: "committed", diagnostic: null };
      },
      async appendAudit() {},
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(boundedConfig),
      environment,
      { now: () => "2026-08-02T01:00:00.000Z", nextId: () => "proposal-fanout" },
    );
    const result = await control.execute({
      schemaVersion: "1",
      commandId: "propose-fanout",
      type: "propose",
      actor: { id: "planner", role: "planner" },
      originRunId: "run-fanout",
      intent: {
        kind: "dependency",
        operation: "add",
        taskId: child.id,
        blockerTaskId: root.id,
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    expect(result).toMatchObject({ accepted: true, status: "awaiting_human" });
    expect(repository.registry.proposals[0]).toMatchObject({
      targetTaskIds: [root.id, child.id],
      affectedUpstream: [],
      approval: null,
    });
  });

  it("60秒超過したside_effect_in_flightを新ownerがremote再送せずreconcile-onlyで回収する", async () => {
    const policyConfig: Config = {
      ...config,
      mutation_policy: {
        schema_version: "1",
        policy_id: "bounded-policy",
        version: "1",
        rules: [
          {
            id: "bounded-add",
            mutation_kinds: ["add"],
            repositories: ["example/public"],
            root_task_ids: [epic.id],
            task_types: ["task", "epic"],
            max_operations: 1,
            max_affected_tasks: 2,
            max_risk: "low",
          },
        ],
      },
    };
    const repository = new MemoryRepository();
    repository.retainApplicationLease = true;
    let executeCount = 0;
    let reconcileCount = 0;
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        return {
          config: policyConfig,
          tasks: [epic],
          sourceRevision: "revision-in-flight",
          snapshotFingerprint: "a".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "checkpoint",
            mutationCheckpointId: "checkpoint",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "b".repeat(64) };
      },
      async verifyHumanApproval() {
        return { ok: false, code: "human_gate_required", diagnostic: "unused" };
      },
      async prepareStep() {
        return {
          ok: true,
          preparation: {
            sourceRevision: "revision-in-flight",
            sourceFingerprint: "a".repeat(64),
            preparedFingerprint: "c".repeat(64),
            preparedAt: repository.now,
          },
        };
      },
      async executeStep() {
        executeCount += 1;
        return { state: "committed", diagnostic: null };
      },
      async reconcileStep() {
        reconcileCount += 1;
        return { state: "reconciled", diagnostic: null };
      },
      async appendAudit() {},
    };
    const first = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(policyConfig),
      environment,
      {
        now: () => repository.now,
        nextId: () => "proposal-in-flight",
        afterRemoteIntentPersisted: async () => {
          throw new Error("simulated process loss after in-flight journal");
        },
      },
    );
    const proposed = await first.execute({
      schemaVersion: "1",
      commandId: "propose-in-flight",
      type: "propose",
      actor: { id: "planner", role: "planner" },
      originRunId: "run-in-flight",
      intent: {
        kind: "add",
        parentTaskId: epic.id,
        task: { clientId: "child", title: "追加task", type: "task" },
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    const applyCommand = {
      schemaVersion: "1" as const,
      commandId: "apply-in-flight",
      type: "apply" as const,
      actor: { id: "orchestrator", role: "orchestrator" as const },
      proposalId: "proposal-in-flight",
      expectedRevision: proposed.revision,
    };
    await expect(first.execute(applyCommand)).rejects.toThrow("simulated process loss");
    expect(repository.registry.proposals[0]?.steps[0]?.remoteExecution).toMatchObject({
      state: "side_effect_in_flight",
      fencingToken: 2,
    });
    expect(executeCount).toBe(0);

    repository.now = "2026-08-02T01:01:01.000Z";
    const takeover = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(policyConfig),
      environment,
      { now: () => repository.now, nextId: () => "unused" },
    );
    await expect(takeover.execute(applyCommand)).resolves.toMatchObject({
      accepted: true,
      status: "applied",
    });
    expect(executeCount).toBe(0);
    expect(reconcileCount).toBe(1);
  });

  it("non-orchestrator applyはinvalidation authorityをpreflightしてremote I/O前にdefault denyする", async () => {
    const repository = new MemoryRepository();
    const automaticConfig: Config = {
      ...config,
      mutation_policy: {
        schema_version: "1",
        policy_id: "authority-preflight",
        version: "1",
        rules: [
          {
            id: "bounded-add",
            mutation_kinds: ["add"],
            repositories: ["example/public"],
            root_task_ids: [epic.id],
            task_types: ["epic", "task"],
            max_operations: 1,
            max_affected_tasks: 2,
            max_risk: "low",
          },
        ],
      },
    };
    let snapshotReads = 0;
    let remoteExecutions = 0;
    const environment: MutationProposalEnvironment = {
      mutationCoordination: memoryMutationCoordination(),
      async loadSnapshot() {
        snapshotReads += 1;
        return {
          config: automaticConfig,
          tasks: [epic],
          sourceRevision: "authority-revision",
          snapshotFingerprint: "a".repeat(64),
          syncConflicts: false,
        };
      },
      async resolveOrigin(runId) {
        return {
          ok: true,
          origin: {
            runId,
            workspaceId: "workspace:fixture",
            taskId: epic.id,
            repository: "example/public",
            planId: "dev-role-fixed",
            planVersion: "1",
            authorityId: "checkpoint",
            mutationCheckpointId: "checkpoint",
          },
        };
      },
      async validateApply() {
        return { ok: true, coverageFingerprint: "b".repeat(64) };
      },
      async verifyHumanApproval() {
        return { ok: false, code: "human_gate_required", diagnostic: "unused" };
      },
      async executeStep() {
        remoteExecutions += 1;
        return { state: "committed", diagnostic: null };
      },
      async appendAudit() {},
    };
    const control = new MutationProposalControlPlane(
      repository,
      new WorkGraphCommandEngine(automaticConfig),
      environment,
      { now: () => repository.now, nextId: () => "proposal-authority-preflight" },
    );
    const proposed = await control.execute({
      schemaVersion: "1",
      commandId: "propose-authority-preflight",
      type: "propose",
      actor: { id: "planner", role: "planner" },
      originRunId: "run-authority-preflight",
      intent: {
        kind: "add",
        parentTaskId: epic.id,
        task: { clientId: "child", title: "追加task", type: "task" },
      },
      evidence: [],
      expiresAt: "2026-08-03T00:00:00.000Z",
    });
    expect(proposed).toMatchObject({ accepted: true, status: "approved" });
    await expect(
      control.execute({
        schemaVersion: "1",
        commandId: "apply-without-invalidation-authority",
        type: "apply",
        actor: { id: "implementer", role: "implementer" },
        proposalId: proposed.proposalId!,
        expectedRevision: proposed.revision,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      errorCode: "human_gate_required",
      stateUnchanged: true,
    });
    expect(snapshotReads).toBe(1);
    expect(remoteExecutions).toBe(0);
    expect(repository.registry.proposals[0]).toMatchObject({ status: "approved" });
  });
});
