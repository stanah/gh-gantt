import { describe, expect, it } from "vitest";
import type { MutationApprovalConfig } from "@gh-gantt/shared";
import {
  HumanApprovalAuthority,
  renderMutationApprovalMachineBlock,
  type GitHubApprovalEvidencePort,
  type LiveGitHubApprovalEvidence,
} from "../work-graph/human-approval-authority.js";

const config: MutationApprovalConfig = {
  schema_version: "1",
  source: "github_issue_comment",
  allowed_author_node_ids: ["U_human_reviewer"],
};
const bound = {
  proposalId: "proposal-331",
  revision: 2,
  proposalFingerprint: "a".repeat(64),
  expiresAt: "2026-08-03T00:00:00.000Z",
  purpose: "decision" as const,
  stepId: null,
  targetRunId: null,
  targetProjectRoot: null,
  successorDescriptorFingerprint: null,
};

function evidence(overrides: Partial<LiveGitHubApprovalEvidence> = {}): LiveGitHubApprovalEvidence {
  const body = renderMutationApprovalMachineBlock({ ...bound, decision: "approve" });
  return {
    repository: "example/public",
    issueNumber: 331,
    commentId: "IC_public_fixture",
    body,
    author: { nodeId: "U_human_reviewer", login: "reviewer", type: "User" },
    viewerNodeId: "U_agent_principal",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

function port(value: LiveGitHubApprovalEvidence | Error): GitHubApprovalEvidencePort {
  return {
    async readLiveComment() {
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe("[NFR-STABILITY-014-AC8] 人間承認権限", () => {
  it("live User commentとviewerのprincipalが分離されたexact bindingだけを信頼する", async () => {
    const authority = new HumanApprovalAuthority(
      config,
      { repository: "example/public", issueNumber: 331 },
      port(evidence()),
      () => "2026-08-02T01:00:00.000Z",
    );
    const receipt = await authority.verify(bound, {
      repository: "example/public",
      issueNumber: 331,
      commentId: "IC_public_fixture",
    });
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.receipt.actor.id).toBe("U_human_reviewer");
      expect(receipt.receipt.actor.role).toBe("human");
      expect(receipt.receipt.decision).toBe("approve");
      expect(receipt.receipt.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each([
    ["same principal", { viewerNodeId: "U_human_reviewer" }],
    ["wrong author", { author: { nodeId: "U_unknown", login: "unknown", type: "User" as const } }],
    ["bot author", { author: { nodeId: "B_bot", login: "bot", type: "Bot" as const } }],
    ["edited", { updatedAt: "2026-08-02T00:01:00.000Z" }],
    ["deleted", { deleted: true }],
    ["wrong repo", { repository: "other/public" }],
    ["wrong issue", { issueNumber: 999 }],
  ])("%s のcommentをfail-closed拒否する", async (_label, overrides) => {
    const authority = new HumanApprovalAuthority(
      config,
      { repository: "example/public", issueNumber: 331 },
      port(evidence(overrides)),
      () => "2026-08-02T01:00:00.000Z",
    );
    await expect(
      authority.verify(bound, {
        repository: "example/public",
        issueNumber: 331,
        commentId: "IC_public_fixture",
      }),
    ).resolves.toMatchObject({ ok: false, code: "human_gate_required" });
  });

  it("wrong revision、複数marker、期限切れ、API failureを拒否する", async () => {
    const wrongRevision = renderMutationApprovalMachineBlock({
      ...bound,
      revision: 3,
      decision: "approve",
    });
    const cases: Array<[LiveGitHubApprovalEvidence | Error, string]> = [
      [evidence({ body: wrongRevision }), "wrong revision"],
      [evidence({ body: `${wrongRevision}\n${wrongRevision}` }), "multiple marker"],
      [evidence(), "expired"],
      [new Error("network unavailable"), "api failure"],
    ];
    for (const [value, label] of cases) {
      const now = label === "expired" ? "2026-08-04T00:00:00.000Z" : "2026-08-02T01:00:00.000Z";
      const authority = new HumanApprovalAuthority(
        config,
        { repository: "example/public", issueNumber: 331 },
        port(value),
        () => now,
      );
      const result = await authority.verify(bound, {
        repository: "example/public",
        issueNumber: 331,
        commentId: "IC_public_fixture",
      });
      expect(result, label).toMatchObject({ ok: false, code: "human_gate_required" });
    }
  });

  it("decision commentのcompensation/replan targetへのcross-purpose replayを拒否する", async () => {
    const authority = new HumanApprovalAuthority(
      config,
      { repository: "example/public", issueNumber: 331 },
      port(evidence()),
      () => "2026-08-02T01:00:00.000Z",
    );
    await expect(
      authority.verify(
        {
          ...bound,
          purpose: "compensation",
          stepId: "step-0001",
        },
        {
          repository: "example/public",
          issueNumber: 331,
          commentId: "IC_public_fixture",
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: "human_gate_required" });
    await expect(
      authority.verify(
        {
          ...bound,
          purpose: "replan",
          targetRunId: "run-other",
          targetProjectRoot: "/other",
          successorDescriptorFingerprint: "f".repeat(64),
        },
        {
          repository: "example/public",
          issueNumber: 331,
          commentId: "IC_public_fixture",
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: "human_gate_required" });
  });
});
