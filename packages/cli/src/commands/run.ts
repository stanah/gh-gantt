import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildDispatchPlan,
  DispatchGateSnapshotSchema,
  DispatchClaimProofSchema,
  DispatchPlanSchema,
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  RunGraphRunnerCommandInputSchema,
  type RunGraphRunnerCommandInput,
  type RunGraphView,
} from "@gh-gantt/shared";
import { Command } from "commander";
import { z } from "zod";
import {
  fetchRunGraphPrObservation as fetchRunGraphPrObservationDefault,
  type RunGraphPrObservation,
} from "../loop/pr-evidence.js";
import { RunGraphControlPlane, type RunGraphCommandResult } from "../run-graph/control-plane.js";
import { GraphContractStore } from "../store/graph-contract.js";
import { withProjectStorage } from "../store/project-storage.js";
import { DispatchClaimStore } from "../store/dispatch-claims.js";

const SIDE_EFFECT_STATES = ["not_started", "committed", "reconciled", "unknown"] as const;
const HUMAN_DECISIONS = ["approved", "rejected", "override"] as const;

class RunCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

async function readGateSnapshot(projectRoot: string, path: string) {
  const snapshot = DispatchGateSnapshotSchema.parse(
    JSON.parse(await readFile(resolve(projectRoot, path), "utf8")),
  );
  return { snapshot, fingerprint: canonicalFingerprint(snapshot) };
}

function dispatchSnapshotLineage(
  state: { config: unknown; tasks: unknown; loop: unknown },
  gate: { snapshot: { sourceRevision: string }; fingerprint: string },
) {
  const tasks = state.tasks as { tasks?: unknown; has_conflicts?: boolean };
  const workGraphFingerprint = canonicalFingerprint({
    config: state.config,
    tasks: tasks.tasks,
    hasConflicts: tasks.has_conflicts ?? false,
    loop: state.loop,
  });
  return {
    workGraphFingerprint,
    gateSnapshotFingerprint: gate.fingerprint,
    gateSnapshotSourceRevision: gate.snapshot.sourceRevision,
    snapshotFingerprint: canonicalFingerprint({
      workGraphFingerprint,
      gateSnapshotFingerprint: gate.fingerprint,
      gateSnapshotSourceRevision: gate.snapshot.sourceRevision,
    }),
  };
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RunCommandError("invalid_input", `${option} は正の整数で指定してください`);
  }
  return parsed;
}

function parseNonnegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RunCommandError("invalid_input", `${option} は0以上の整数で指定してください`);
  }
  return parsed;
}

function parseRequiredText(value: string, option: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new RunCommandError("invalid_input", `${option} は空にできません`);
  }
  return parsed;
}

function parseSideEffectState(value: string): (typeof SIDE_EFFECT_STATES)[number] {
  if (!(SIDE_EFFECT_STATES as readonly string[]).includes(value)) {
    throw new RunCommandError(
      "invalid_input",
      `--side-effect-state は ${SIDE_EFFECT_STATES.join(" | ")} のいずれかで指定してください`,
    );
  }
  return value as (typeof SIDE_EFFECT_STATES)[number];
}

function parseHumanDecision(value: string): (typeof HUMAN_DECISIONS)[number] {
  if (!(HUMAN_DECISIONS as readonly string[]).includes(value)) {
    throw new RunCommandError(
      "invalid_input",
      `--decision は ${HUMAN_DECISIONS.join(" | ")} のいずれかで指定してください`,
    );
  }
  return value as (typeof HUMAN_DECISIONS)[number];
}

function boundedReference(kind: "command" | "github", uri: string, canonicalJson: string) {
  return {
    kind,
    uri,
    sha256: `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`,
    byteLength: Buffer.byteLength(canonicalJson, "utf8"),
  };
}

function parseRepository(value: string): { owner: string; repo: string } {
  const matched = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!matched) {
    throw new RunCommandError("invalid_input", "--repository は owner/repo 形式で指定してください");
  }
  return { owner: matched[1], repo: matched[2] };
}

export interface RunCommandDependencies {
  fetchRunGraphPrObservation?: (params: {
    target: {
      owner: string;
      repo: string;
      number: number;
      crossRepo: boolean;
    };
    expectedIssue: { owner: string; repo: string; issueNumber: number };
  }) => Promise<RunGraphPrObservation>;
}

function formatReferenceLine(id: string, label: string, uri: string): string {
  return `  - ${id} ${label} ${uri}`;
}

/** default human view は本文を展開せず、bounded reference の要約だけを表示する。 */
export function formatRunGraphView(view: RunGraphView): string {
  const node = view.currentNode
    ? `${view.currentNode.contractNodeId} (${view.currentNode.state}, ${view.currentNode.id})`
    : "none";
  const attempt = view.activeAttempt
    ? `${view.activeAttempt.id} (${view.activeAttempt.state})`
    : "none";
  const transitions =
    view.allowedNextTransitions.length > 0 ? view.allowedNextTransitions.join(", ") : "none";
  const lines = [
    `Run ${view.runId} [${view.state}] revision=${view.revision}`,
    `task: ${view.task.owner}/${view.task.repo}#${view.task.issueNumber}`,
    `current node: ${node}`,
    `wait: ${view.waitReason ?? "none"}`,
    `attempt: ${attempt}`,
    `budgets: executorRetries=${view.budgets.executorRetries}, improvementIterations=${view.budgets.improvementIterations}`,
    `transitions: ${transitions}`,
    `artifacts: ${view.artifacts.items.length}/${view.artifacts.total} (limit=${view.artifacts.limit}, truncated=${view.artifacts.truncated})`,
    ...view.artifacts.items.map((artifact) =>
      formatReferenceLine(
        artifact.id,
        `${artifact.schemaId}@${artifact.schemaVersion}`,
        artifact.reference.uri,
      ),
    ),
    `evidence: ${view.evidence.items.length}/${view.evidence.total} (limit=${view.evidence.limit}, truncated=${view.evidence.truncated})`,
    ...view.evidence.items.map((item) =>
      formatReferenceLine(item.id, item.kind, item.reference.uri),
    ),
    `claim audits: ${view.claimAudits.items.length}/${view.claimAudits.total} (limit=${view.claimAudits.limit}, truncated=${view.claimAudits.truncated})`,
    ...view.claimAudits.items.map(
      (audit) =>
        `  - ${audit.command.type} ${audit.command.claim.taskId} owner=${audit.command.claim.ownerId} run=${audit.command.claim.runId} fencing=${audit.command.claim.fencingToken}${audit.command.reclaimReason ? ` reason=${audit.command.reclaimReason}` : ""}`,
    ),
  ];
  return lines.join("\n");
}

function outputResult(
  result: RunGraphCommandResult,
  json: boolean | undefined,
  label: string,
): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.accepted) {
    console.log(formatRunGraphView(result.view));
  } else {
    console.error(`${label} rejected [${result.code}]: ${result.message}`);
    if (result.view) console.log(formatRunGraphView(result.view));
  }
  if (!result.accepted) process.exitCode = 1;
}

function outputError(error: unknown, json: boolean | undefined): void {
  const code = error instanceof RunCommandError ? error.code : "run_command_failed";
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ accepted: false, code, message }, null, 2));
  } else {
    console.error(`Run command failed [${code}]: ${message}`);
  }
  process.exitCode = 1;
}

function outputJsonFirst(result: unknown, json?: boolean): void {
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result));
  if (
    typeof result === "object" &&
    result !== null &&
    "accepted" in result &&
    result.accepted === false
  ) {
    process.exitCode = 1;
  }
}

function isNotGitRepositoryError(error: unknown): boolean {
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  return stderr.includes("not a git repository") || stderr.includes("not a git work tree");
}

async function reconcileClaimAudit(
  projectRoot: string,
  actorId: string,
  receipt:
    | Awaited<ReturnType<DispatchClaimStore["claim"]>>
    | Awaited<ReturnType<DispatchClaimStore["heartbeat"]>>,
): Promise<unknown> {
  if (!receipt.accepted || !receipt.claim) return receipt;
  try {
    const audit = await new RunGraphControlPlane(projectRoot).recordClaimAudit({
      schemaVersion: "1",
      eventId: `audit:${receipt.eventId}`,
      actor: { id: actorId, role: "orchestrator" },
      receipt: { ...receipt, claim: receipt.claim },
    });
    return { ...receipt, audit: { recorded: audit.accepted, result: audit } };
  } catch (error) {
    return {
      ...receipt,
      audit: {
        recorded: false,
        pending: true,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function startRun(
  projectRoot: string,
  options: { issue: string; eventId: string; actor: string },
): Promise<RunGraphCommandResult> {
  return withProjectStorage(
    projectRoot,
    { mode: "read", scope: "shared-cache" },
    async ({ configStore, tasksStore }) => {
      const issueNumber = parsePositiveInteger(options.issue, "--issue");
      const eventId = parseRequiredText(options.eventId, "--event-id");
      const actorId = parseRequiredText(options.actor, "--actor");
      const config = await configStore.read();
      const binding = config.run_graph;
      if (!binding) {
        throw new RunCommandError(
          "unsupported_contract_binding",
          "repository config に run_graph binding がありません",
        );
      }
      const expected = {
        plan_id: FIXED_DEV_ROLE_GRAPH_CONTRACT.planId,
        plan_version: FIXED_DEV_ROLE_GRAPH_CONTRACT.planVersion,
        schema_version: FIXED_DEV_ROLE_GRAPH_CONTRACT.schemaVersion,
      };
      if (
        binding.plan_id !== expected.plan_id ||
        binding.plan_version !== expected.plan_version ||
        binding.schema_version !== expected.schema_version
      ) {
        throw new RunCommandError(
          "unsupported_contract_binding",
          "repository config は fixed dev-role Graph Contract と exact binding していません",
        );
      }

      const tasks = await tasksStore.read();
      const repository = `${config.project.github.owner}/${config.project.github.repo}`;
      const task = tasks.tasks.find(
        (candidate) =>
          candidate.github_issue === issueNumber &&
          candidate.github_repo.toLowerCase() === repository.toLowerCase(),
      );
      if (!task) {
        throw new RunCommandError(
          "issue_not_found",
          `repository の同期済み task に Issue #${issueNumber} がありません`,
        );
      }
      if (task.state !== "open") {
        throw new RunCommandError("issue_not_open", `Issue #${issueNumber} は OPEN ではありません`);
      }

      await new GraphContractStore(projectRoot).install(FIXED_DEV_ROLE_GRAPH_CONTRACT);
      return new RunGraphControlPlane(projectRoot).start({
        schemaVersion: "1",
        eventId,
        actor: { id: actorId, role: "orchestrator" },
        task: {
          owner: config.project.github.owner,
          repo: config.project.github.repo,
          issueNumber,
        },
        contract: {
          planId: binding.plan_id,
          planVersion: binding.plan_version,
          schemaVersion: binding.schema_version,
        },
      });
    },
  );
}

export function createRunCommand(dependencies: RunCommandDependencies = {}): Command {
  const fetchRunGraphPrObservation =
    dependencies.fetchRunGraphPrObservation ?? fetchRunGraphPrObservationDefault;
  const command = new Command("run").description("Durable Run Graph を操作する");

  command.addCommand(
    new Command("dispatch")
      .description("Work Graph snapshot から bounded ready frontier を導出する")
      .requiredOption("--workspace-map <path>", "task ID から isolated workspace ID への JSON map")
      .requiredOption(
        "--gate-snapshot <path>",
        "authoritative review/human gate snapshot JSON file",
      )
      .option("--json", "JSON 形式で出力")
      .action(async (options: { workspaceMap: string; gateSnapshot: string; json?: boolean }) => {
        try {
          const projectRoot = process.cwd();
          const result = await withProjectStorage(
            projectRoot,
            { mode: "read", scope: "all" },
            async ({ configStore, tasksStore, loopStore }) => {
              const state = {
                config: await configStore.read(),
                tasks: await tasksStore.read(),
                loop: await loopStore.readOrNull(),
              };
              const gate = await readGateSnapshot(projectRoot, options.gateSnapshot);
              const lineage = dispatchSnapshotLineage(state, gate);
              const workspaceByTaskId = z
                .record(z.string().trim().min(1), z.string().trim().min(1))
                .parse(
                  JSON.parse(await readFile(resolve(projectRoot, options.workspaceMap), "utf8")),
                );
              const registry = await new DispatchClaimStore(projectRoot).snapshot();
              const openIteration = [...(state.loop?.iterations ?? [])]
                .reverse()
                .find((iteration) => iteration.outcome === undefined);
              return buildDispatchPlan({
                tasks: state.tasks.tasks,
                config: state.config,
                now: new Date().toISOString(),
                syncConflictTaskIds: state.tasks.has_conflicts
                  ? state.tasks.tasks.map((task) => task.id)
                  : [],
                openIterationTaskIds: openIteration?.selectedTask
                  ? [openIteration.selectedTask]
                  : [],
                reviewGateTaskIds: gate.snapshot.reviewGateTaskIds,
                humanGateTaskIds: gate.snapshot.humanGateTaskIds,
                claims: registry.claims,
                registryEntityVersion: registry.entityVersion,
                ...lineage,
                workspaceByTaskId,
              });
            },
          );
          outputJsonFirst(result, options.json);
        } catch (error) {
          outputError(error, options.json);
        }
      }),
  );

  command.addCommand(
    new Command("claim")
      .description("ready task と isolated workspace を期限付きで claim する")
      .requiredOption("--event-id <id>", "冪等 caller event ID")
      .requiredOption("--expected-version <number>", "registry entityVersion")
      .requiredOption("--task <id>", "Work Graph task ID")
      .requiredOption("--repository <owner/repo>", "task repository")
      .requiredOption("--state <status>", "task status")
      .requiredOption("--owner <id>", "stable owner ID")
      .requiredOption("--workspace <id>", "isolated workspace ID")
      .requiredOption("--run <id>", "workspace-local Run Graph ID")
      .requiredOption("--plan-file <path>", "run dispatch JSON plan file")
      .requiredOption(
        "--gate-snapshot <path>",
        "claim直前の authoritative review/human gate snapshot JSON file",
      )
      .requiredOption("--actor <id>", "audit reconciliation の orchestrator actor ID")
      .option("--lease-seconds <seconds>", "lease duration", "300")
      .option("--json", "JSON 形式で出力")
      .action(
        async (options: {
          eventId: string;
          expectedVersion: string;
          task: string;
          repository: string;
          state: string;
          owner: string;
          workspace: string;
          run: string;
          planFile: string;
          gateSnapshot: string;
          actor: string;
          leaseSeconds: string;
          json?: boolean;
        }) => {
          try {
            const projectRoot = process.cwd();
            const plan = DispatchPlanSchema.parse(
              JSON.parse(await readFile(resolve(projectRoot, options.planFile), "utf8")),
            );
            const expectedEntityVersion = parseNonnegativeInteger(
              options.expectedVersion,
              "--expected-version",
            );
            if (plan.registryEntityVersion !== expectedEntityVersion) {
              throw new RunCommandError(
                "stale_entity_version",
                "dispatch plan の registry entityVersion が claim と一致しません",
              );
            }
            const result = await withProjectStorage(
              projectRoot,
              { mode: "read", scope: "all" },
              async ({ configStore, tasksStore, loopStore }) => {
                const state = {
                  config: await configStore.read(),
                  tasks: await tasksStore.read(),
                  loop: await loopStore.readOrNull(),
                };
                const gate = await readGateSnapshot(projectRoot, options.gateSnapshot);
                const lineage = dispatchSnapshotLineage(state, gate);
                const registryStore = new DispatchClaimStore(projectRoot);
                const registry = await registryStore.snapshot();
                const openIteration = [...(state.loop?.iterations ?? [])]
                  .reverse()
                  .find((iteration) => iteration.outcome === undefined);
                const currentPlan = buildDispatchPlan({
                  tasks: state.tasks.tasks,
                  config: state.config,
                  now: new Date().toISOString(),
                  syncConflictTaskIds: state.tasks.has_conflicts
                    ? state.tasks.tasks.map((task) => task.id)
                    : [],
                  openIterationTaskIds: openIteration?.selectedTask
                    ? [openIteration.selectedTask]
                    : [],
                  reviewGateTaskIds: gate.snapshot.reviewGateTaskIds,
                  humanGateTaskIds: gate.snapshot.humanGateTaskIds,
                  claims: registry.claims,
                  registryEntityVersion: registry.entityVersion,
                  ...lineage,
                  workspaceByTaskId: plan.context.workspaceByTaskId,
                });
                if (currentPlan.planId !== plan.planId) {
                  throw new RunCommandError(
                    "stale_entity_version",
                    "dispatch plan は current Work Graph/gate/claim snapshot と一致しません",
                  );
                }
                const selected = currentPlan.selected.find((item) => item.taskId === options.task);
                if (
                  !selected ||
                  selected.workspaceId !== options.workspace ||
                  selected.repository !== options.repository.toLowerCase() ||
                  selected.state !== options.state
                ) {
                  throw new RunCommandError(
                    "invalid_input",
                    "task/repository/state/workspace は current dispatch frontier にありません",
                  );
                }
                const run = await new RunGraphControlPlane(projectRoot).inspect(options.run);
                const runTaskId =
                  `${run.task.owner}/${run.task.repo}#${run.task.issueNumber}`.toLowerCase();
                if (runTaskId !== options.task.toLowerCase()) {
                  throw new RunCommandError(
                    "invalid_input",
                    "Run Graph task と claim task が一致しません",
                  );
                }
                if (run.state === "waiting_human" || run.waitReason !== null) {
                  throw new RunCommandError(
                    "invalid_input",
                    "Run Graph が human gate で停止している task は claim できません",
                  );
                }
                const receipt = await registryStore.claim(
                  {
                    schemaVersion: "1",
                    eventId: parseRequiredText(options.eventId, "--event-id"),
                    expectedEntityVersion,
                    taskId: parseRequiredText(options.task, "--task"),
                    repository: parseRequiredText(options.repository, "--repository"),
                    state: parseRequiredText(options.state, "--state"),
                    ownerId: parseRequiredText(options.owner, "--owner"),
                    workspaceId: parseRequiredText(options.workspace, "--workspace"),
                    runId: parseRequiredText(options.run, "--run"),
                    leaseDurationSeconds: parsePositiveInteger(
                      options.leaseSeconds,
                      "--lease-seconds",
                    ),
                    dispatchPlanId: plan.planId,
                    dispatchPlanVersion: plan.planVersion,
                    snapshotFingerprint: lineage.snapshotFingerprint,
                  },
                  async () =>
                    dispatchSnapshotLineage(
                      state,
                      await readGateSnapshot(projectRoot, options.gateSnapshot),
                    ).snapshotFingerprint,
                );
                return reconcileClaimAudit(projectRoot, options.actor, receipt);
              },
            );
            outputJsonFirst(await result, options.json);
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  const proofOptions = (subcommand: Command): Command =>
    subcommand
      .requiredOption("--event-id <id>", "冪等 caller event ID")
      .requiredOption("--expected-version <number>", "registry entityVersion")
      .requiredOption("--claim <id>", "claim ID")
      .requiredOption("--fencing-token <number>", "current fencing token")
      .requiredOption("--owner <id>", "stable owner ID")
      .requiredOption("--run <id>", "Run Graph ID")
      .requiredOption("--actor <id>", "audit reconciliation の orchestrator actor ID")
      .option("--json", "JSON 形式で出力");

  command.addCommand(
    proofOptions(new Command("heartbeat").description("current claim lease を延長する"))
      .option("--lease-seconds <seconds>", "lease duration", "300")
      .action(
        async (options: {
          eventId: string;
          expectedVersion: string;
          claim: string;
          fencingToken: string;
          owner: string;
          run: string;
          actor: string;
          leaseSeconds: string;
          json?: boolean;
        }) => {
          try {
            const projectRoot = process.cwd();
            const receipt = await new DispatchClaimStore(projectRoot).heartbeat({
              schemaVersion: "1",
              eventId: options.eventId,
              expectedEntityVersion: parseNonnegativeInteger(
                options.expectedVersion,
                "--expected-version",
              ),
              proof: {
                claimId: options.claim,
                fencingToken: parsePositiveInteger(options.fencingToken, "--fencing-token"),
                ownerId: options.owner,
                runId: options.run,
              },
              leaseDurationSeconds: parsePositiveInteger(options.leaseSeconds, "--lease-seconds"),
            });
            outputJsonFirst(
              await reconcileClaimAudit(projectRoot, options.actor, receipt),
              options.json,
            );
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  command.addCommand(
    proofOptions(new Command("release").description("current claim を解放する")).action(
      async (options: {
        eventId: string;
        expectedVersion: string;
        claim: string;
        fencingToken: string;
        owner: string;
        run: string;
        actor: string;
        json?: boolean;
      }) => {
        try {
          const projectRoot = process.cwd();
          const receipt = await new DispatchClaimStore(projectRoot).release({
            schemaVersion: "1",
            eventId: options.eventId,
            expectedEntityVersion: parseNonnegativeInteger(
              options.expectedVersion,
              "--expected-version",
            ),
            proof: {
              claimId: options.claim,
              fencingToken: parsePositiveInteger(options.fencingToken, "--fencing-token"),
              ownerId: options.owner,
              runId: options.run,
            },
          });
          outputJsonFirst(
            await reconcileClaimAudit(projectRoot, options.actor, receipt),
            options.json,
          );
        } catch (error) {
          outputError(error, options.json);
        }
      },
    ),
  );

  command.addCommand(
    new Command("reclaim")
      .description("期限切れまたは停止 owner の claim を回収する")
      .requiredOption("--event-id <id>", "冪等 caller event ID")
      .requiredOption("--expected-version <number>", "registry entityVersion")
      .requiredOption("--claim <id>", "reclaim 対象 claim ID")
      .requiredOption("--reason <reason>", "expired | owner_stopped")
      .option("--owner-stopped-evidence <id>", "owner_stopped の停止 evidence ID")
      .requiredOption("--actor <id>", "audit reconciliation の orchestrator actor ID")
      .option("--json", "JSON 形式で出力")
      .action(
        async (options: {
          eventId: string;
          expectedVersion: string;
          claim: string;
          reason: string;
          ownerStoppedEvidence?: string;
          actor: string;
          json?: boolean;
        }) => {
          try {
            if (options.reason !== "expired" && options.reason !== "owner_stopped") {
              throw new RunCommandError(
                "invalid_input",
                "--reason は expired | owner_stopped で指定してください",
              );
            }
            const projectRoot = process.cwd();
            const receipt = await new DispatchClaimStore(projectRoot).reclaim({
              schemaVersion: "1",
              eventId: options.eventId,
              expectedEntityVersion: parseNonnegativeInteger(
                options.expectedVersion,
                "--expected-version",
              ),
              claimId: options.claim,
              reason: options.reason,
              ...(options.ownerStoppedEvidence
                ? { ownerStoppedEvidenceId: options.ownerStoppedEvidence }
                : {}),
            });
            outputJsonFirst(
              await reconcileClaimAudit(projectRoot, options.actor, receipt),
              options.json,
            );
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  command.addCommand(
    new Command("start")
      .description("OPEN Issue から fixed dev-role run を開始する")
      .requiredOption("--issue <number>", "対象 GitHub Issue 番号")
      .requiredOption("--event-id <id>", "重複検出に使う caller event ID")
      .requiredOption("--actor <id>", "orchestrator actor ID")
      .option("--json", "JSON 形式で出力")
      .action(
        async (options: { issue: string; eventId: string; actor: string; json?: boolean }) => {
          try {
            outputResult(await startRun(process.cwd(), options), options.json, "Run start");
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  command.addCommand(
    new Command("event")
      .description("外部 runner の versioned command JSON を適用する")
      .argument("<run-id>", "Run Graph ID")
      .requiredOption("--file <path>", "runner command JSON ファイル")
      .option("--json", "JSON 形式で出力")
      .action(async (runId: string, options: { file: string; json?: boolean }) => {
        try {
          const raw = JSON.parse(
            await readFile(resolve(process.cwd(), options.file), "utf8"),
          ) as unknown;
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw new RunCommandError("invalid_input", "runner command JSON は object が必要です");
          }
          const rawCommand = "command" in raw ? raw.command : undefined;
          const rawCommandType =
            typeof rawCommand === "object" && rawCommand !== null && "type" in rawCommand
              ? rawCommand.type
              : undefined;
          if (rawCommandType === "human_decision" || rawCommandType === "pr_observed") {
            throw new RunCommandError(
              "authority_denied",
              `${rawCommandType} は専用の run command からのみ受理します`,
            );
          }
          const rawRecord = raw as Record<string, unknown>;
          const rawClaim = rawRecord.claim;
          const { claim: _claim, ...eventRecord } = rawRecord;
          const parsed = RunGraphRunnerCommandInputSchema.safeParse({ ...eventRecord, runId });
          if (!parsed.success) {
            throw new RunCommandError(
              "invalid_input",
              `runner command JSON が schema に一致しません: ${parsed.error.message}`,
            );
          }
          const requiresCurrentClaim =
            parsed.data.command.type === "attempt_finished" ||
            parsed.data.command.type === "node_outcome_submitted";
          if (requiresCurrentClaim && rawClaim === undefined) {
            try {
              const snapshot = await new DispatchClaimStore(process.cwd()).snapshot();
              if (snapshot.history.some((event) => event.runId === runId)) {
                outputResult(
                  {
                    accepted: false,
                    code: "stale_claim",
                    message:
                      "dispatch 済み Run の completion/outcome には current claim proof が必要です",
                    stateUnchanged: true,
                    view: await new RunGraphControlPlane(process.cwd()).inspect(runId),
                  },
                  options.json,
                  "Run event",
                );
                return;
              }
            } catch (error) {
              // 既存の standalone Run Graph は Git repository 外でも動作するため互換性を保つ。
              if (!isNotGitRepositoryError(error)) throw error;
            }
          }
          if (rawClaim !== undefined) {
            const claim = z
              .object({
                expectedEntityVersion: z.number().int().nonnegative(),
                proof: DispatchClaimProofSchema,
              })
              .strict()
              .parse(rawClaim);
            const claimStore = new DispatchClaimStore(process.cwd());
            outputResult(
              await new RunGraphControlPlane(
                process.cwd(),
                undefined,
                claimStore,
              ).applyClaimedEvent(parsed.data, claim.proof, claim.expectedEntityVersion),
              options.json,
              "Run event",
            );
          } else {
            outputResult(
              await new RunGraphControlPlane(process.cwd()).applyEvent(parsed.data),
              options.json,
              "Run event",
            );
          }
        } catch (error) {
          outputError(error, options.json);
        }
      }),
  );

  command.addCommand(
    new Command("show")
      .description("現在の bounded Run Graph view を表示する")
      .argument("<run-id>", "Run Graph ID")
      .option("--limit <count>", "artifact/evidence の最大表示件数", "20")
      .option("--json", "JSON 形式で出力")
      .action(async (runId: string, options: { limit: string; json?: boolean }) => {
        try {
          const view = await new RunGraphControlPlane(process.cwd()).inspect(
            runId,
            parsePositiveInteger(options.limit, "--limit"),
          );
          console.log(options.json ? JSON.stringify(view, null, 2) : formatRunGraphView(view));
        } catch (error) {
          outputError(error, options.json);
        }
      }),
  );

  command.addCommand(
    new Command("resume")
      .description("checkpoint と side-effect evidence から paused run を再開する")
      .argument("<run-id>", "Run Graph ID")
      .requiredOption("--event-id <id>", "重複検出に使う caller event ID")
      .requiredOption("--actor <id>", "orchestrator actor ID")
      .requiredOption("--checkpoint <artifact-id>", "checkpoint artifact ID")
      .requiredOption("--evidence <id...>", "再開根拠の evidence ID")
      .requiredOption(
        "--side-effect-state <state>",
        "外部副作用状態 (not_started | committed | reconciled | unknown)",
      )
      .option("--json", "JSON 形式で出力")
      .action(
        async (
          runId: string,
          options: {
            eventId: string;
            actor: string;
            checkpoint: string;
            evidence: string[];
            sideEffectState: string;
            json?: boolean;
          },
        ) => {
          try {
            const input = {
              schemaVersion: "1" as const,
              eventId: options.eventId,
              runId,
              actor: { id: options.actor, role: "orchestrator" as const },
              command: {
                type: "run_resumed" as const,
                checkpointArtifactId: options.checkpoint,
                evidenceIds: options.evidence,
                sideEffectState: parseSideEffectState(options.sideEffectState),
              },
            } as RunGraphRunnerCommandInput;
            outputResult(
              await new RunGraphControlPlane(process.cwd()).applyEvent(input),
              options.json,
              "Run resume",
            );
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  command.addCommand(
    new Command("decide")
      .description("human authority の decision evidence を human gate に適用する")
      .argument("<run-id>", "Run Graph ID")
      .requiredOption("--event-id <id>", "重複検出に使う caller event ID")
      .requiredOption("--actor <id>", "human actor ID")
      .requiredOption("--decision <decision>", "approved | rejected | override")
      .requiredOption("--evidence-id <id>", "human decision evidence ID")
      .option("--reason <text>", "decision 理由（override では必須）")
      .option("--json", "JSON 形式で出力")
      .action(
        async (
          runId: string,
          options: {
            eventId: string;
            actor: string;
            decision: string;
            evidenceId: string;
            reason?: string;
            json?: boolean;
          },
        ) => {
          try {
            const decision = parseHumanDecision(options.decision);
            const reason = options.reason?.trim() || null;
            if (decision === "override" && reason === null) {
              throw new RunCommandError("invalid_input", "override には --reason が必要です");
            }
            const eventId = parseRequiredText(options.eventId, "--event-id");
            const actorId = parseRequiredText(options.actor, "--actor");
            const evidenceId = parseRequiredText(options.evidenceId, "--evidence-id");
            const actor = { id: actorId, role: "human" as const };
            const canonicalJson = JSON.stringify({ actor, decision, reason });
            outputResult(
              await new RunGraphControlPlane(process.cwd()).applyEvent({
                schemaVersion: "1",
                eventId,
                runId,
                actor,
                command: {
                  type: "human_decision",
                  decision,
                  reason,
                  evidenceIds: [evidenceId],
                },
                evidence: [
                  {
                    id: evidenceId,
                    kind: "human_decision",
                    artifactIds: [],
                    provenance: `human:${actorId}`,
                    reference: boundedReference(
                      "command",
                      "command:gh-gantt/run/decide",
                      canonicalJson,
                    ),
                  },
                ],
              }),
              options.json,
              "Run decide",
            );
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  command.addCommand(
    new Command("observe-pr")
      .description("GitHub から取得した PR live state を Run Graph に適用する")
      .argument("<run-id>", "Run Graph ID")
      .requiredOption("--repository <owner/repo>", "PR repository")
      .requiredOption("--number <number>", "PR 番号")
      .requiredOption("--event-id <id>", "重複検出に使う caller event ID")
      .requiredOption("--actor <id>", "orchestrator actor ID")
      .requiredOption("--evidence-id <id>", "GitHub PR live evidence ID")
      .option("--json", "JSON 形式で出力")
      .action(
        async (
          runId: string,
          options: {
            repository: string;
            number: string;
            eventId: string;
            actor: string;
            evidenceId: string;
            json?: boolean;
          },
        ) => {
          try {
            const { owner, repo } = parseRepository(options.repository);
            const number = parsePositiveInteger(options.number, "--number");
            const eventId = parseRequiredText(options.eventId, "--event-id");
            const actorId = parseRequiredText(options.actor, "--actor");
            const evidenceId = parseRequiredText(options.evidenceId, "--evidence-id");
            const control = new RunGraphControlPlane(process.cwd());
            const before = await control.inspect(runId);
            const expectedRepository = `${before.task.owner}/${before.task.repo}`;
            if (`${owner}/${repo}`.toLowerCase() !== expectedRepository.toLowerCase()) {
              outputResult(
                {
                  accepted: false,
                  code: "pr_not_linked_to_task",
                  message: `PR repository は Run 対象 ${expectedRepository} と一致する必要があります`,
                  stateUnchanged: true,
                  view: before,
                },
                options.json,
                "Run observe-pr",
              );
              return;
            }
            let liveState: RunGraphPrObservation;
            try {
              liveState = await fetchRunGraphPrObservation({
                target: { owner, repo, number, crossRepo: false },
                expectedIssue: before.task,
              });
            } catch {
              outputResult(
                {
                  accepted: false,
                  code: "github_live_state_unavailable",
                  message: `GitHub PR live state/linkage を取得できません: ${owner}/${repo}#${number}`,
                  stateUnchanged: true,
                  view: before,
                },
                options.json,
                "Run observe-pr",
              );
              return;
            }
            if (
              liveState.owner.toLowerCase() !== owner.toLowerCase() ||
              liveState.repo.toLowerCase() !== repo.toLowerCase() ||
              liveState.number !== number
            ) {
              outputResult(
                {
                  accepted: false,
                  code: "github_live_state_unavailable",
                  message: `GitHub PR live state を一意に取得できません: ${owner}/${repo}#${number}`,
                  stateUnchanged: true,
                  view: before,
                },
                options.json,
                "Run observe-pr",
              );
              return;
            }
            const canonicalLiveState = JSON.stringify({
              owner: liveState.owner,
              repo: liveState.repo,
              number: liveState.number,
              state: liveState.state,
              isDraft: liveState.isDraft,
              linkedIssue: liveState.linkedIssue,
              linkageComplete: liveState.linkageComplete,
              reviewDecision: liveState.reviewDecision,
              unresolvedThreads: liveState.unresolvedThreads,
              pendingChecks: liveState.pendingChecks ?? null,
            });
            const actor = { id: actorId, role: "orchestrator" as const };
            outputResult(
              await control.applyEvent({
                schemaVersion: "1",
                eventId,
                runId,
                actor,
                command: {
                  type: "pr_observed",
                  repository: `${owner}/${repo}`,
                  pullRequestNumber: number,
                  state: liveState.state.toLowerCase() as "open" | "merged" | "closed",
                  isDraft: liveState.isDraft,
                  linkedIssue: liveState.linkedIssue,
                  linkageComplete: liveState.linkageComplete,
                  evidenceIds: [evidenceId],
                },
                evidence: [
                  {
                    id: evidenceId,
                    kind: "github_pr_live",
                    artifactIds: [],
                    provenance: "github:graphql-live",
                    reference: boundedReference(
                      "github",
                      `https://github.com/${owner}/${repo}/pull/${number}`,
                      canonicalLiveState,
                    ),
                  },
                ],
              }),
              options.json,
              "Run observe-pr",
            );
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  return command;
}
