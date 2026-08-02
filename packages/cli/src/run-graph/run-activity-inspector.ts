import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import {
  canonicalJsonStringify,
  type MutationOrigin,
  type MutationProposal,
  type RunGraphAttemptState,
  type RunGraphNodeState,
  type RunGraphRunState,
} from "@gh-gantt/shared";
import { DispatchClaimStore, type DispatchClaimSnapshot } from "../store/dispatch-claims.js";
import {
  resolveRepositoryCoordinationLayout,
  type RepositoryCoordinationLayout,
} from "../store/repository-coordination-layout.js";
import { RunGraphEventStore } from "../store/run-graph.js";
import { RunGraphControlPlane } from "./control-plane.js";

export interface RunActivitySummary {
  workspaceId: string;
  projectRoot: string;
  runId: string;
  taskId: string;
  revision: number;
  state: RunGraphRunState;
  currentNodeId: string | null;
  currentNodeState: RunGraphNodeState | null;
  activeAttemptId: string | null;
  activeAttemptState: RunGraphAttemptState | null;
  planId: string;
  planVersion: string;
  schemaVersion: string;
  checkpointEventId: string;
}

export interface RunActivityCoverageProof {
  schemaVersion: "1";
  enumeratedAt: string;
  completedAt: string;
  claimEntityVersion: number;
  projectIdentity: string;
  projectRoots: string[];
  workspaces: Array<{ projectRoot: string; workspaceId: string }>;
  nonterminalRuns: RunActivitySummary[];
  coverageFingerprint: string;
}

export type RunActivityInspection =
  | { ok: true; proof: RunActivityCoverageProof; claimSnapshot: DispatchClaimSnapshot }
  | { ok: false; code: "run_state_unknown"; diagnostic: string };

interface RunActivityInspectorDependencies {
  now: () => string;
  resolveLayout: (projectRoot: string) => Promise<RepositoryCoordinationLayout>;
  readClaimSnapshot: (projectRoot: string) => Promise<DispatchClaimSnapshot>;
  listRunIds: (projectRoot: string) => Promise<string[]>;
  inspectRun: (projectRoot: string, runId: string) => Promise<RunActivitySummary>;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function workspaceId(projectRoot: string): string {
  return `workspace:${fingerprint(projectRoot)}`;
}

function isTerminalRun(state: RunGraphRunState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function hasNestedOrDuplicatePaths(paths: string[]): boolean {
  const sorted = [...paths].sort();
  if (new Set(sorted).size !== sorted.length) return true;
  return sorted.some((candidate, index) =>
    sorted.some(
      (other, otherIndex) => index !== otherIndex && candidate.startsWith(`${other}${sep}`),
    ),
  );
}

function taskIdFromRun(task: { owner: string; repo: string; issueNumber: number }): string {
  return `${task.owner.toLowerCase()}/${task.repo.toLowerCase()}#${task.issueNumber}`;
}

function defaultDependencies(): RunActivityInspectorDependencies {
  return {
    now: () => new Date().toISOString(),
    resolveLayout: resolveRepositoryCoordinationLayout,
    readClaimSnapshot: (projectRoot) => new DispatchClaimStore(projectRoot).snapshot(),
    listRunIds: (projectRoot) => new RunGraphEventStore(projectRoot).listRunIds(),
    inspectRun: async (projectRoot, runId) => {
      const [view, journal] = await Promise.all([
        new RunGraphControlPlane(projectRoot).inspect(runId, 1),
        new RunGraphEventStore(projectRoot).readJournal(runId),
      ]);
      const checkpoint = journal.acceptedEvents.at(-1);
      if (!checkpoint) throw new Error(`Run Graph journalが空です: ${runId}`);
      return {
        workspaceId: workspaceId(await realpath(projectRoot)),
        projectRoot: await realpath(projectRoot),
        runId,
        taskId: taskIdFromRun(view.task),
        revision: view.revision,
        state: view.state,
        currentNodeId: view.currentNode?.id ?? null,
        currentNodeState: view.currentNode?.state ?? null,
        activeAttemptId: view.activeAttempt?.id ?? null,
        activeAttemptState: view.activeAttempt?.state ?? null,
        planId: view.contract.planId,
        planVersion: view.contract.planVersion,
        schemaVersion: view.contract.schemaVersion,
        checkpointEventId: checkpoint.eventId,
      };
    },
  };
}

/** 全linked worktreeの型付きRun Graphとrepository claimを完全列挙するfail-closed inspector。 */
export class RunActivityInspector {
  private readonly dependencies: RunActivityInspectorDependencies;

  constructor(
    private readonly projectRoot: string,
    overrides: Partial<RunActivityInspectorDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies(), ...overrides };
  }

  async inspectComplete(): Promise<RunActivityInspection> {
    const startedAt = this.dependencies.now();
    try {
      const initialLayout = await this.dependencies.resolveLayout(this.projectRoot);
      const projectRoots = await Promise.all(
        initialLayout.linkedProjectRoots.map((path) => realpath(path)),
      );
      if (hasNestedOrDuplicatePaths(projectRoots)) {
        return {
          ok: false,
          code: "run_state_unknown",
          diagnostic: "linked worktreeにnestedまたはduplicate canonical project rootがあります",
        };
      }
      const claimBefore = await this.dependencies.readClaimSnapshot(this.projectRoot);
      const scanRuns = async (roots: string[]) =>
        (
          await Promise.all(
            roots.map(async (root) => {
              const runIds = await this.dependencies.listRunIds(root);
              if (new Set(runIds).size !== runIds.length) {
                throw new Error(`Run Graph locatorにduplicate run IDがあります: ${root}`);
              }
              return Promise.all(runIds.map((runId) => this.dependencies.inspectRun(root, runId)));
            }),
          )
        ).flat();
      const summaries = await scanRuns(projectRoots);
      const duplicateRunIds = summaries.filter(
        (summary, index) => summaries.findIndex((item) => item.runId === summary.runId) !== index,
      );
      if (duplicateRunIds.length > 0) {
        throw new Error(`複数workspaceに同じRun IDがあります: ${duplicateRunIds[0]!.runId}`);
      }
      const [finalLayout, claimAfter, finalSummaries] = await Promise.all([
        this.dependencies.resolveLayout(this.projectRoot),
        this.dependencies.readClaimSnapshot(this.projectRoot),
        scanRuns(projectRoots),
      ]);
      const finalRoots = await Promise.all(
        finalLayout.linkedProjectRoots.map((path) => realpath(path)),
      );
      if (
        canonicalJsonStringify(projectRoots) !== canonicalJsonStringify(finalRoots) ||
        canonicalJsonStringify(
          summaries.map((item) => ({
            workspaceId: item.workspaceId,
            runId: item.runId,
            revision: item.revision,
            checkpointEventId: item.checkpointEventId,
            activeAttemptId: item.activeAttemptId,
            activeAttemptState: item.activeAttemptState,
          })),
        ) !==
          canonicalJsonStringify(
            finalSummaries.map((item) => ({
              workspaceId: item.workspaceId,
              runId: item.runId,
              revision: item.revision,
              checkpointEventId: item.checkpointEventId,
              activeAttemptId: item.activeAttemptId,
              activeAttemptState: item.activeAttemptState,
            })),
          ) ||
        claimBefore.entityVersion !== claimAfter.entityVersion ||
        claimBefore.projectIdentity !== initialLayout.projectIdentity ||
        finalLayout.projectIdentity !== initialLayout.projectIdentity
      ) {
        return {
          ok: false,
          code: "run_state_unknown",
          diagnostic: "coverage scan中にworktree列挙またはclaim revisionが変化しました",
        };
      }
      const nonterminalRuns = finalSummaries
        .filter((summary) => !isTerminalRun(summary.state))
        .sort(
          (left, right) =>
            left.workspaceId.localeCompare(right.workspaceId) ||
            left.runId.localeCompare(right.runId),
        );
      const completedAt = this.dependencies.now();
      const proofBody = {
        schemaVersion: "1" as const,
        enumeratedAt: startedAt,
        completedAt,
        claimEntityVersion: claimAfter.entityVersion,
        projectIdentity: initialLayout.projectIdentity,
        projectRoots,
        workspaces: projectRoots.map((root) => ({
          projectRoot: root,
          workspaceId: workspaceId(root),
        })),
        nonterminalRuns,
      };
      return {
        ok: true,
        claimSnapshot: claimAfter,
        proof: { ...proofBody, coverageFingerprint: fingerprint(proofBody) },
      };
    } catch (error) {
      return {
        ok: false,
        code: "run_state_unknown",
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resolveOrigin(
    runId: string,
  ): Promise<
    | { ok: true; origin: MutationOrigin; coverageFingerprint: string }
    | { ok: false; code: "origin_binding_drift" | "run_state_unknown"; diagnostic: string }
  > {
    const inspection = await this.inspectComplete();
    if (!inspection.ok) return inspection;
    const currentLayout = await this.dependencies.resolveLayout(this.projectRoot);
    const matches = inspection.proof.nonterminalRuns.filter((summary) => summary.runId === runId);
    if (matches.length !== 1) {
      return {
        ok: false,
        code: "origin_binding_drift",
        diagnostic: "origin Runがcanonical workspaceに一意に存在しません",
      };
    }
    const summary = matches[0]!;
    if (
      summary.workspaceId !== currentLayout.canonicalWorkspaceId ||
      (summary.state !== "paused" && summary.state !== "waiting_human") ||
      summary.activeAttemptId !== null ||
      inspection.claimSnapshot.claims.some((claim) => claim.runId === runId) ||
      inspection.claimSnapshot.pendingAuthorizations.length > 0
    ) {
      return {
        ok: false,
        code: "origin_binding_drift",
        diagnostic: "origin Runはreleased claimかつpaused/waiting_human checkpointではありません",
      };
    }
    return {
      ok: true,
      coverageFingerprint: inspection.proof.coverageFingerprint,
      origin: {
        runId,
        workspaceId: summary.workspaceId,
        taskId: summary.taskId,
        repository: summary.taskId.split("#")[0]!,
        planId: summary.planId,
        planVersion: summary.planVersion,
        authorityId: `run-checkpoint:${summary.checkpointEventId}`,
        mutationCheckpointId: summary.checkpointEventId,
      },
    };
  }

  async validateApply(proposal: MutationProposal): Promise<
    | {
        ok: true;
        coverageFingerprint: string;
        claimEntityVersion: number;
        affectedRuns: Array<{
          workspaceId: string;
          projectRoot: string;
          runId: string;
          taskId: string;
          planId: string;
          planVersion: string;
          schemaVersion: string;
          currentNodeId: string;
          successorPlanRevision: {
            planId: string;
            fromVersion: string;
            proposedVersion: string;
            reasonProposalId: string;
          };
        }>;
      }
    | {
        ok: false;
        code:
          | "origin_binding_drift"
          | "active_claim"
          | "unfinished_run"
          | "run_state_unknown"
          | "active_attempt_conflict";
        diagnostic: string;
      }
  > {
    const inspection = await this.inspectComplete();
    if (!inspection.ok) return inspection;
    const targets = new Set(
      proposal.targetTaskIds.filter((id) => !id.includes("#draft-mutation-")),
    );
    const affected = new Set([
      proposal.origin.taskId,
      ...targets,
      ...(proposal.affectedDownstream ?? []).filter((id) => !id.includes("#draft-mutation-")),
    ]);
    const activeClaim = inspection.claimSnapshot.claims.find((claim) => affected.has(claim.taskId));
    if (activeClaim) {
      return {
        ok: false,
        code: "active_claim",
        diagnostic: `active claimがあります: ${activeClaim.taskId}`,
      };
    }
    if (inspection.claimSnapshot.pendingAuthorizations.length > 0) {
      return {
        ok: false,
        code: "active_claim",
        diagnostic: "pending claim authorizationがあります",
      };
    }
    const affectedRuns = inspection.proof.nonterminalRuns.filter((run) => affected.has(run.taskId));
    const activeAttempt = affectedRuns.find(
      (run) => run.activeAttemptState === "created" || run.activeAttemptState === "running",
    );
    if (activeAttempt) {
      return {
        ok: false,
        code: "active_attempt_conflict",
        diagnostic: `affected Runにactive Attemptがあります: ${activeAttempt.runId}`,
      };
    }
    const competing = affectedRuns.find(
      (run) => targets.has(run.taskId) && run.runId !== proposal.origin.runId,
    );
    if (competing) {
      return {
        ok: false,
        code: "unfinished_run",
        diagnostic: `別のunfinished Runがあります: ${competing.runId}`,
      };
    }
    const origin = affectedRuns.find((run) => run.runId === proposal.origin.runId);
    if (
      !origin ||
      origin.workspaceId !== proposal.origin.workspaceId ||
      origin.taskId !== proposal.origin.taskId ||
      origin.planId !== proposal.origin.planId ||
      origin.planVersion !== proposal.origin.planVersion ||
      origin.checkpointEventId !== proposal.origin.mutationCheckpointId
    ) {
      return {
        ok: false,
        code: "origin_binding_drift",
        diagnostic: "origin Run bindingがproposalと一致しません",
      };
    }
    if (origin.activeAttemptState === "created" || origin.activeAttemptState === "running") {
      return {
        ok: false,
        code: "active_attempt_conflict",
        diagnostic: "origin Runにactive Attemptがあります",
      };
    }
    if (
      (origin.state !== "paused" && origin.state !== "waiting_human") ||
      origin.activeAttemptId !== null
    ) {
      return {
        ok: false,
        code: "origin_binding_drift",
        diagnostic: "origin mutation checkpointが失効しました",
      };
    }
    return {
      ok: true,
      coverageFingerprint: inspection.proof.coverageFingerprint,
      claimEntityVersion: inspection.proof.claimEntityVersion,
      affectedRuns: affectedRuns.map((run) => ({
        workspaceId: run.workspaceId,
        projectRoot: run.projectRoot,
        runId: run.runId,
        taskId: run.taskId,
        planId: run.planId,
        planVersion: run.planVersion,
        schemaVersion: run.schemaVersion,
        currentNodeId: run.currentNodeId!,
        successorPlanRevision: {
          planId: run.planId,
          fromVersion: run.planVersion,
          proposedVersion: `${run.planVersion}+proposal.${proposal.proposalId}`,
          reasonProposalId: proposal.proposalId,
        },
      })),
    };
  }
}
