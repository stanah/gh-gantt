import { randomUUID } from "node:crypto";
import {
  RunGraphProjectionSchema,
  RunGraphRunnerCommandInputSchema,
  RunGraphStartInputSchema,
  RunGraphViewSchema,
  type GraphContract,
  type RunGraphAcceptedEvent,
  type RunGraphArtifact,
  type RunGraphEvidence,
  type RunGraphProjection,
  type RunGraphRejectionCode,
  type RunGraphRunnerCommandInput,
  type RunGraphStartInput,
  type RunGraphView,
} from "@gh-gantt/shared";
import { GraphContractStore } from "../store/graph-contract.js";
import { RunGraphEventStore } from "../store/run-graph.js";

export interface RunGraphControlPlaneDependencies {
  now: () => string;
  nextId: (kind: string) => string;
}

export type RunGraphCommandResult =
  | { accepted: true; view: RunGraphView }
  | {
      accepted: false;
      code: RunGraphRejectionCode;
      message: string;
      stateUnchanged: true;
      view?: RunGraphView;
    };

const defaultDependencies: RunGraphControlPlaneDependencies = {
  now: () => new Date().toISOString(),
  nextId: (kind) => `${kind}-${randomUUID()}`,
};

function actorForContractNode(contractNodeId: string) {
  const role = contractNodeId === "human-pr" ? "human" : contractNodeId;
  if (
    !(["planner", "implementer", "executor", "reviewer", "human"] as const).includes(role as never)
  ) {
    throw new Error(`未知の contract node です: ${contractNodeId}`);
  }
  return { id: `unassigned:${role}`, role } as {
    id: string;
    role: "planner" | "implementer" | "executor" | "reviewer" | "human";
  };
}

function referencedIds(command: RunGraphRunnerCommandInput["command"]): {
  artifactIds: string[];
  evidenceIds: string[];
} {
  if (command.type === "attempt_started") return { artifactIds: [], evidenceIds: [] };
  if (command.type === "run_paused" || command.type === "run_resumed") {
    return { artifactIds: [command.checkpointArtifactId], evidenceIds: command.evidenceIds };
  }
  if (command.type === "human_decision" || command.type === "pr_observed") {
    return { artifactIds: [], evidenceIds: command.evidenceIds };
  }
  return { artifactIds: command.artifactIds, evidenceIds: command.evidenceIds };
}

function contractSchemaKey(schemaId: string, schemaVersion: string): string {
  return `${schemaId}@${schemaVersion}`;
}

/**
 * version binding、transition、budget、authority、replay を一つの public seam に閉じ込める。
 * 外部 runner は start / applyEvent / inspect だけを使用する。
 */
export class RunGraphControlPlane {
  private readonly contracts: GraphContractStore;
  private readonly events: RunGraphEventStore;
  private readonly dependencies: RunGraphControlPlaneDependencies;

  constructor(
    projectRoot: string,
    dependencies: RunGraphControlPlaneDependencies = defaultDependencies,
  ) {
    this.contracts = new GraphContractStore(projectRoot);
    this.events = new RunGraphEventStore(projectRoot);
    this.dependencies = dependencies;
  }

  async start(rawInput: RunGraphStartInput): Promise<RunGraphCommandResult> {
    const input = RunGraphStartInputSchema.parse(rawInput);
    let contract: GraphContract;
    try {
      contract = await this.contracts.read(input.contract);
    } catch (error) {
      return {
        accepted: false,
        code: "unsupported_contract_binding",
        message: error instanceof Error ? error.message : String(error),
        stateUnchanged: true,
      };
    }
    if (!this.contractAllows(contract, "run_start", input.actor.role)) {
      return {
        accepted: false,
        code: "authority_denied",
        message: "Graph Contract が actor に run_start authority を許可していません",
        stateUnchanged: true,
      };
    }

    for (const runId of await this.events.listRunIds()) {
      const journal = await this.events.readJournal(runId);
      if (journal.acceptedEvents.some((event) => event.eventId === input.eventId)) {
        return {
          accepted: false,
          code: "duplicate_event",
          message: `受理済み event ID です: ${input.eventId}`,
          stateUnchanged: true,
          view: await this.inspect(runId),
        };
      }
    }

    const runId = this.dependencies.nextId("run");
    const firstNodeId = this.dependencies.nextId("node");
    const event: RunGraphAcceptedEvent = {
      recordType: "accepted",
      eventId: input.eventId,
      sequence: 1,
      runId,
      acceptedAt: this.dependencies.now(),
      actor: input.actor,
      command: {
        type: "run_started",
        task: input.task,
        contract: input.contract,
        firstNodeId,
      },
      artifactIds: [],
      evidenceIds: [],
    };
    await this.events.appendAccepted(event);
    return { accepted: true, view: await this.inspect(runId) };
  }

  async applyEvent(rawInput: RunGraphRunnerCommandInput): Promise<RunGraphCommandResult> {
    const input = RunGraphRunnerCommandInputSchema.parse(rawInput);
    const journal = await this.events.readJournal(input.runId);
    const projection = this.replay(journal);
    const view = await this.inspect(input.runId);
    if (journal.acceptedEvents.some((event) => event.eventId === input.eventId)) {
      return this.reject(
        input,
        "duplicate_event",
        `受理済み event ID です: ${input.eventId}`,
        view,
      );
    }
    const currentNode = projection.nodes.find((node) => node.id === projection.run.currentNodeId);
    if (!currentNode) {
      return this.reject(input, "invalid_transition", "current node が存在しません", view);
    }
    const contract = await this.contracts.read(projection.run.contract);
    if (!this.hasAuthority(input, currentNode.actor.role, contract)) {
      return this.reject(
        input,
        "authority_denied",
        "actor に command authority がありません",
        view,
      );
    }

    if ("nodeId" in input.command && input.command.nodeId !== currentNode.id) {
      return this.reject(
        input,
        "stale_attempt",
        "command の node は current node ではありません",
        view,
      );
    }
    if (input.command.type === "attempt_started") {
      const { attemptId } = input.command;
      if (projection.attempts.some((attempt) => attempt.id === attemptId)) {
        return this.reject(
          input,
          "stale_attempt",
          `attempt ID は Run 内で受理済みです: ${attemptId}`,
          view,
        );
      }
    }
    const activeAttempt = currentNode.activeAttemptId
      ? projection.attempts.find((attempt) => attempt.id === currentNode.activeAttemptId)
      : undefined;
    if (
      (input.command.type === "run_paused" || input.command.type === "run_resumed") &&
      !activeAttempt
    ) {
      return this.reject(
        input,
        "stale_attempt",
        "pause/resume に対応する active attempt がありません",
        view,
      );
    }
    if (
      (input.command.type === "attempt_finished" ||
        input.command.type === "node_outcome_submitted") &&
      (!activeAttempt || input.command.attemptId !== activeAttempt.id)
    ) {
      return this.reject(
        input,
        "stale_attempt",
        "command の attempt は current attempt ではありません",
        view,
      );
    }
    const attemptBoundCommand =
      input.command.type === "attempt_finished" || input.command.type === "node_outcome_submitted";
    const contractNode = contract.nodes.find((node) => node.id === currentNode.contractNodeId);
    if (
      attemptBoundCommand &&
      activeAttempt &&
      (!contractNode ||
        activeAttempt.actor.id !== input.actor.id ||
        activeAttempt.actor.role !== input.actor.role ||
        activeAttempt.actor.role !== contractNode.role)
    ) {
      return this.reject(
        input,
        "authority_denied",
        "command actor は active attempt と Graph Contract の authority に一致しません",
        view,
      );
    }

    const transitionError = this.validateTransition(
      input,
      projection,
      currentNode.contractNodeId,
      currentNode.state,
      activeAttempt?.state,
    );
    if (transitionError) {
      return this.reject(input, transitionError.code, transitionError.message, view);
    }

    const artifactSubmissionIds = (input.artifacts ?? []).map((artifact) => artifact.id);
    const evidenceSubmissionIds = (input.evidence ?? []).map((item) => item.id);
    if (
      new Set(artifactSubmissionIds).size !== artifactSubmissionIds.length ||
      artifactSubmissionIds.some((id) =>
        projection.artifacts.some((artifact) => artifact.id === id),
      )
    ) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "artifact ID は Run 内で一意である必要があります",
        view,
      );
    }
    if (
      new Set(evidenceSubmissionIds).size !== evidenceSubmissionIds.length ||
      evidenceSubmissionIds.some((id) => projection.evidence.some((item) => item.id === id))
    ) {
      return this.reject(
        input,
        "evidence_required",
        "evidence ID は Run 内で一意である必要があります",
        view,
      );
    }
    const knownArtifactSchemas = new Set(
      contract.artifactSchemas.map((schema) => contractSchemaKey(schema.id, schema.version)),
    );
    if (
      (input.artifacts ?? []).some(
        (artifact) =>
          !knownArtifactSchemas.has(contractSchemaKey(artifact.schemaId, artifact.schemaVersion)),
      )
    ) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "Graph Contract にない artifact schema です",
        view,
      );
    }
    if ((input.evidence ?? []).some((item) => !contract.evidenceKinds.includes(item.kind))) {
      return this.reject(
        input,
        "evidence_required",
        "Graph Contract にない evidence kind です",
        view,
      );
    }

    const acceptedAt = this.dependencies.now();
    const artifacts = this.materializeArtifacts(
      input,
      projection,
      currentNode.id,
      activeAttempt?.id,
      acceptedAt,
    );
    const evidence = this.materializeEvidence(
      input,
      projection,
      currentNode.id,
      activeAttempt?.id,
      acceptedAt,
    );
    const references = referencedIds(input.command);
    const allArtifactIds = new Set([
      ...projection.artifacts.map((artifact) => artifact.id),
      ...artifacts.map((artifact) => artifact.id),
    ]);
    const allEvidenceIds = new Set([
      ...projection.evidence.map((item) => item.id),
      ...evidence.map((item) => item.id),
    ]);
    if (references.artifactIds.some((id) => !allArtifactIds.has(id))) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "参照 artifact が登録されていません",
        view,
      );
    }
    if (references.evidenceIds.some((id) => !allEvidenceIds.has(id))) {
      return this.reject(input, "evidence_required", "参照 evidence が登録されていません", view);
    }
    const allArtifacts = [...projection.artifacts, ...artifacts];
    const allEvidence = [...projection.evidence, ...evidence];
    if (
      artifacts.some((artifact) =>
        artifact.derivedFromArtifactIds.some((id) => !allArtifactIds.has(id)),
      ) ||
      evidence.some((item) => item.artifactIds.some((id) => !allArtifactIds.has(id)))
    ) {
      return this.reject(
        input,
        "artifact_schema_mismatch",
        "artifact lineage の参照先が登録されていません",
        view,
      );
    }

    const artifactsForCommand = references.artifactIds
      .map((id) => allArtifacts.find((artifact) => artifact.id === id))
      .filter((artifact): artifact is RunGraphArtifact => artifact !== undefined);
    const evidenceForCommand = references.evidenceIds
      .map((id) => allEvidence.find((item) => item.id === id))
      .filter((item): item is RunGraphEvidence => item !== undefined);
    if (attemptBoundCommand) {
      if (!activeAttempt) {
        return this.reject(
          input,
          "stale_attempt",
          "attempt-bound command に対応する active attempt がありません",
          view,
        );
      }
      if (
        artifactsForCommand.some(
          (artifact) =>
            artifact.nodeId !== currentNode.id ||
            artifact.producerAttemptId !== activeAttempt.id ||
            artifact.actor.id !== activeAttempt.actor.id ||
            artifact.actor.role !== activeAttempt.actor.role,
        ) ||
        evidenceForCommand.some(
          (item) =>
            item.nodeId !== currentNode.id ||
            item.producerAttemptId !== activeAttempt.id ||
            item.actor.id !== activeAttempt.actor.id ||
            item.actor.role !== activeAttempt.actor.role,
        )
      ) {
        return this.reject(
          input,
          "stale_attempt",
          "attempt-bound command の artifact/evidence は active attempt の lineage に属していません",
          view,
        );
      }
    }
    if (
      input.command.type === "attempt_finished" &&
      evidenceForCommand.some((item) => item.kind !== "command_execution")
    ) {
      return this.reject(
        input,
        "evidence_required",
        "attempt result には command_execution evidence が必要です",
        view,
      );
    }
    if (input.command.type === "run_paused" || input.command.type === "run_resumed") {
      const checkpointArtifactId = input.command.checkpointArtifactId;
      const checkpoint = allArtifacts.find((artifact) => artifact.id === checkpointArtifactId);
      if (
        !checkpoint ||
        contractSchemaKey(checkpoint.schemaId, checkpoint.schemaVersion) !== "run.checkpoint@1"
      ) {
        return this.reject(
          input,
          "artifact_schema_mismatch",
          "pause/resume には run.checkpoint@1 が必要です",
          view,
        );
      }
      if (
        !evidenceForCommand.some(
          (item) => item.kind === "checkpoint" && item.artifactIds.includes(checkpoint.id),
        ) ||
        evidenceForCommand.some(
          (item) => !["checkpoint", "side_effect_reconciliation"].includes(item.kind),
        )
      ) {
        return this.reject(
          input,
          "evidence_required",
          "checkpoint evidence が checkpoint artifact を参照していません",
          view,
        );
      }
      const checkpointEvidence = evidenceForCommand.filter(
        (item) => item.kind === "checkpoint" && item.artifactIds.includes(checkpoint.id),
      );
      if (
        input.command.type === "run_paused" &&
        (!activeAttempt ||
          checkpoint.nodeId !== currentNode.id ||
          checkpoint.producerAttemptId !== activeAttempt.id ||
          checkpoint.actor.id !== activeAttempt.actor.id ||
          checkpoint.actor.role !== activeAttempt.actor.role ||
          checkpointEvidence.some(
            (item) =>
              item.nodeId !== currentNode.id ||
              item.producerAttemptId !== activeAttempt.id ||
              item.actor.id !== activeAttempt.actor.id ||
              item.actor.role !== activeAttempt.actor.role,
          ))
      ) {
        return this.reject(
          input,
          "stale_attempt",
          "checkpoint artifact/evidence は active attempt の lineage に属していません",
          view,
        );
      }
      if (input.command.type === "run_resumed") {
        const resumeCommand = input.command;
        const latestPause = [...journal.acceptedEvents]
          .reverse()
          .find((event) => event.command.type === "run_paused");
        const latestPauseCommand =
          latestPause?.command.type === "run_paused" ? latestPause.command : undefined;
        const latestCheckpointEvidenceIds =
          latestPause && latestPauseCommand
            ? latestPause.evidenceIds.filter((id) => {
                const item = allEvidence.find((evidenceItem) => evidenceItem.id === id);
                return (
                  item?.kind === "checkpoint" &&
                  item.artifactIds.includes(latestPauseCommand.checkpointArtifactId)
                );
              })
            : [];
        if (
          !activeAttempt ||
          !latestPauseCommand ||
          latestPauseCommand.checkpointArtifactId !== checkpoint.id ||
          latestCheckpointEvidenceIds.length === 0 ||
          latestCheckpointEvidenceIds.some((id) => !resumeCommand.evidenceIds.includes(id)) ||
          checkpoint.nodeId !== currentNode.id ||
          checkpoint.producerAttemptId !== activeAttempt.id ||
          checkpoint.actor.id !== activeAttempt.actor.id ||
          checkpoint.actor.role !== activeAttempt.actor.role ||
          checkpointEvidence.some(
            (item) =>
              item.nodeId !== currentNode.id ||
              item.producerAttemptId !== activeAttempt.id ||
              item.actor.id !== activeAttempt.actor.id ||
              item.actor.role !== activeAttempt.actor.role,
          )
        ) {
          return this.reject(
            input,
            "stale_attempt",
            "resume checkpoint は最新 pause と active attempt の lineage に一致していません",
            view,
          );
        }
        if (input.command.sideEffectState === "unknown") {
          return this.reject(
            input,
            "evidence_required",
            "外部副作用の状態が unknown の Run は自動再開できません",
            view,
          );
        }
        if (
          (input.command.sideEffectState === "committed" ||
            input.command.sideEffectState === "reconciled") &&
          !evidenceForCommand.some((item) => item.kind === "side_effect_reconciliation")
        ) {
          return this.reject(
            input,
            "evidence_required",
            "実行済み外部副作用には reconciliation evidence が必要です",
            view,
          );
        }
      }
    }
    if (
      input.command.type === "human_decision" &&
      evidenceForCommand.some((item) => item.kind !== "human_decision")
    ) {
      return this.reject(input, "evidence_required", "human decision evidence が必要です", view);
    }
    if (input.command.type === "pr_observed") {
      const expectedRepository = `${projection.run.task.owner}/${projection.run.task.repo}`;
      if (input.command.repository.toLowerCase() !== expectedRepository.toLowerCase()) {
        return this.reject(
          input,
          "pr_not_linked_to_task",
          `PR evidence の repository は ${expectedRepository} である必要があります`,
          view,
        );
      }
      if (!input.command.linkedIssue) {
        return this.reject(
          input,
          input.command.linkageComplete ? "pr_not_linked_to_task" : "github_live_state_unavailable",
          input.command.linkageComplete
            ? `PR #${input.command.pullRequestNumber} は Run 対象 Issue #${projection.run.task.issueNumber} に紐づいていません`
            : "PR と Run 対象 Issue の live linkage を確定できません",
          view,
        );
      }
      if (
        input.command.linkedIssue.owner.toLowerCase() !== projection.run.task.owner.toLowerCase() ||
        input.command.linkedIssue.repo.toLowerCase() !== projection.run.task.repo.toLowerCase() ||
        input.command.linkedIssue.issueNumber !== projection.run.task.issueNumber
      ) {
        return this.reject(
          input,
          "pr_not_linked_to_task",
          "PR の live linkage が Run 対象 Issue と一致しません",
          view,
        );
      }
      if (
        evidenceForCommand.length === 0 ||
        evidenceForCommand.some((item) => item.kind !== "github_pr_live")
      ) {
        return this.reject(
          input,
          "evidence_required",
          "GitHub から取得した PR live evidence が必要です",
          view,
        );
      }
    }

    let nextNodeId: string | undefined;
    let nextContractNodeId: string | undefined;
    let waitReason: string | undefined;
    if (input.command.type === "node_outcome_submitted") {
      const expectedSchemas =
        contract.nodes.find((node) => node.id === currentNode.contractNodeId)
          ?.outputArtifactSchemas ?? [];
      if (
        artifactsForCommand.length === 0 ||
        artifactsForCommand.some(
          (artifact) =>
            !expectedSchemas.includes(contractSchemaKey(artifact.schemaId, artifact.schemaVersion)),
        )
      ) {
        return this.reject(
          input,
          "artifact_schema_mismatch",
          `node ${currentNode.contractNodeId} の output artifact schema と一致しません`,
          view,
        );
      }
      if (references.evidenceIds.length === 0) {
        return this.reject(
          input,
          "evidence_required",
          "node outcome には evidence が必要です",
          view,
        );
      }
      const requiredEvidenceKind =
        currentNode.contractNodeId === "reviewer" ? "independent_review" : "artifact_validation";
      if (evidenceForCommand.some((item) => item.kind !== requiredEvidenceKind)) {
        return this.reject(
          input,
          "evidence_required",
          `node outcome には ${requiredEvidenceKind} evidence が必要です`,
          view,
        );
      }
      const transition = this.resolveNodeOutcome(
        contract,
        currentNode.contractNodeId,
        input.command.outcome,
        projection,
      );
      if (!transition) {
        return this.reject(input, "invalid_transition", "contract にない node outcome です", view);
      }
      nextNodeId = this.dependencies.nextId("node");
      nextContractNodeId = transition.target;
      waitReason = transition.waitReason;
    }
    if (input.command.type === "human_decision") {
      const currentWaitReason = [...journal.acceptedEvents]
        .reverse()
        .find((event) => event.waitReason)?.waitReason;
      if (
        input.command.decision === "approved" &&
        currentWaitReason !== "human_approval_required"
      ) {
        return this.reject(
          input,
          "invalid_transition",
          "budget/blocked gate を解除するには理由付き override が必要です",
          view,
        );
      }
      if (
        input.command.decision === "override" &&
        currentWaitReason !== "human_approval_required"
      ) {
        nextNodeId = this.dependencies.nextId("node");
        nextContractNodeId = "implementer";
      }
    }

    const event: RunGraphAcceptedEvent = {
      recordType: "accepted",
      eventId: input.eventId,
      sequence: journal.acceptedEvents.length + 1,
      runId: input.runId,
      acceptedAt,
      actor: input.actor,
      command: input.command,
      artifactIds: references.artifactIds,
      evidenceIds: references.evidenceIds,
      artifacts,
      evidence,
      ...(nextNodeId ? { nextNodeId } : {}),
      ...(nextContractNodeId ? { nextContractNodeId } : {}),
      ...(waitReason ? { waitReason } : {}),
    };
    await this.events.appendAccepted(event);
    return { accepted: true, view: await this.inspect(input.runId) };
  }

  async inspect(runId: string, limit = 20): Promise<RunGraphView> {
    const journal = await this.events.readJournal(runId);
    const projection = this.replay(journal);
    const currentNode =
      projection.nodes.find((node) => node.id === projection.run.currentNodeId) ?? null;
    const activeAttempt = currentNode?.activeAttemptId
      ? (projection.attempts.find((attempt) => attempt.id === currentNode.activeAttemptId) ?? null)
      : null;
    const artifacts = projection.artifacts.slice(-limit);
    const evidence = projection.evidence.slice(-limit);
    return RunGraphViewSchema.parse({
      schemaVersion: "1",
      runId: projection.run.id,
      task: projection.run.task,
      revision: projection.revision,
      state: projection.run.state,
      currentNode,
      activeAttempt,
      waitReason:
        projection.run.state === "waiting_human"
          ? ([...journal.acceptedEvents].reverse().find((event) => event.waitReason)?.waitReason ??
            "human_gate_required")
          : null,
      budgets: projection.budgets,
      allowedNextTransitions:
        projection.run.state === "paused"
          ? ["run_resumed"]
          : projection.run.state === "waiting_human"
            ? ["human_decision"]
            : currentNode?.contractNodeId === "human-pr" && currentNode.state === "running"
              ? ["pr_observed"]
              : currentNode?.state === "ready"
                ? ["attempt_started"]
                : currentNode?.state === "running" && activeAttempt?.state === "running"
                  ? ["attempt_finished", "run_paused"]
                  : currentNode?.state === "running" && activeAttempt?.state === "succeeded"
                    ? ["node_outcome_submitted", "run_paused"]
                    : [],
      artifacts: {
        total: projection.artifacts.length,
        limit,
        truncated: projection.artifacts.length > artifacts.length,
        items: artifacts,
      },
      evidence: {
        total: projection.evidence.length,
        limit,
        truncated: projection.evidence.length > evidence.length,
        items: evidence,
      },
    });
  }

  private async reject(
    input: RunGraphRunnerCommandInput,
    code: RunGraphRejectionCode,
    message: string,
    view: RunGraphView,
  ): Promise<RunGraphCommandResult> {
    await this.events.appendRejection({
      recordType: "rejected",
      rejectionId: this.dependencies.nextId("rejection"),
      eventId: input.eventId,
      runId: input.runId,
      rejectedAt: this.dependencies.now(),
      actor: input.actor,
      command: input.command,
      code,
      message,
      stateUnchanged: true,
    });
    return { accepted: false, code, message, stateUnchanged: true, view };
  }

  private hasAuthority(
    input: RunGraphRunnerCommandInput,
    currentRole: string,
    contract: GraphContract,
  ): boolean {
    if (input.command.type === "human_decision") {
      return this.contractAllows(contract, "human_decision", input.actor.role);
    }
    if (input.command.type === "pr_observed") {
      return this.contractAllows(contract, "pr_observe", input.actor.role);
    }
    if (input.command.type === "run_paused" || input.command.type === "run_resumed") {
      return (
        this.contractAllows(contract, "run_checkpoint", input.actor.role) &&
        (input.actor.role === currentRole || input.actor.role === "orchestrator")
      );
    }
    return (
      this.contractAllows(contract, "node_attempt", input.actor.role) &&
      input.actor.role === currentRole
    );
  }

  private contractAllows(contract: GraphContract, action: string, role: string): boolean {
    return (
      contract.authorities
        .find((authority) => authority.action === action)
        ?.roles.includes(role as GraphContract["roles"][number]["id"]) ?? false
    );
  }

  private validateTransition(
    input: RunGraphRunnerCommandInput,
    projection: RunGraphProjection,
    contractNodeId: string,
    nodeState: string,
    attemptState: string | undefined,
  ): { code: RunGraphRejectionCode; message: string } | null {
    const type = input.command.type;
    if (type === "attempt_started" && nodeState === "ready") return null;
    if (type === "attempt_finished" && nodeState === "running" && attemptState === "running") {
      if (input.command.evidenceIds.length === 0) {
        return { code: "evidence_required", message: "attempt result には evidence が必要です" };
      }
      return null;
    }
    if (
      type === "node_outcome_submitted" &&
      nodeState === "running" &&
      attemptState === "succeeded"
    ) {
      return null;
    }
    if (type === "run_paused" && projection.run.state === "running" && nodeState === "running") {
      return null;
    }
    if (type === "run_resumed" && projection.run.state === "paused" && nodeState === "paused") {
      return null;
    }
    if (type === "human_decision" && projection.run.state === "waiting_human") {
      return input.command.evidenceIds.length > 0
        ? null
        : { code: "evidence_required", message: "human decision には evidence が必要です" };
    }
    if (
      type === "pr_observed" &&
      projection.run.state === "running" &&
      contractNodeId === "human-pr" &&
      nodeState === "running"
    ) {
      return null;
    }
    return { code: "invalid_transition", message: `${type} は現在の state では受理できません` };
  }

  private materializeArtifacts(
    input: RunGraphRunnerCommandInput,
    projection: RunGraphProjection,
    nodeId: string,
    attemptId: string | undefined,
    createdAt: string,
  ): RunGraphArtifact[] {
    if ((input.artifacts?.length ?? 0) > 0 && !attemptId) return [];
    const producerActor =
      input.command.type === "run_paused" && attemptId
        ? (projection.attempts.find((attempt) => attempt.id === attemptId)?.actor ?? input.actor)
        : input.actor;
    return (input.artifacts ?? []).map((artifact) => ({
      ...artifact,
      runId: input.runId,
      nodeId,
      producerAttemptId: attemptId as string,
      actor: producerActor,
      createdAt,
    }));
  }

  private materializeEvidence(
    input: RunGraphRunnerCommandInput,
    projection: RunGraphProjection,
    nodeId: string,
    attemptId: string | undefined,
    createdAt: string,
  ): RunGraphEvidence[] {
    const producerActor =
      input.command.type === "run_paused" && attemptId
        ? (projection.attempts.find((attempt) => attempt.id === attemptId)?.actor ?? input.actor)
        : input.actor;
    return (input.evidence ?? []).map((item) => ({
      ...item,
      runId: input.runId,
      nodeId,
      producerAttemptId: attemptId ?? null,
      actor: producerActor,
      createdAt,
    }));
  }

  private resolveNodeOutcome(
    contract: GraphContract,
    contractNodeId: string,
    outcome: string,
    projection: RunGraphProjection,
  ): { target: string; waitReason?: string } | null {
    const target = (condition: string): string | null =>
      contract.edges.find((edge) => edge.from === contractNodeId && edge.condition === condition)
        ?.to ?? null;
    if (contractNodeId === "planner") {
      const next = target(outcome);
      return outcome === "plan_valid" && next
        ? { target: next }
        : outcome === "plan_invalid" && next
          ? { target: next, waitReason: "plan_invalid" }
          : null;
    }
    if (contractNodeId === "implementer") {
      const next = target(outcome);
      return outcome === "implementation_valid" && next
        ? { target: next }
        : outcome === "implementation_invalid" && next
          ? { target: next, waitReason: "implementation_invalid" }
          : null;
    }
    if (contractNodeId === "executor") {
      if (outcome === "verify_passed") {
        const next = target(outcome);
        return next ? { target: next } : null;
      }
      if (outcome === "verify_failed") {
        const budgetAvailable =
          projection.budgets.executorRetries < contract.budgets.maxExecutorRetries;
        const condition = budgetAvailable ? outcome : "verify_budget_exhausted";
        const next = target(condition);
        return next
          ? budgetAvailable
            ? { target: next }
            : { target: next, waitReason: "verify_budget_exhausted" }
          : null;
      }
      return null;
    }
    if (contractNodeId === "reviewer") {
      if (outcome === "approve" || outcome === "comment") {
        const next = target(outcome);
        return next ? { target: next, waitReason: "human_approval_required" } : null;
      }
      if (outcome === "request_changes") {
        const budgetAvailable =
          projection.budgets.improvementIterations < contract.budgets.maxImprovementIterations;
        const condition = budgetAvailable ? outcome : "review_budget_exhausted";
        const next = target(condition);
        return next
          ? budgetAvailable
            ? { target: next }
            : { target: next, waitReason: "review_budget_exhausted" }
          : null;
      }
      if (outcome === "block" || outcome === "critical") {
        const next = target(outcome);
        return next
          ? { target: next, waitReason: outcome === "critical" ? "escalated" : "blocked" }
          : null;
      }
    }
    return null;
  }

  private replay(journal: { acceptedEvents: RunGraphAcceptedEvent[] }): RunGraphProjection {
    const first = journal.acceptedEvents[0];
    if (!first || first.command.type !== "run_started") {
      throw new Error("Run Graph の先頭 event は run_started である必要があります");
    }
    const timestamp = first.acceptedAt;
    const projection: RunGraphProjection = {
      schemaVersion: "1",
      revision: 1,
      run: {
        id: first.runId,
        state: "running",
        task: first.command.task,
        contract: first.command.contract,
        actor: first.actor,
        createdAt: timestamp,
        updatedAt: timestamp,
        currentNodeId: first.command.firstNodeId,
        parentRunId: null,
        inputArtifactIds: [],
        outputArtifactIds: [],
      },
      nodes: [
        {
          id: first.command.firstNodeId,
          runId: first.runId,
          contractNodeId: "planner",
          state: "ready",
          actor: actorForContractNode("planner"),
          createdAt: timestamp,
          updatedAt: timestamp,
          activeAttemptId: null,
          previousNodeId: null,
          inputArtifactIds: [],
          outputArtifactIds: [],
        },
      ],
      attempts: [],
      artifacts: [],
      evidence: [],
      budgets: { executorRetries: 0, improvementIterations: 0 },
    };

    for (const event of journal.acceptedEvents.slice(1)) {
      const command = event.command;
      if (command.type === "run_started") {
        throw new Error("run_started は journal の先頭にだけ置けます");
      }
      projection.revision = event.sequence;
      projection.run.updatedAt = event.acceptedAt;
      projection.artifacts.push(...(event.artifacts ?? []));
      projection.evidence.push(...(event.evidence ?? []));
      for (const artifact of event.artifacts ?? []) {
        if (!projection.run.outputArtifactIds.includes(artifact.id)) {
          projection.run.outputArtifactIds.push(artifact.id);
        }
      }

      const currentNode = projection.nodes.find((node) => node.id === projection.run.currentNodeId);
      if (!currentNode) throw new Error("current node が projection に存在しません");

      if (command.type === "attempt_started") {
        const previous = projection.attempts
          .filter((attempt) => attempt.nodeId === currentNode.id)
          .at(-1);
        projection.attempts.push({
          id: command.attemptId,
          runId: projection.run.id,
          nodeId: currentNode.id,
          ordinal: (previous?.ordinal ?? 0) + 1,
          state: "running",
          actor: event.actor,
          createdAt: event.acceptedAt,
          updatedAt: event.acceptedAt,
          previousAttemptId: previous?.id ?? null,
          inputArtifactIds: [...currentNode.inputArtifactIds],
          outputArtifactIds: [],
        });
        currentNode.state = "running";
        currentNode.actor = event.actor;
        currentNode.activeAttemptId = command.attemptId;
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }

      const activeAttempt = currentNode.activeAttemptId
        ? projection.attempts.find((attempt) => attempt.id === currentNode.activeAttemptId)
        : undefined;

      if (command.type === "attempt_finished") {
        if (!activeAttempt)
          throw new Error("attempt result に対応する active attempt がありません");
        activeAttempt.state = command.outcome;
        activeAttempt.updatedAt = event.acceptedAt;
        activeAttempt.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !activeAttempt.outputArtifactIds.includes(id)),
        );
        currentNode.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !currentNode.outputArtifactIds.includes(id)),
        );
        currentNode.updatedAt = event.acceptedAt;
        if (command.outcome !== "succeeded") {
          currentNode.state = command.outcome === "cancelled" ? "cancelled" : "failed";
          projection.run.state = command.outcome === "cancelled" ? "cancelled" : "failed";
        }
        continue;
      }

      if (command.type === "node_outcome_submitted") {
        if (!activeAttempt) throw new Error("node outcome に対応する active attempt がありません");
        activeAttempt.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !activeAttempt.outputArtifactIds.includes(id)),
        );
        currentNode.outputArtifactIds.push(
          ...event.artifactIds.filter((id) => !currentNode.outputArtifactIds.includes(id)),
        );
        currentNode.state = "completed";
        currentNode.updatedAt = event.acceptedAt;
        if (
          currentNode.contractNodeId === "executor" &&
          command.outcome === "verify_failed" &&
          !event.waitReason
        ) {
          projection.budgets.executorRetries += 1;
        }
        if (
          currentNode.contractNodeId === "reviewer" &&
          command.outcome === "request_changes" &&
          !event.waitReason
        ) {
          projection.budgets.improvementIterations += 1;
        }
        if (!event.nextNodeId || !event.nextContractNodeId) {
          throw new Error("node outcome accepted event に next node binding がありません");
        }
        const targetContractNodeId = event.nextContractNodeId;
        const waitingHuman = targetContractNodeId === "human-pr";
        projection.nodes.push({
          id: event.nextNodeId,
          runId: projection.run.id,
          contractNodeId: targetContractNodeId,
          state: waitingHuman ? "waiting_human" : "ready",
          actor: actorForContractNode(targetContractNodeId),
          createdAt: event.acceptedAt,
          updatedAt: event.acceptedAt,
          activeAttemptId: null,
          previousNodeId: currentNode.id,
          inputArtifactIds: [...new Set(projection.run.outputArtifactIds)],
          outputArtifactIds: [],
        });
        projection.run.currentNodeId = event.nextNodeId;
        projection.run.state = waitingHuman ? "waiting_human" : "running";
        continue;
      }

      if (command.type === "run_paused") {
        projection.run.state = "paused";
        currentNode.state = "paused";
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }
      if (command.type === "run_resumed") {
        projection.run.state = "running";
        currentNode.state = "running";
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }
      if (command.type === "human_decision") {
        if (command.decision === "rejected") {
          projection.run.state = "cancelled";
          currentNode.state = "cancelled";
        } else if (event.nextNodeId) {
          if (!event.nextContractNodeId) {
            throw new Error("human override event に next contract node ID がありません");
          }
          currentNode.state = "completed";
          currentNode.updatedAt = event.acceptedAt;
          projection.nodes.push({
            id: event.nextNodeId,
            runId: projection.run.id,
            contractNodeId: event.nextContractNodeId,
            state: "ready",
            actor: actorForContractNode(event.nextContractNodeId),
            createdAt: event.acceptedAt,
            updatedAt: event.acceptedAt,
            activeAttemptId: null,
            previousNodeId: currentNode.id,
            inputArtifactIds: [...currentNode.inputArtifactIds],
            outputArtifactIds: [],
          });
          projection.run.currentNodeId = event.nextNodeId;
          projection.run.state = "running";
        } else {
          projection.run.state = "running";
          currentNode.state = "running";
        }
        currentNode.actor = event.actor;
        currentNode.updatedAt = event.acceptedAt;
        continue;
      }
      if (command.type === "pr_observed") {
        const linkedIssue = command.linkedIssue;
        const hasExactTaskLinkage =
          linkedIssue !== null &&
          linkedIssue.owner.toLowerCase() === projection.run.task.owner.toLowerCase() &&
          linkedIssue.repo.toLowerCase() === projection.run.task.repo.toLowerCase() &&
          linkedIssue.issueNumber === projection.run.task.issueNumber;
        if (hasExactTaskLinkage && (command.state === "merged" || command.state === "closed")) {
          projection.run.state = "completed";
          currentNode.state = "completed";
          projection.run.outputArtifactIds.push(
            ...event.artifactIds.filter((id) => !projection.run.outputArtifactIds.includes(id)),
          );
        }
        currentNode.updatedAt = event.acceptedAt;
      }
    }
    return RunGraphProjectionSchema.parse(projection);
  }
}
