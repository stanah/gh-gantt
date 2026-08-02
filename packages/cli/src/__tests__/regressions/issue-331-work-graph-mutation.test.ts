import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  mutationCommandFingerprint,
  type Config,
  type MutationProposal,
  type MutationProposalReceipt,
  type Task,
} from "@gh-gantt/shared";
import { describe, expect, it } from "vitest";
import { RunGraphControlPlane } from "../../run-graph/control-plane.js";
import { GraphContractStore } from "../../store/graph-contract.js";
import type {
  MutationApplicationClaimInput,
  MutationApplicationLease,
  MutationProposalRegistry,
} from "../../store/mutation-proposals.js";
import { RunGraphEventStore } from "../../store/run-graph.js";
import { WorkGraphCommandEngine } from "../../work-graph/command-engine.js";
import {
  MutationProposalControlPlane,
  type MutationProposalAuditEvent,
  type MutationCoordinationCapability,
  type MutationProposalEnvironment,
  type MutationProposalRepository,
} from "../../work-graph/mutation-control-plane.js";
import type { TrustedHumanApprovalReceipt } from "../../work-graph/human-approval-authority.js";

const timestamp = "2026-08-02T00:00:00.000Z";

function memoryMutationCoordination(): MutationCoordinationCapability {
  return {
    async reserveMutation(proposal, _expectedEntityVersion, ownerNonce) {
      return {
        accepted: true,
        entityVersion: 1,
        reservation: {
          proposalId: proposal.proposalId,
          ownerNonce,
          fencingToken: 1,
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
  sync: { auto_create_issues: true, field_mapping: { start_date: "Start", end_date: "End" } },
  task_types: {
    epic: { label: "Epic", display: "summary", color: "#000", github_label: "epic" },
    task: { label: "Task", display: "bar", color: "#111", github_label: "task" },
  },
  type_hierarchy: { epic: ["task"], task: [] },
  statuses: { field_name: "Status", values: {} },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

const rootTask: Task = {
  id: "example/public#331",
  type: "epic",
  github_issue: 331,
  github_repo: "example/public",
  parent: null,
  sub_tasks: [],
  title: "Graph engineering",
  body: null,
  state: "open",
  state_reason: null,
  assignees: [],
  labels: ["epic"],
  milestone: null,
  linked_prs: [],
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: null,
  custom_fields: {},
  start_date: null,
  end_date: null,
  date: null,
  blocked_by: [],
};

class MemoryRepository implements MutationProposalRepository {
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

  async recordReceipt(proposal: MutationProposal, receipt: MutationProposalReceipt) {
    const index = this.registry.proposals.findIndex(
      (item) => item.proposalId === proposal.proposalId,
    );
    if (index < 0) this.registry.proposals.push(structuredClone(proposal));
    else this.registry.proposals[index] = structuredClone(proposal);
    const receiptIndex = this.registry.commandReceipts.findIndex(
      (item) => item.commandId === receipt.commandId,
    );
    const stored = {
      commandId: receipt.commandId,
      commandFingerprint: receipt.commandFingerprint,
      receipt: structuredClone(receipt),
    };
    if (receiptIndex < 0) this.registry.commandReceipts.push(stored);
    else this.registry.commandReceipts[receiptIndex] = stored;
  }
  async acknowledgeAudit(proposalId: string, eventId: string, expectedRevision: number) {
    const proposal = this.registry.proposals.find((item) => item.proposalId === proposalId);
    if (!proposal || proposal.revision !== expectedRevision) return false;
    proposal.pendingAudits = proposal.pendingAudits.filter((item) => item.eventId !== eventId);
    proposal.pendingAuditEventIds = proposal.pendingAuditEventIds.filter((id) => id !== eventId);
    return true;
  }
  async claimApplication(input: MutationApplicationClaimInput) {
    const lease: MutationApplicationLease = {
      proposalId: input.proposalId,
      commandId: input.commandId,
      commandFingerprint: input.commandFingerprint,
      ownerNonce: input.ownerNonce,
      fencingToken: 1,
      stepId: null,
      expiresAt: "2026-08-02T02:00:00.000Z",
    };
    this.registry.applicationLeases = [lease];
    return { ok: true as const, lease };
  }
  async fenceApplication(input: {
    lease: MutationApplicationLease;
    stepId: string;
    leaseDurationSeconds: number;
  }) {
    const lease = {
      ...input.lease,
      fencingToken: input.lease.fencingToken + 1,
      stepId: input.stepId,
    };
    this.registry.applicationLeases = [lease];
    return { ok: true as const, lease };
  }
  async releaseApplication() {
    this.registry.applicationLeases = [];
    return true;
  }
}

const reference = (name: string) => ({
  kind: "workspace" as const,
  uri: `.dev-flow/331/${name}.json`,
  sha256: `sha256:${"d".repeat(64)}`,
  byteLength: 128,
});

describe("[NFR-STABILITY-014-AC8][Issue #331] 承認gate付きWork Graph mutation", () => {
  it("human approvalからpartial reconcile/invalidation/replanまでstable lineageを維持する", async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-gantt-issue-331-integration-"));
    try {
      await new GraphContractStore(root).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
      const counters = new Map<string, number>();
      const run = new RunGraphControlPlane(root, {
        now: () => timestamp,
        nextId: (kind) => {
          const next = (counters.get(kind) ?? 0) + 1;
          counters.set(kind, next);
          return `${kind}-stable-${next}`;
        },
      });
      const started = await run.start({
        schemaVersion: "1",
        eventId: "issue-331-run-started",
        actor: { id: "orchestrator", role: "orchestrator" },
        task: { owner: "example", repo: "public", issueNumber: 331 },
        contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      });
      if (!started.accepted || !started.view.currentNode) throw new Error("Runを開始できません");
      const runId = started.view.runId;
      const originalNodeId = started.view.currentNode.id;
      const originalContract = structuredClone(started.view.contract);
      await run.applyEvent({
        schemaVersion: "1",
        eventId: "issue-331-attempt-started",
        runId,
        actor: { id: "planner", role: "planner" },
        command: { type: "attempt_started", nodeId: originalNodeId, attemptId: "attempt-stable" },
      });
      await run.applyEvent({
        schemaVersion: "1",
        eventId: "issue-331-attempt-finished",
        runId,
        actor: { id: "planner", role: "planner" },
        command: {
          type: "attempt_finished",
          nodeId: originalNodeId,
          attemptId: "attempt-stable",
          outcome: "succeeded",
          artifactIds: ["artifact-stable"],
          evidenceIds: ["evidence-stable"],
        },
        artifacts: [
          {
            id: "artifact-stable",
            schemaId: "dev-role.plan",
            schemaVersion: "1",
            derivedFromArtifactIds: [],
            reference: reference("artifact-stable"),
          },
        ],
        evidence: [
          {
            id: "evidence-stable",
            kind: "command_execution",
            artifactIds: ["artifact-stable"],
            provenance: "planner",
            reference: reference("evidence-stable"),
          },
        ],
      });
      await run.applyEvent({
        schemaVersion: "1",
        eventId: "issue-331-node-outcome",
        runId,
        actor: { id: "planner", role: "planner" },
        command: {
          type: "node_outcome_submitted",
          nodeId: originalNodeId,
          attemptId: "attempt-stable",
          outcome: "plan_valid",
          artifactIds: ["plan-artifact-stable"],
          evidenceIds: ["plan-evidence-stable"],
        },
        artifacts: [
          {
            id: "plan-artifact-stable",
            schemaId: "dev-role.plan",
            schemaVersion: "1",
            derivedFromArtifactIds: ["artifact-stable"],
            reference: reference("plan-artifact-stable"),
          },
        ],
        evidence: [
          {
            id: "plan-evidence-stable",
            kind: "artifact_validation",
            artifactIds: ["plan-artifact-stable"],
            provenance: "planner",
            reference: reference("plan-evidence-stable"),
          },
        ],
      });
      const beforeMutation = await run.inspect(runId, 100);
      const mutationNodeId = beforeMutation.currentNode!.id;

      const repository = new MemoryRepository();
      let stepAttempts = 0;
      const environment: MutationProposalEnvironment = {
        mutationCoordination: memoryMutationCoordination(),
        async loadSnapshot() {
          return {
            config,
            tasks: [rootTask],
            sourceRevision: "source-1",
            snapshotFingerprint: "a".repeat(64),
            syncConflicts: false,
          };
        },
        async resolveOrigin() {
          return {
            ok: true,
            origin: {
              runId,
              workspaceId: "workspace:canonical",
              taskId: rootTask.id,
              repository: "example/public",
              planId: originalContract.planId,
              planVersion: originalContract.planVersion,
              authorityId: "checkpoint-authority",
              mutationCheckpointId: "checkpoint-331",
            },
          };
        },
        async validateApply() {
          return {
            ok: true,
            coverageFingerprint: "b".repeat(64),
            affectedRuns: [
              {
                workspaceId: "workspace:canonical",
                projectRoot: root,
                runId,
                taskId: rootTask.id,
                planId: originalContract.planId,
                planVersion: originalContract.planVersion,
                schemaVersion: originalContract.schemaVersion,
                currentNodeId: mutationNodeId,
                successorPlanRevision: {
                  planId: originalContract.planId,
                  fromVersion: originalContract.planVersion,
                  proposedVersion: `${originalContract.planVersion}+proposal.proposal-331`,
                  reasonProposalId: "proposal-331",
                },
              },
            ],
          };
        },
        async verifyHumanApproval(boundDecision, commentRef) {
          const receipt: TrustedHumanApprovalReceipt = {
            schemaVersion: "1",
            decision: "approve",
            actor: { id: "U_APPROVER_PUBLIC", role: "human" },
            repository: commentRef.repository,
            issueNumber: commentRef.issueNumber,
            commentId: commentRef.commentId,
            bodyHash: mutationCommandFingerprint(boundDecision),
            commentUpdatedAt: timestamp,
            verifiedAt: timestamp,
            viewerNodeId: "U_AUTOMATION_PUBLIC",
            authorityConfigFingerprint: "c".repeat(64),
            boundDecision,
          };
          return { ok: true, receipt };
        },
        async executeStep() {
          stepAttempts += 1;
          return { state: "unknown", diagnostic: "create response unknown" };
        },
        async reconcileStep() {
          return {
            state: "reconciled",
            diagnostic: null,
            resolvedTaskId: "example/public#400",
            remoteIdentifiers: { issueId: "I_PUBLIC_400", issueNumber: 400 },
          };
        },
        async appendAudit(event: MutationProposalAuditEvent) {
          const command =
            event.type === "work_graph_invalidated"
              ? {
                  type: "work_graph_invalidated" as const,
                  proposalId: event.proposalId,
                  proposalRevision: event.proposalRevision,
                  coverageFingerprint: String(event.detail.coverageFingerprint),
                  affectedTaskIds: event.detail.affectedTaskIds as string[],
                  successorPlanRevision: {
                    planId: String(event.detail.planId),
                    fromVersion: String(event.detail.fromVersion),
                    proposedVersion: String(event.detail.proposedVersion),
                    reasonProposalId: event.proposalId,
                  },
                }
              : {
                  type: "work_graph_mutation_audit" as const,
                  auditType: event.type,
                  proposalId: event.proposalId,
                  proposalRevision: event.proposalRevision,
                  detailFingerprint: mutationCommandFingerprint(event.detail),
                };
          const result = await run.applyMutationAudit({
            schemaVersion: "1",
            eventId: event.eventId,
            runId,
            actor: { id: event.actorId, role: "orchestrator" },
            command,
          });
          if (!result.accepted) throw new Error(result.message);
        },
        async acceptReplan(current, approval, successorPlanRevision, successorNodeId) {
          const receiptFingerprint = mutationCommandFingerprint(approval);
          const verifiedRun = new RunGraphControlPlane(root, {
            now: () => timestamp,
            nextId: (kind) => `${kind}-replan`,
            verifyReplanApproval: async (command) =>
              command.proposalId === current.proposalId &&
              command.verifiedHumanDecision.receiptFingerprint === receiptFingerprint,
          });
          const result = await verifiedRun.applyMutationAudit({
            schemaVersion: "1",
            eventId: `mutation:${current.proposalId}:replan:${current.revision}`,
            runId,
            actor: approval.actor,
            command: {
              type: "work_graph_replan_accepted",
              proposalId: current.proposalId,
              proposalRevision: current.revision,
              verifiedHumanDecision: {
                decision: "approved",
                evidenceId: `github-comment:${approval.commentId}:${approval.bodyHash}`,
                authorNodeId: approval.actor.id,
                proposalFingerprint: approval.boundDecision.proposalFingerprint,
                authorityConfigFingerprint: approval.authorityConfigFingerprint,
                receiptFingerprint,
              },
              graphContractBinding: originalContract,
              successorPlanRevision,
              successorNodeId,
            },
          });
          return result.accepted
            ? { ok: true }
            : { ok: false, code: result.code, diagnostic: result.message };
        },
      };
      const proposal = new MutationProposalControlPlane(
        repository,
        new WorkGraphCommandEngine(config, { now: () => timestamp }),
        environment,
        { now: () => timestamp, nextId: () => "proposal-331" },
      );
      const proposed = await proposal.execute({
        schemaVersion: "1",
        commandId: "proposal-create",
        type: "propose",
        actor: { id: "planner", role: "planner" },
        originRunId: runId,
        intent: {
          kind: "add",
          parentTaskId: rootTask.id,
          task: { clientId: "child", title: "追加task", type: "task" },
        },
        evidence: [],
        expiresAt: "2026-08-03T00:00:00.000Z",
      });
      const decided = await proposal.execute({
        schemaVersion: "1",
        commandId: "proposal-decide",
        type: "decide",
        proposalId: "proposal-331",
        expectedRevision: proposed.revision,
        approvalCommentRef: {
          repository: "example/public",
          issueNumber: 331,
          commentId: "IC_PUBLIC_APPROVAL",
        },
      });
      const partial = await proposal.execute({
        schemaVersion: "1",
        commandId: "proposal-apply-1",
        type: "apply",
        actor: { id: "orchestrator", role: "orchestrator" },
        proposalId: "proposal-331",
        expectedRevision: decided.revision,
      });
      expect(partial).toMatchObject({ accepted: false, status: "partially_applied" });
      const reconciled = await proposal.execute({
        schemaVersion: "1",
        commandId: "proposal-reconcile",
        type: "reconcile",
        actor: { id: "orchestrator", role: "orchestrator" },
        proposalId: "proposal-331",
        expectedRevision: partial.revision,
        stepId: "step-0001",
        resolution: "confirm_committed",
        evidence: {
          id: "remote-evidence",
          kind: "side_effect_reconciliation",
          source: "github-live-query",
          summary: "correlation marker exactly one",
          observedAt: timestamp,
          sideEffectState: "reconciled",
        },
      });
      const applied = await proposal.execute({
        schemaVersion: "1",
        commandId: "proposal-apply-2",
        type: "apply",
        actor: { id: "orchestrator", role: "orchestrator" },
        proposalId: "proposal-331",
        expectedRevision: reconciled.revision,
      });
      expect(applied).toMatchObject({ accepted: true, status: "applied" });
      expect(stepAttempts).toBe(1);

      const invalidated = await run.inspect(runId, 100);
      expect(invalidated).toMatchObject({
        state: "waiting_human",
        currentNode: { id: mutationNodeId, state: "waiting_human" },
        activeAttempt: null,
        contract: originalContract,
      });
      expect(invalidated.attempts.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "attempt-stable",
            nodeId: originalNodeId,
            state: "succeeded",
          }),
        ]),
      );
      expect(invalidated.artifacts.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "artifact-stable" })]),
      );
      expect(invalidated.evidence.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "evidence-stable" })]),
      );

      const replanned = await proposal.execute({
        schemaVersion: "1",
        commandId: "proposal-replan-accepted",
        type: "accept_replan",
        actor: { id: "U_APPROVER_PUBLIC", role: "human" },
        proposalId: "proposal-331",
        expectedRevision: applied.revision,
        approvalCommentRef: {
          repository: "example/public",
          issueNumber: 331,
          commentId: "IC_PUBLIC_REPLAN_APPROVAL",
        },
        successorPlanRevision: applied.successorPlanRevision!,
        successorNodeId: "node-successor-331",
      });
      expect(replanned).toMatchObject({
        accepted: true,
        status: "applied",
        successorPlanRevision: applied.successorPlanRevision,
      });
      await expect(run.inspect(runId, 100)).resolves.toMatchObject({
        state: "running",
        currentNode: { id: "node-successor-331", previousNodeId: mutationNodeId, state: "ready" },
        contract: originalContract,
        activeAttempt: null,
      });
      const journal = await new RunGraphEventStore(root).readJournal(runId);
      expect(journal.acceptedEvents.map((event) => event.eventId)).toEqual([
        "issue-331-run-started",
        "issue-331-attempt-started",
        "issue-331-attempt-finished",
        "issue-331-node-outcome",
        "mutation:proposal-331:proposal_created:1",
        "mutation:proposal-331:proposal_approved:2",
        "mutation:proposal-331:proposal_apply_step:5",
        "mutation:proposal-331:proposal_reconciled:8",
        "mutation:proposal-331:work_graph_invalidated:10",
        "mutation:proposal-331:proposal_applied:10",
        `mutation:proposal-331:replan:${replanned.revision - 1}`,
        `mutation:proposal-331:proposal_reconciled:${replanned.revision}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
