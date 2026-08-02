import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readRepoFile = (path: string) => readFile(path, "utf8");

describe("[NFR-STABILITY-014-AC8] 承認gate付きWork Graph mutation workflow", () => {
  it("project contractとshared skillsが同じfail-closed JSON lifecycleを定義する", async () => {
    const [workflow, workflowSkill, decomposeSkill, adr] = await Promise.all([
      readRepoFile(".gantt-sync/workflow.md"),
      readRepoFile("skills/gh-gantt-workflow/SKILL.md"),
      readRepoFile("skills/gh-gantt-decompose/SKILL.md"),
      readRepoFile("docs/adr/ADR-025-approval-gated-work-graph-mutation.md"),
    ]);
    for (const document of [workflow, workflowSkill]) {
      expect(document).toContain("gh-gantt mutation execute --input");
      expect(document).toContain("gh-gantt mutation show");
      expect(document).toContain("unknown");
      expect(document).toContain("Graph Contract");
      expect(document).toContain("approvalRequests");
      expect(document).toContain("compensation");
      expect(document).toContain("replan");
    }
    expect(decomposeSkill).toContain("origin Runをmutation checkpointへ停止");
    expect(decomposeSkill).toContain("unknown");
    expect(adr).toContain("work_graph_invalidated");
    expect(adr).toContain("work_graph_replan_accepted");
    expect(adr).toContain("reprioritizeSubIssue");
    expect(adr).toContain("mutation-proposals/v1");
    expect(adr).toContain("accept_replan");
    expect(adr).toContain("accepting_replan / compensating / applied / compensated");
    expect(adr).toContain("side_effect_in_flight");
    expect(adr).toContain("successor descriptor fingerprint");
  });
});
