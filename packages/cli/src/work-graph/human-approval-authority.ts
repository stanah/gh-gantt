import {
  canonicalJsonStringify,
  mutationCommandFingerprint,
  type MutationActor,
  type MutationApprovalConfig,
} from "@gh-gantt/shared";

const MARKER_START = "<!-- gh-gantt:mutation-approval:v1";
const MARKER_END = "-->";

export interface MutationBoundDecision {
  proposalId: string;
  revision: number;
  proposalFingerprint: string;
  expiresAt: string;
  purpose: "decision" | "compensation" | "replan";
  stepId: string | null;
  targetRunId: string | null;
  targetProjectRoot: string | null;
  successorDescriptorFingerprint: string | null;
}

export interface MutationApprovalMachineBlock extends MutationBoundDecision {
  decision: "approve" | "reject";
}

export interface GitHubApprovalCommentRef {
  repository: string;
  issueNumber: number;
  commentId: string;
}

export interface LiveGitHubApprovalEvidence {
  repository: string;
  issueNumber: number;
  commentId: string;
  body: string;
  author: { nodeId: string; login: string; type: "User" | "Bot" | "Organization" };
  viewerNodeId: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

/** cached commentsを使わず、GitHubから現在値を読むsystem boundary。 */
export interface GitHubApprovalEvidencePort {
  readLiveComment(ref: GitHubApprovalCommentRef): Promise<LiveGitHubApprovalEvidence>;
}

export interface TrustedHumanApprovalReceipt {
  schemaVersion: "1";
  decision: "approve" | "reject";
  actor: MutationActor;
  repository: string;
  issueNumber: number;
  commentId: string;
  bodyHash: string;
  commentUpdatedAt: string;
  verifiedAt: string;
  viewerNodeId: string;
  authorityConfigFingerprint: string;
  boundDecision: MutationBoundDecision;
}

export type HumanApprovalVerification =
  | { ok: true; receipt: TrustedHumanApprovalReceipt }
  | { ok: false; code: "human_gate_required"; diagnostic: string };

function normalizeRepository(value: string): string {
  return value.trim().toLowerCase();
}

function parseMachineBlock(body: string): MutationApprovalMachineBlock | null {
  const pattern = /<!-- gh-gantt:mutation-approval:v1\s*\n([\s\S]*?)\n-->/g;
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1) return null;
  try {
    const parsed = JSON.parse(matches[0]![1]!) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    const expectedKeys = [
      "decision",
      "expiresAt",
      "proposalFingerprint",
      "proposalId",
      "purpose",
      "revision",
      "stepId",
      "successorDescriptorFingerprint",
      "targetProjectRoot",
      "targetRunId",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return null;
    if (parsed.decision !== "approve" && parsed.decision !== "reject") return null;
    if (typeof parsed.proposalId !== "string" || parsed.proposalId.length === 0) return null;
    if (!Number.isInteger(parsed.revision) || Number(parsed.revision) < 1) return null;
    if (
      typeof parsed.proposalFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.proposalFingerprint)
    ) {
      return null;
    }
    if (typeof parsed.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.expiresAt))) {
      return null;
    }
    if (
      parsed.purpose !== "decision" &&
      parsed.purpose !== "compensation" &&
      parsed.purpose !== "replan"
    ) {
      return null;
    }
    for (const key of ["stepId", "targetRunId", "targetProjectRoot"] as const) {
      if (parsed[key] !== null && typeof parsed[key] !== "string") return null;
    }
    if (
      parsed.successorDescriptorFingerprint !== null &&
      (typeof parsed.successorDescriptorFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(parsed.successorDescriptorFingerprint))
    ) {
      return null;
    }
    return {
      proposalId: parsed.proposalId,
      revision: Number(parsed.revision),
      proposalFingerprint: parsed.proposalFingerprint,
      decision: parsed.decision,
      expiresAt: parsed.expiresAt,
      purpose: parsed.purpose,
      stepId: parsed.stepId as string | null,
      targetRunId: parsed.targetRunId as string | null,
      targetProjectRoot: parsed.targetProjectRoot as string | null,
      successorDescriptorFingerprint: parsed.successorDescriptorFingerprint as string | null,
    };
  } catch {
    return null;
  }
}

/** GitHub Webから人間が貼り付ける、秘密値を含まないcanonical decision block。 */
export function renderMutationApprovalMachineBlock(input: MutationApprovalMachineBlock): string {
  return `${MARKER_START}\n${canonicalJsonStringify(input)}\n${MARKER_END}`;
}

/**
 * 権限主体を分離したGitHub Issue commentだけを信頼済みhuman decisionへ変換する。
 * 呼出側が指定したactor/evidenceからreceiptを構築する入口は公開しない。
 */
export class HumanApprovalAuthority {
  constructor(
    private readonly config: MutationApprovalConfig | undefined,
    private readonly origin: { repository: string; issueNumber: number },
    private readonly port: GitHubApprovalEvidencePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async verify(
    boundDecision: MutationBoundDecision,
    commentRef: GitHubApprovalCommentRef,
  ): Promise<HumanApprovalVerification> {
    const deny = (diagnostic: string): HumanApprovalVerification => ({
      ok: false,
      code: "human_gate_required",
      diagnostic,
    });
    if (!this.config || this.config.allowed_author_node_ids.length === 0) {
      return deny("mutation approval authority が設定されていません");
    }
    const originRepository = normalizeRepository(this.origin.repository);
    if (
      normalizeRepository(commentRef.repository) !== originRepository ||
      commentRef.issueNumber !== this.origin.issueNumber
    ) {
      return deny("approval comment ref がorigin Issueと一致しません");
    }

    let live: LiveGitHubApprovalEvidence;
    try {
      live = await this.port.readLiveComment(commentRef);
    } catch {
      return deny("approval commentをlive検証できません");
    }
    if (
      live.deleted ||
      normalizeRepository(live.repository) !== originRepository ||
      live.issueNumber !== this.origin.issueNumber ||
      live.commentId !== commentRef.commentId
    ) {
      return deny("approval commentのoriginまたはlifecycleが一致しません");
    }
    if (live.createdAt !== live.updatedAt) return deny("編集済みapproval commentは無効です");
    if (live.author.type !== "User") return deny("approval authorはGitHub Userに限定されます");
    if (!this.config.allowed_author_node_ids.includes(live.author.nodeId)) {
      return deny("approval authorがallowlistにありません");
    }
    if (live.viewerNodeId === live.author.nodeId) {
      return deny("CLI token principalと承認者principalを分離してください");
    }
    const block = parseMachineBlock(live.body);
    if (!block) return deny("canonical approval machine blockが一意に見つかりません");
    if (
      block.proposalId !== boundDecision.proposalId ||
      block.revision !== boundDecision.revision ||
      block.proposalFingerprint !== boundDecision.proposalFingerprint ||
      block.expiresAt !== boundDecision.expiresAt ||
      block.purpose !== boundDecision.purpose ||
      block.stepId !== boundDecision.stepId ||
      block.targetRunId !== boundDecision.targetRunId ||
      block.targetProjectRoot !== boundDecision.targetProjectRoot ||
      block.successorDescriptorFingerprint !== boundDecision.successorDescriptorFingerprint
    ) {
      return deny("approval commentがproposal bindingと一致しません");
    }
    if (Date.parse(this.now()) >= Date.parse(block.expiresAt)) {
      return deny("approval commentが期限切れです");
    }
    return {
      ok: true,
      receipt: {
        schemaVersion: "1",
        decision: block.decision,
        actor: { id: live.author.nodeId, role: "human" },
        repository: originRepository,
        issueNumber: live.issueNumber,
        commentId: live.commentId,
        bodyHash: mutationCommandFingerprint(live.body),
        commentUpdatedAt: live.updatedAt,
        verifiedAt: this.now(),
        viewerNodeId: live.viewerNodeId,
        authorityConfigFingerprint: mutationCommandFingerprint(this.config),
        boundDecision: { ...boundDecision },
      },
    };
  }
}
