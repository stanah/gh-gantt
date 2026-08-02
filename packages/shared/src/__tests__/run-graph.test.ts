import { describe, expect, it } from "vitest";
import {
  BoundedRunGraphReferenceSchema,
  DispatchClaimReceiptSchema,
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  GraphContractSchema,
  RunGraphAcceptedEventSchema,
  RunGraphArtifactSchema,
  RunGraphArtifactSubmissionSchema,
  RunGraphAttemptSchema,
  RunGraphConfigSchema,
  RunGraphEvidenceSchema,
  RunGraphEvidenceSubmissionSchema,
  RunGraphJournalSchema,
  RunGraphNodeSchema,
  RunGraphProjectionSchema,
  RunGraphRunnerCommandInputSchema,
  RunGraphStartInputSchema,
  RunGraphRunSchema,
  RunGraphViewSchema,
  type GraphContract,
} from "../run-graph.js";

describe("[NFR-STABILITY-014-AC9] claim receipt は operation ごとの不正状態を拒否する", () => {
  const claim = {
    taskId: "stanah/gh-gantt#329",
    repository: "stanah/gh-gantt",
    state: "Todo",
    ownerId: "owner-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    claimId: "claim-1",
    entityVersion: 1,
    fencingToken: 1,
    acquiredAt: "2026-08-02T00:00:00.000Z",
    expiresAt: "2026-08-02T00:05:00.000Z",
    dispatchPlanId: "dispatch-plan-1",
    dispatchPlanVersion: "1" as const,
  };
  const base = {
    accepted: true as const,
    eventId: "event-1",
    entityVersion: 1,
    stateUnchanged: false as const,
    claim,
  };

  it("authorize_event は completion を必須にし、reclaim field を拒否する", () => {
    expect(() =>
      DispatchClaimReceiptSchema.parse({ ...base, operation: "authorize_event" }),
    ).toThrow();
    expect(() =>
      DispatchClaimReceiptSchema.parse({
        ...base,
        operation: "authorize_event",
        completion: {
          runId: "run-1",
          taskId: "stanah/gh-gantt#329",
          actorId: "owner-1",
          commandFingerprint: "a".repeat(64),
        },
        reclaimReason: "expired",
      }),
    ).toThrow();
  });

  it("claim と heartbeat は reclaim/completion field を拒否する", () => {
    expect(() =>
      DispatchClaimReceiptSchema.parse({
        ...base,
        operation: "claim",
        completion: {
          runId: "run-1",
          taskId: "stanah/gh-gantt#329",
          actorId: "owner-1",
          commandFingerprint: "a".repeat(64),
        },
      }),
    ).toThrow();
    expect(() =>
      DispatchClaimReceiptSchema.parse({
        ...base,
        operation: "heartbeat",
        reclaimReason: "expired",
      }),
    ).toThrow();
  });

  it("reclaim は reason と evidence の組を厳密に検証する", () => {
    expect(() => DispatchClaimReceiptSchema.parse({ ...base, operation: "reclaim" })).toThrow();
    expect(() =>
      DispatchClaimReceiptSchema.parse({
        ...base,
        operation: "reclaim",
        reclaimReason: "expired",
        evidenceId: "unexpected-evidence",
      }),
    ).toThrow();
    expect(() =>
      DispatchClaimReceiptSchema.parse({
        ...base,
        operation: "reclaim",
        reclaimReason: "owner_stopped",
      }),
    ).toThrow();
  });
});

describe("[NFR-STABILITY-014-AC3] Graph Contract が固定 dev-role graph の統制要素を表現する", () => {
  it("version、role、node、edge、artifact、evidence、authority、budget、human gate を検証する", () => {
    const contract: GraphContract = GraphContractSchema.parse(FIXED_DEV_ROLE_GRAPH_CONTRACT);

    expect(contract.schemaVersion).toBe("1");
    expect(contract.planId).toBe("dev-role-fixed");
    expect(contract.planVersion).toBe("1");
    expect(contract.roles.map((role) => role.id)).toEqual([
      "orchestrator",
      "planner",
      "implementer",
      "executor",
      "reviewer",
      "human",
    ]);
    expect(contract.nodes.map((node) => node.id)).toEqual([
      "planner",
      "implementer",
      "executor",
      "reviewer",
      "human-pr",
    ]);
    expect(contract.edges).toContainEqual(
      expect.objectContaining({ from: "executor", to: "implementer", condition: "verify_failed" }),
    );
    expect(contract.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "planner", to: "planner", condition: "human_override" }),
        expect.objectContaining({
          from: "implementer",
          to: "implementer",
          condition: "human_override",
        }),
        expect.objectContaining({ from: "executor", to: "executor", condition: "human_override" }),
        expect.objectContaining({ from: "reviewer", to: "reviewer", condition: "human_override" }),
        expect.objectContaining({
          from: "human-pr",
          to: "implementer",
          condition: "human_override",
        }),
      ]),
    );
    expect(contract.edges).toContainEqual(
      expect.objectContaining({
        from: "reviewer",
        to: "implementer",
        condition: "request_changes",
      }),
    );
    expect(contract.artifactSchemas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "dev-role.plan", version: "1" }),
        expect.objectContaining({ id: "dev-role.review", version: "1" }),
      ]),
    );
    expect(contract.evidenceKinds).toContain("command_execution");
    expect(contract.authorities).toContainEqual(
      expect.objectContaining({ action: "human_decision", roles: ["human"] }),
    );
    expect(contract.budgets).toEqual({ maxExecutorRetries: 2, maxImprovementIterations: 3 });
    expect(contract.humanGate).toEqual(
      expect.objectContaining({ approvalRoles: ["human"], overrideRequiresReason: true }),
    );
    expect(() =>
      GraphContractSchema.parse({
        ...FIXED_DEV_ROLE_GRAPH_CONTRACT,
        edges: [
          ...FIXED_DEV_ROLE_GRAPH_CONTRACT.edges,
          { id: "invalid", from: "unknown", to: "executor", condition: "invalid" },
        ],
      }),
    ).toThrow(/edge/);
  });
});

describe("[NFR-STABILITY-014-AC1] repository config が versioned Graph Contract を exact binding する", () => {
  it("plan ID、plan version、schema version の完全な組だけを受理する", () => {
    expect(
      RunGraphConfigSchema.parse({
        plan_id: "dev-role-fixed",
        plan_version: "1",
        schema_version: "1",
      }),
    ).toEqual({
      plan_id: "dev-role-fixed",
      plan_version: "1",
      schema_version: "1",
    });

    expect(() =>
      RunGraphConfigSchema.parse({ plan_id: "dev-role-fixed", plan_version: "1" }),
    ).toThrow();
  });
});

describe("[NFR-STABILITY-014-AC4] Run Graph entity が安定 ID と lineage を保持する", () => {
  const actor = { id: "actor-1", role: "implementer" } as const;
  const createdAt = "2026-07-30T00:00:00.000Z";
  const updatedAt = "2026-07-30T00:01:00.000Z";

  it("run、node、attempt の状態・時刻・actor・入出力参照を検証する", () => {
    const run = RunGraphRunSchema.parse({
      id: "run-1",
      state: "running",
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      actor,
      createdAt,
      updatedAt,
      currentNodeId: "node-1",
      parentRunId: null,
      inputArtifactIds: ["artifact-plan"],
      outputArtifactIds: [],
    });
    const node = RunGraphNodeSchema.parse({
      id: "node-1",
      runId: run.id,
      contractNodeId: "implementer",
      state: "running",
      actor,
      createdAt,
      updatedAt,
      activeAttemptId: "attempt-1",
      previousNodeId: null,
      inputArtifactIds: ["artifact-plan"],
      outputArtifactIds: [],
    });
    const attempt = RunGraphAttemptSchema.parse({
      id: "attempt-1",
      runId: run.id,
      nodeId: node.id,
      ordinal: 1,
      state: "running",
      actor,
      createdAt,
      updatedAt,
      previousAttemptId: null,
      inputArtifactIds: ["artifact-plan"],
      outputArtifactIds: [],
    });

    expect(run.state).toBe("running");
    expect(node.activeAttemptId).toBe(attempt.id);
    expect(attempt.previousAttemptId).toBeNull();
  });

  it("artifact と evidence は本文ではなく hash 付き bounded reference を保持する", () => {
    const reference = BoundedRunGraphReferenceSchema.parse({
      kind: "workspace",
      uri: ".dev-flow/328/02-impl-result-pass-1.json",
      sha256: `sha256:${"a".repeat(64)}`,
      byteLength: 512,
    });
    const artifact = RunGraphArtifactSchema.parse({
      id: "artifact-implementation",
      runId: "run-1",
      nodeId: "node-1",
      producerAttemptId: "attempt-1",
      schemaId: "dev-role.implementation",
      schemaVersion: "1",
      actor,
      createdAt,
      derivedFromArtifactIds: ["artifact-plan"],
      reference,
    });
    const evidence = RunGraphEvidenceSchema.parse({
      id: "evidence-command",
      runId: "run-1",
      nodeId: "node-1",
      producerAttemptId: "attempt-1",
      kind: "command_execution",
      actor,
      createdAt,
      artifactIds: [artifact.id],
      provenance: "local-runner",
      reference,
    });

    expect(artifact.derivedFromArtifactIds).toEqual(["artifact-plan"]);
    expect(evidence.reference.byteLength).toBe(512);
    expect(() =>
      BoundedRunGraphReferenceSchema.parse({ ...reference, content: "本文を埋め込まない" }),
    ).toThrow();
  });
});

describe("[NFR-STABILITY-014-AC2] 外部 runner command と append-only journal を検証する", () => {
  const actor = { id: "runner-1", role: "executor" } as const;
  const commands = [
    { type: "attempt_started", nodeId: "node-1", attemptId: "attempt-1" },
    {
      type: "attempt_finished",
      nodeId: "node-1",
      attemptId: "attempt-1",
      outcome: "succeeded",
      artifactIds: ["artifact-1"],
      evidenceIds: ["evidence-1"],
    },
    {
      type: "node_outcome_submitted",
      nodeId: "node-1",
      attemptId: "attempt-1",
      outcome: "verify_passed",
      artifactIds: ["artifact-1"],
      evidenceIds: ["evidence-1"],
    },
    {
      type: "run_paused",
      checkpointArtifactId: "artifact-checkpoint",
      evidenceIds: ["evidence-checkpoint"],
      reason: "外部 runner を停止する",
    },
    {
      type: "run_resumed",
      checkpointArtifactId: "artifact-checkpoint",
      evidenceIds: ["evidence-checkpoint"],
      sideEffectState: "not_started",
    },
    {
      type: "human_decision",
      decision: "override",
      reason: "承認済みの緊急対応",
      evidenceIds: ["evidence-human"],
    },
    {
      type: "pr_observed",
      repository: "stanah/gh-gantt",
      pullRequestNumber: 334,
      state: "merged",
      isDraft: false,
      linkedIssue: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      linkageComplete: true,
      evidenceIds: ["evidence-pr"],
    },
  ] as const;

  it("runner は target state や sequence を含まない7種類の command だけを送信する", () => {
    const parsed = commands.map((command, index) =>
      RunGraphRunnerCommandInputSchema.parse({
        schemaVersion: "1",
        eventId: `runner-event-${index + 1}`,
        runId: "run-1",
        actor,
        command,
      }),
    );

    expect(parsed.map((input) => input.command.type)).toEqual([
      "attempt_started",
      "attempt_finished",
      "node_outcome_submitted",
      "run_paused",
      "run_resumed",
      "human_decision",
      "pr_observed",
    ]);
    expect(() =>
      RunGraphRunnerCommandInputSchema.parse({
        schemaVersion: "1",
        eventId: "runner-event-invalid",
        runId: "run-1",
        actor,
        command: { ...commands[0], targetState: "completed" },
      }),
    ).toThrow();
    expect(() =>
      RunGraphRunnerCommandInputSchema.parse({
        schemaVersion: "1",
        eventId: "runner-event-pr-without-linkage",
        runId: "run-1",
        actor,
        command: {
          type: "pr_observed",
          repository: "stanah/gh-gantt",
          pullRequestNumber: 334,
          state: "merged",
          evidenceIds: ["evidence-pr"],
        },
      }),
    ).toThrow();
  });

  it("同じ event ID の再送を accepted event として再受理せず rejection に残す", () => {
    const command = commands[0];
    const acceptedEvent = {
      recordType: "accepted",
      eventId: "runner-event-1",
      sequence: 1,
      runId: "run-1",
      acceptedAt: "2026-07-30T00:02:00.000Z",
      actor,
      command,
      artifactIds: [],
      evidenceIds: [],
    } as const;
    const duplicateRejection = {
      recordType: "rejected",
      rejectionId: "rejection-1",
      eventId: acceptedEvent.eventId,
      runId: "run-1",
      rejectedAt: "2026-07-30T00:03:00.000Z",
      actor,
      command,
      code: "duplicate_event",
      message: "受理済み event ID です",
      stateUnchanged: true,
    } as const;

    const journal = RunGraphJournalSchema.parse({
      schemaVersion: "1",
      runId: "run-1",
      acceptedEvents: [acceptedEvent],
      rejections: [duplicateRejection],
    });
    expect(journal.acceptedEvents).toHaveLength(1);
    expect(journal.rejections[0]?.code).toBe("duplicate_event");

    expect(() =>
      RunGraphJournalSchema.parse({
        ...journal,
        acceptedEvents: [acceptedEvent, { ...acceptedEvent, sequence: 2 }],
      }),
    ).toThrow(/event ID/);
  });

  it("理由のない human override を拒否する", () => {
    expect(() =>
      RunGraphRunnerCommandInputSchema.parse({
        schemaVersion: "1",
        eventId: "runner-event-override",
        runId: "run-1",
        actor: { id: "human-1", role: "human" },
        command: {
          type: "human_decision",
          decision: "override",
          reason: null,
          evidenceIds: ["evidence-human"],
        },
      }),
    ).toThrow(/override/);
  });

  it("outcome event は artifact/evidence 本文ではなく schema-bound reference を運べる", () => {
    const artifact = RunGraphArtifactSubmissionSchema.parse({
      id: "artifact-verify",
      schemaId: "dev-role.verify",
      schemaVersion: "1",
      derivedFromArtifactIds: ["artifact-implementation"],
      reference: {
        kind: "workspace",
        uri: ".dev-flow/328/03-verify-result-pass-1.json",
        sha256: `sha256:${"c".repeat(64)}`,
        byteLength: 1024,
      },
    });
    const evidence = RunGraphEvidenceSubmissionSchema.parse({
      id: "evidence-command",
      kind: "command_execution",
      artifactIds: [artifact.id],
      provenance: "local-runner",
      reference: artifact.reference,
    });

    const input = RunGraphRunnerCommandInputSchema.parse({
      schemaVersion: "1",
      eventId: "runner-event-outcome",
      runId: "run-1",
      actor,
      command: commands[2],
      artifacts: [artifact],
      evidence: [evidence],
    });
    expect(input.artifacts?.[0]?.schemaId).toBe("dev-role.verify");
    expect(input.evidence?.[0]?.kind).toBe("command_execution");
    expect(() =>
      RunGraphArtifactSubmissionSchema.parse({ ...artifact, content: "secret" }),
    ).toThrow();
  });
});

describe("[NFR-STABILITY-014-AC1] Run Graph start は Work Graph と contract binding を accepted event に固定する", () => {
  it("caller input と control plane が生成した run/node ID を分離する", () => {
    const start = RunGraphStartInputSchema.parse({
      schemaVersion: "1",
      eventId: "start-328",
      actor: { id: "orchestrator-1", role: "orchestrator" },
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    });
    const accepted = RunGraphAcceptedEventSchema.parse({
      recordType: "accepted",
      eventId: start.eventId,
      sequence: 1,
      runId: "run-328",
      acceptedAt: "2026-07-30T00:00:00.000Z",
      actor: start.actor,
      command: {
        type: "run_started",
        task: start.task,
        contract: start.contract,
        firstNodeId: "node-planner-1",
      },
      artifactIds: [],
      evidenceIds: [],
    });

    expect(accepted.command.type).toBe("run_started");
    expect(accepted.runId).toBe("run-328");
  });
});

describe("[NFR-STABILITY-014-AC2] [NFR-STABILITY-014-AC4] replay projection と bounded view を検証する", () => {
  const actor = { id: "actor-1", role: "implementer" } as const;
  const timestamp = "2026-07-30T00:00:00.000Z";
  const reference = {
    kind: "workspace",
    uri: ".dev-flow/328/artifact.json",
    sha256: `sha256:${"b".repeat(64)}`,
    byteLength: 256,
  } as const;
  const run = {
    id: "run-1",
    state: "running",
    task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
    contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
    actor,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentNodeId: "node-1",
    parentRunId: null,
    inputArtifactIds: [],
    outputArtifactIds: [],
  } as const;
  const node = {
    id: "node-1",
    runId: "run-1",
    contractNodeId: "implementer",
    state: "running",
    actor,
    createdAt: timestamp,
    updatedAt: timestamp,
    activeAttemptId: "attempt-1",
    previousNodeId: null,
    inputArtifactIds: [],
    outputArtifactIds: ["artifact-1"],
  } as const;
  const attempt = {
    id: "attempt-1",
    runId: "run-1",
    nodeId: "node-1",
    ordinal: 1,
    state: "running",
    actor,
    createdAt: timestamp,
    updatedAt: timestamp,
    previousAttemptId: null,
    inputArtifactIds: [],
    outputArtifactIds: ["artifact-1"],
  } as const;
  const artifact = {
    id: "artifact-1",
    runId: "run-1",
    nodeId: "node-1",
    producerAttemptId: "attempt-1",
    schemaId: "dev-role.implementation",
    schemaVersion: "1",
    actor,
    createdAt: timestamp,
    derivedFromArtifactIds: [],
    reference,
  } as const;
  const evidence = {
    id: "evidence-1",
    runId: "run-1",
    nodeId: "node-1",
    producerAttemptId: "attempt-1",
    kind: "command_execution",
    actor,
    createdAt: timestamp,
    artifactIds: ["artifact-1"],
    provenance: "local-runner",
    reference,
  } as const;

  it("event replay から導出した entity projection を検証する", () => {
    const projection = RunGraphProjectionSchema.parse({
      schemaVersion: "1",
      revision: 3,
      run,
      nodes: [node],
      attempts: [attempt],
      artifacts: [artifact],
      evidence: [evidence],
      budgets: { executorRetries: 0, improvementIterations: 0 },
    });

    expect(projection.run.currentNodeId).toBe("node-1");
    expect(projection.attempts[0]?.id).toBe("attempt-1");
    expect(() => RunGraphProjectionSchema.parse({ ...projection, nodes: [node, node] })).toThrow(
      /一意/,
    );
  });

  it("default view は artifact/evidence 件数と切り詰めを明示する", () => {
    const view = RunGraphViewSchema.parse({
      schemaVersion: "1",
      runId: "run-1",
      task: { owner: "stanah", repo: "gh-gantt", issueNumber: 328 },
      contract: { planId: "dev-role-fixed", planVersion: "1", schemaVersion: "1" },
      revision: 3,
      state: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      currentNode: node,
      activeAttempt: attempt,
      waitReason: null,
      budgets: { executorRetries: 0, improvementIterations: 0 },
      allowedNextTransitions: ["attempt_finished"],
      nodes: { total: 2, limit: 1, truncated: true, items: [node] },
      attempts: { total: 2, limit: 1, truncated: true, items: [attempt] },
      artifacts: { total: 2, limit: 1, truncated: true, items: [artifact] },
      evidence: { total: 2, limit: 1, truncated: true, items: [evidence] },
      claimAudits: { total: 0, limit: 1, truncated: false, items: [] },
    });

    expect(view.nodes).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(view.attempts).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(view.artifacts).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(view.task).toEqual({ owner: "stanah", repo: "gh-gantt", issueNumber: 328 });
    expect(view.contract).toEqual({
      planId: "dev-role-fixed",
      planVersion: "1",
      schemaVersion: "1",
    });
    expect(() =>
      RunGraphViewSchema.parse({
        ...view,
        artifacts: { total: 2, limit: 1, truncated: false, items: [artifact, artifact] },
      }),
    ).toThrow(/limit/);
  });
});
