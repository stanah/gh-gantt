import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAdrFile } from "@gh-gantt/shared";
import { parse } from "yaml";
import { z } from "zod";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

const AcceptanceCriteriaSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(["covered", "failing", "uncovered"]),
  tests: z.array(z.string().min(1)),
});

const RequirementsSchema = z.object({
  areas: z.array(
    z.object({
      id: z.string().min(1),
      requirements: z.array(
        z.object({
          id: z.string().min(1),
          acceptance_criteria: z.array(AcceptanceCriteriaSchema).min(1),
        }),
      ),
    }),
  ),
});

async function readRepoFile(path: string): Promise<string> {
  const content = await readFile(resolve(repoRoot, path), "utf-8");
  return z.string().min(1).parse(content);
}

function extractMarkdownSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const tail = content.slice(start + heading.length);
  const nextHeading = tail.search(new RegExp(`^#{1,${level}}\\s`, "m"));
  return content.slice(
    start,
    nextHeading === -1 ? undefined : start + heading.length + nextHeading,
  );
}

function parseMarkdownTable(content: string, heading: string): Array<Record<string, string>> {
  const lines = extractMarkdownSection(content, heading).split("\n");
  const tableStart = lines.findIndex((line) => line.trim().startsWith("|"));
  expect(tableStart).toBeGreaterThanOrEqual(0);

  const parseRow = (line: string) =>
    line
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim().replaceAll("`", ""));
  const headers = parseRow(lines[tableStart] ?? "");
  const rows: Array<Record<string, string>> = [];

  for (const line of lines.slice(tableStart + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = parseRow(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
  }
  return rows;
}

describe("Graph Contract の公開文書契約", () => {
  it("ADR-021 は4 graphの正典、canonical artifact/store、段階境界を一意にする", async () => {
    const content = await readRepoFile("docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md");
    const { frontmatter, body } = parseAdrFile(content);

    expect(frontmatter).toMatchObject({
      id: "ADR-021",
      status: "accepted",
      related_requirements: ["NFR-STABILITY-014"],
    });
    for (const heading of ["## Context", "## Decision", "## Alternatives", "## Consequences"]) {
      expect(body).toContain(heading);
    }

    expect(parseMarkdownTable(body, "### 正準4 graphと正本")).toEqual([
      {
        graph: "Plan Graph",
        "authoritative definition": "Graph Contract topology",
        "canonical artifact / store": "versioned plan artifact",
        "current #327": "ADR-021 + workflowのunversioned provisional projection",
        "after #328": "Graph Contract store",
      },
      {
        graph: "Org Graph",
        "authoritative definition": "Graph Contract role / authority",
        "canonical artifact / store": "versioned authority binding",
        "current #327": "ADR-021 + Dev-Role Configのunversioned provisional projection",
        "after #328": "Graph Contract store",
      },
      {
        graph: "Work Graph",
        "authoritative definition": "GitHub Issues / Projects",
        "canonical artifact / store": "GitHub remote task / relation",
        "current #327": "GitHub remoteが正本、.gantt-syncはcache",
        "after #328": "変更なし",
      },
      {
        graph: "Run Graph",
        "authoritative definition": "accepted run event",
        "canonical artifact / store": "append-only Run Graph event store",
        "current #327": "正準storeなし、.dev-flow artifactはevidence",
        "after #328": "Run Graph event store",
      },
    ]);

    const binding = extractMarkdownSection(body, "### version bindingと競合規則");
    expect(binding).toContain("plan_id");
    expect(binding).toContain("plan_version");
    expect(binding).toContain("現行#327にはplan_id、plan_version、authority bindingの値がない");
    expect(binding).toContain("unversioned provisional projection");
    expect(binding).toContain("workflowはGraph Contractを再定義しない");
    expect(binding).toContain("exact bindingとfail-closed validationは#328以後");
    expect(binding).toContain("fail-closed");
    expect(binding).toContain("waiting_human");
    expect(binding).toContain("現行#327");
    expect(binding).toContain("#328以後");
  });

  it("run/node/attemptの正準状態集合を完全一致で定義する", async () => {
    const adr = await readRepoFile("docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md");

    expect(parseMarkdownTable(adr, "### 正準状態集合")).toEqual([
      {
        entity: "run",
        states: "pending, running, paused, waiting_human, completed, failed, cancelled",
        terminal: "completed, failed, cancelled",
      },
      {
        entity: "node",
        states: "pending, ready, running, paused, waiting_human, completed, failed, cancelled",
        terminal: "completed, failed, cancelled",
      },
      {
        entity: "attempt",
        states: "created, running, succeeded, failed, timed_out, stalled, cancelled",
        terminal: "succeeded, failed, timed_out, stalled, cancelled",
      },
    ]);
  });

  it("run遷移表はpause/resume/human/cancel/migration/stale eventを一意にする", async () => {
    const adr = await readRepoFile("docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md");

    expect(parseMarkdownTable(adr, "#### Run transition")).toEqual([
      transition(
        "run.pending",
        "start + exact version/target valid",
        "run.running",
        "no",
        "reject; keep pending",
      ),
      transition(
        "run.running",
        "pause + checkpoint persisted",
        "run.paused",
        "checkpoint",
        "reject; keep running",
      ),
      transition(
        "run.paused",
        "resume + checkpoint/artifact/evidence valid",
        "run.running",
        "no",
        "reject; keep paused",
      ),
      transition(
        "run.running",
        "human_gate_required or budget_exceeded",
        "run.waiting_human",
        "checkpoint",
        "reject; keep running",
      ),
      transition(
        "run.waiting_human",
        "human_approved + authority/decision evidence valid",
        "run.running",
        "no",
        "reject; keep waiting_human",
      ),
      transition(
        "run.running",
        "complete + required nodes/gates complete",
        "run.completed",
        "terminal",
        "reject; keep running",
      ),
      transition(
        "run.running",
        "fail + non-retryable",
        "run.failed",
        "terminal",
        "reject; keep running",
      ),
      transition(
        "run.{pending,running,paused,waiting_human}",
        "cancel + authority evidence valid",
        "run.cancelled",
        "terminal",
        "reject; keep source",
      ),
      transition(
        "run.{paused,waiting_human}",
        "migrate + supported version/migration evidence valid",
        "same state",
        "checkpoint",
        "reject; keep source",
      ),
      transition(
        "run.{completed,failed,cancelled}",
        "stale_event",
        "same state",
        "terminal",
        "reject; keep source",
      ),
    ]);
  });

  it("node遷移表はready/attempt/pause/human/cancel/stale eventを一意にする", async () => {
    const adr = await readRepoFile("docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md");

    expect(parseMarkdownTable(adr, "#### Node transition")).toEqual([
      transition(
        "node.pending",
        "dependencies_satisfied",
        "node.ready",
        "no",
        "reject; keep pending",
      ),
      transition(
        "node.ready",
        "attempt_started + authority valid",
        "node.running",
        "no",
        "reject; keep ready",
      ),
      transition(
        "node.running",
        "pause + checkpoint persisted",
        "node.paused",
        "checkpoint",
        "reject; keep running",
      ),
      transition(
        "node.paused",
        "resume + checkpoint/artifact/evidence valid",
        "node.running",
        "no",
        "reject; keep paused",
      ),
      transition(
        "node.running",
        "human_gate_required or budget_exceeded",
        "node.waiting_human",
        "checkpoint",
        "reject; keep running",
      ),
      transition(
        "node.waiting_human",
        "human_approved + authority/decision evidence valid",
        "node.running",
        "no",
        "reject; keep waiting_human",
      ),
      transition(
        "node.running",
        "attempt_succeeded + schema-valid node outcome",
        "node.completed",
        "terminal",
        "reject; keep running",
      ),
      transition(
        "node.running",
        "non-retryable node outcome",
        "node.failed",
        "terminal",
        "reject; keep running",
      ),
      transition(
        "node.{pending,ready,running,paused,waiting_human}",
        "cancel + authority evidence valid",
        "node.cancelled",
        "terminal",
        "reject; keep source",
      ),
      transition(
        "node.{completed,failed,cancelled}",
        "stale_event",
        "same state",
        "terminal",
        "reject; keep source",
      ),
    ]);
  });

  it("attempt遷移表はterminal reasonとstale event拒否を一意にする", async () => {
    const adr = await readRepoFile("docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md");

    expect(parseMarkdownTable(adr, "#### Attempt transition")).toEqual([
      transition(
        "attempt.created",
        "start + current attempt ID",
        "attempt.running",
        "no",
        "reject; keep created",
      ),
      transition(
        "attempt.running",
        "succeed + evidence valid",
        "attempt.succeeded",
        "terminal",
        "reject; keep running",
      ),
      transition(
        "attempt.running",
        "fail + failure evidence valid",
        "attempt.failed",
        "terminal",
        "reject; keep running",
      ),
      transition(
        "attempt.running",
        "timeout",
        "attempt.timed_out",
        "terminal",
        "reject; keep running",
      ),
      transition("attempt.running", "stall", "attempt.stalled", "terminal", "reject; keep running"),
      transition(
        "attempt.running",
        "cancel + authority evidence valid",
        "attempt.cancelled",
        "terminal",
        "reject; keep running",
      ),
      transition(
        "attempt.{succeeded,failed,timed_out,stalled,cancelled}",
        "stale_event",
        "same state",
        "terminal",
        "reject; keep source",
      ),
    ]);

    expect(parseMarkdownTable(adr, "### Cross-entity propagation")).toEqual([
      propagation(
        "attempt.succeeded",
        "schema-valid node outcome",
        "node.completed + evaluate Plan edge",
        "run.running",
        "terminal attempt preserved",
      ),
      propagation(
        "attempt.{failed,timed_out,stalled}",
        "retryable + attempt_count < attempt budget",
        "node.ready",
        "run.running",
        "new monotonic attempt ID + lineage",
      ),
      propagation(
        "attempt.{failed,timed_out,stalled}",
        "retryable + attempt_count >= attempt budget",
        "node.waiting_human",
        "run.waiting_human checkpoint",
        "terminal attempt preserved",
      ),
      propagation(
        "attempt.{failed,timed_out,stalled}",
        "non-retryable",
        "node.failed",
        "run.failed terminal",
        "terminal attempt preserved",
      ),
      propagation(
        "executor role node",
        "schema-valid verify_failed outcome + retry budget available",
        "new implementer Run node ID",
        "run.running + evaluate Plan edge",
        "source node remains completed",
      ),
      propagation(
        "reviewer role node",
        "schema-valid request-changes outcome + improvement budget available",
        "new implementer Run node ID",
        "run.running + evaluate Plan edge",
        "source node remains completed",
      ),
    ]);
    const propagationSection = extractMarkdownSection(adr, "### Cross-entity propagation");
    expect(propagationSection).toContain("attemptはexecution mechanics");
    expect(propagationSection).toContain("terminal eventだけではnode outcomeにならない");
  });

  it("fixed dev-role graphはretry計数と停止/handoff edgeを完全一致で定義する", async () => {
    const [adr, orchestrator] = await Promise.all([
      readRepoFile("docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md"),
      readRepoFile("skills/gh-gantt-dev-role/references/orchestrator.md"),
    ]);

    expect(parseMarkdownTable(adr, "### Fixed dev-role transition")).toEqual([
      devTransition(
        "planner",
        "plan_valid + schema-valid",
        "implementer",
        "CONTINUE",
        "plan artifact",
      ),
      devTransition(
        "planner",
        "plan_invalid or evidence_missing",
        "waiting_human",
        "BLOCKED",
        "validation evidence",
      ),
      devTransition(
        "implementer",
        "implementation_valid + evidence present",
        "executor",
        "CONTINUE",
        "implementation artifact",
      ),
      devTransition(
        "implementer",
        "implementation_invalid or evidence_missing",
        "waiting_human",
        "BLOCKED",
        "validation evidence",
      ),
      devTransition("executor", "verify_passed", "reviewer", "CONTINUE", "all command evidence"),
      devTransition(
        "executor",
        "verify_failed + retry_count < maxExecutorRetries",
        "implementer",
        "RETRY",
        "failure evidence + new implementer Run node ID",
      ),
      devTransition(
        "executor",
        "verify_failed + retry_count >= maxExecutorRetries",
        "waiting_human",
        "BLOCKED",
        "failure evidence",
      ),
      devTransition(
        "reviewer",
        "approve",
        "human / PR",
        "READY_FOR_PR",
        "independent review artifact",
      ),
      devTransition(
        "reviewer",
        "request-changes + no critical + improvement_count < maxImprovementIterations",
        "implementer",
        "IMPROVE",
        "findings + new implementer Run node ID",
      ),
      devTransition(
        "reviewer",
        "budget exhausted + only minor remains",
        "human / PR",
        "CONDITIONAL_HANDOFF",
        "remaining findings in PR description",
      ),
      devTransition(
        "reviewer",
        "budget exhausted + major remains",
        "waiting_human",
        "BLOCKED",
        "remaining major findings",
      ),
      devTransition(
        "reviewer",
        "critical finding",
        "waiting_human",
        "ESCALATED",
        "critical finding evidence",
      ),
      devTransition(
        "any role",
        "required evidence missing",
        "waiting_human",
        "BLOCKED",
        "missing evidence list",
      ),
      devTransition(
        "human / PR",
        "approved / merged",
        "terminal",
        "COMPLETED",
        "human decision + PR evidence",
      ),
    ]);

    const budget = extractMarkdownSection(adr, "### Budget計数規則");
    expect(budget).toContain("初回executor attemptはretry_count=0");
    expect(budget).toContain("追加retry回数");
    expect(budget).toContain("初回reviewer passはimprovement_count=0");
    expect(budget).toContain("reviewer起点の追加改善回数");
    expect(orchestrator).toContain("ADR-021のFixed dev-role transitionを正典とする");
    const outputContract = extractMarkdownSection(orchestrator, "## 出力契約");
    expect(outputContract).toContain(
      "`status`: `READY_FOR_PR` / `CONDITIONAL_HANDOFF` / `BLOCKED` / `ESCALATED` / `COMPLETED`",
    );
  });

  it("active workflowは現行manual gateと#328後の製品control planeを区別する", async () => {
    const paths = [
      ".gantt-sync/workflow.md",
      "skills/gh-gantt-dev-role/SKILL.md",
      "skills/gh-gantt-workflow/SKILL.md",
    ] as const;

    for (const path of paths) {
      const content = await readRepoFile(path);
      expect(content).toContain("ADR-021");
      expect(content).toContain("現行 (#327)");
      expect(content).toContain("外部orchestrator");
      expect(content).toContain("JSON/schema/manual gate");
      expect(content).toContain("#328以後");
      expect(content).toContain("製品control plane");
    }

    const workflowSkill = await readRepoFile("skills/gh-gantt-workflow/SKILL.md");
    expect(workflowSkill).toContain("#329のclaim/lease/join");
    expect(workflowSkill).toContain("#331のapproval proposal/new plan version");

    const projectMap = await readRepoFile("docs/project-map.md");
    const mapSection = extractMarkdownSection(projectMap, "## 10. Graph Contractとの関係");
    expect(mapSection).toContain("Work Graphの派生view");
    expect(mapSection).toContain("正典はADR-021");
    expect(mapSection).toContain("#330");
    expect(mapSection).toContain("#329のclaim/lease/join");
    expect(mapSection).toContain("#331のapproval proposal/new plan version");
    expect(mapSection.length).toBeLessThan(700);
  });

  it("NFR-STABILITY-014はAC1からAC8を固有意味のまま未実装として保持する", async () => {
    const requirements = RequirementsSchema.parse(
      parse(await readRepoFile("docs/requirements.yaml")) as unknown,
    );
    const stability = requirements.areas.find((area) => area.id === "STABILITY");
    const requirement = stability?.requirements.find((entry) => entry.id === "NFR-STABILITY-014");
    const criteria = requirement?.acceptance_criteria ?? [];

    expect(criteria.map((entry) => entry.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `NFR-STABILITY-014-AC${index + 1}`),
    );
    const meanings: Record<string, string[]> = {
      "NFR-STABILITY-014-AC1": [
        "Plan Graph",
        "Work Graph",
        "Org Graph",
        "Run Graph",
        "versioned Graph Contract",
      ],
      "NFR-STABILITY-014-AC2": [
        "control plane",
        "external runner",
        "execution plane",
        "outcome event",
      ],
      "NFR-STABILITY-014-AC3": [
        "role",
        "node",
        "edge",
        "artifact",
        "authority",
        "budget",
        "human gate",
        "schema version",
      ],
      "NFR-STABILITY-014-AC4": ["run", "node", "attempt", "artifact", "evidence", "lineage"],
      "NFR-STABILITY-014-AC5": ["停止", "取消", "失敗", "再開", "checkpoint", "migration", "拒否"],
      "NFR-STABILITY-014-AC6": [
        "fixed dev-role graph",
        "verify retry",
        "review improvement",
        "不正 transition",
      ],
      "NFR-STABILITY-014-AC7": ["bypass", "authority", "evidence", "human gate"],
      "NFR-STABILITY-014-AC8": ["bounded parallelism", "Work Graph", "versioned extension"],
    };

    for (const entry of criteria) {
      const description = entry.description.replaceAll(/\s+/g, " ");
      for (const term of meanings[entry.id] ?? []) expect(description).toContain(term);
      expect(entry.status).toBe("uncovered");
      expect(entry.tests).toEqual([]);
    }

    const testSource = await readRepoFile("tests/workflow/graph-contract.test.ts");
    expect(testSource).not.toMatch(/\[NFR-STABILITY-014-AC\d+\]/);
  });

  it("ADR-021は一次資料の事実と推論を分離しGraph Engineeringを外部標準化しない", async () => {
    const adr = await readRepoFile("docs/adr/ADR-021-graph-contract-and-run-graph-boundary.md");

    expect(adr).toContain(
      "https://github.com/openai/symphony/blob/f8e8b8a670c799f6e0ade7a8c25c4bf4a4a56ec7/SPEC.md",
    );
    expect(adr).toContain("https://www.anthropic.com/engineering/building-effective-agents");
    expect(adr).toContain("一次資料に明記された事実");
    expect(adr).toContain("gh-gantt固有の推論");
    expect(adr).toContain("Graph Engineeringを確立済みの外部標準として扱わない");
  });
});

function transition(
  source: string,
  eventOrGuard: string,
  target: string,
  terminalOrCheckpoint: string,
  refusal: string,
) {
  return {
    source,
    "event or guard": eventOrGuard,
    target,
    "terminal or checkpoint": terminalOrCheckpoint,
    refusal,
  };
}

function devTransition(
  source: string,
  eventOrGuard: string,
  target: string,
  outcome: string,
  evidence: string,
) {
  return { source, "event or guard": eventOrGuard, target, outcome, evidence };
}

function propagation(
  source: string,
  eventOrGuard: string,
  target: string,
  runEffect: string,
  identityOrLineage: string,
) {
  return {
    source,
    "event or guard": eventOrGuard,
    target,
    "run effect": runEffect,
    "identity / lineage": identityOrLineage,
  };
}
