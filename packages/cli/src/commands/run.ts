import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FIXED_DEV_ROLE_GRAPH_CONTRACT,
  type RunGraphRunnerCommandInput,
  type RunGraphView,
} from "@gh-gantt/shared";
import { Command } from "commander";
import {
  fetchRunGraphPrObservation as fetchRunGraphPrObservationDefault,
  type RunGraphPrObservation,
} from "../loop/pr-evidence.js";
import { RunGraphControlPlane, type RunGraphCommandResult } from "../run-graph/control-plane.js";
import { ConfigStore } from "../store/config.js";
import { GraphContractStore } from "../store/graph-contract.js";
import { TasksStore } from "../store/tasks.js";

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

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RunCommandError("invalid_input", `${option} は正の整数で指定してください`);
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
  ];
  return lines.join("\n");
}

function outputResult(result: RunGraphCommandResult, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.accepted) {
    console.log(formatRunGraphView(result.view));
  } else {
    console.error(`Run event rejected [${result.code}]: ${result.message}`);
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

async function startRun(
  projectRoot: string,
  options: { issue: string; eventId: string; actor: string },
): Promise<RunGraphCommandResult> {
  const issueNumber = parsePositiveInteger(options.issue, "--issue");
  const config = await new ConfigStore(projectRoot).read();
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

  const tasks = await new TasksStore(projectRoot).read();
  const repository = `${config.project.github.owner}/${config.project.github.repo}`;
  const task = tasks.tasks.find(
    (candidate) => candidate.github_issue === issueNumber && candidate.github_repo === repository,
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
    eventId: options.eventId,
    actor: { id: options.actor, role: "orchestrator" },
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
}

export function createRunCommand(dependencies: RunCommandDependencies = {}): Command {
  const fetchRunGraphPrObservation =
    dependencies.fetchRunGraphPrObservation ?? fetchRunGraphPrObservationDefault;
  const command = new Command("run").description("Durable Run Graph を操作する");

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
            outputResult(await startRun(process.cwd(), options), options.json);
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
          const input = { ...raw, runId } as RunGraphRunnerCommandInput;
          outputResult(
            await new RunGraphControlPlane(process.cwd()).applyEvent(input),
            options.json,
          );
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
            );
          } catch (error) {
            outputError(error, options.json);
          }
        },
      ),
  );

  return command;
}
