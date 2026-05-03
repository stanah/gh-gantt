import { normalizeTaskRoleLogin } from "./task-roles.js";

export const TASK_REVIEW_START_MARKER = "<!-- gh-gantt:review:start -->";
export const TASK_REVIEW_END_MARKER = "<!-- gh-gantt:review:end -->";

const TASK_REVIEW_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(TASK_REVIEW_START_MARKER)}[\\s\\S]*?${escapeRegExp(
    TASK_REVIEW_END_MARKER,
  )}\\n*`,
  "m",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBoolean(value: string): boolean {
  return /^(true|yes|1)$/i.test(value.trim());
}

export function parseTaskReviewBody(body: string | null): {
  body: string | null;
  require_review: boolean;
  review_approved_by: string | null;
  review_approved_at: string | null;
  has_review_block: boolean;
} {
  if (body == null) {
    return {
      body: null,
      require_review: false,
      review_approved_by: null,
      review_approved_at: null,
      has_review_block: false,
    };
  }

  const match = body.match(TASK_REVIEW_BLOCK_RE);
  if (!match) {
    return {
      body,
      require_review: false,
      review_approved_by: null,
      review_approved_at: null,
      has_review_block: false,
    };
  }

  let requireReview = false;
  let reviewApprovedBy: string | null = null;
  let reviewApprovedAt: string | null = null;
  for (const line of match[0].split(/\r?\n/)) {
    const reviewLine = line.match(
      /^(Require-Review|Review-Approved-By|Review-Approved-At):\s*(.*)$/i,
    );
    if (!reviewLine) continue;
    const key = reviewLine[1].toLowerCase();
    const value = reviewLine[2].trim();
    if (key === "require-review") {
      requireReview = parseBoolean(value);
    } else if (key === "review-approved-by") {
      reviewApprovedBy = normalizeTaskRoleLogin(value);
    } else {
      reviewApprovedAt = value.length > 0 ? value : null;
    }
  }

  const stripped = body
    .replace(TASK_REVIEW_BLOCK_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    body: stripped.length > 0 ? stripped : null,
    require_review: requireReview,
    review_approved_by: reviewApprovedBy,
    review_approved_at: reviewApprovedAt,
    has_review_block: true,
  };
}

export function renderTaskReviewBlock(review: {
  require_review?: boolean;
  review_approved_by?: string | null;
  review_approved_at?: string | null;
}): string | null {
  const requireReview = review.require_review === true;
  const reviewApprovedBy = normalizeTaskRoleLogin(review.review_approved_by);
  const reviewApprovedAt = review.review_approved_at?.trim() || null;
  if (!requireReview && !reviewApprovedBy && !reviewApprovedAt) {
    return null;
  }

  const lines = [TASK_REVIEW_START_MARKER];
  if (requireReview) lines.push("Require-Review: true");
  if (reviewApprovedBy) lines.push(`Review-Approved-By: @${reviewApprovedBy}`);
  if (reviewApprovedAt) lines.push(`Review-Approved-At: ${reviewApprovedAt}`);
  lines.push(TASK_REVIEW_END_MARKER);
  return lines.join("\n");
}

export function serializeTaskReviewBody(
  body: string | null,
  review: {
    require_review?: boolean;
    review_approved_by?: string | null;
    review_approved_at?: string | null;
  },
): string | null {
  const cleanedBody = parseTaskReviewBody(body).body;
  const block = renderTaskReviewBlock(review);
  if (!block) {
    return cleanedBody;
  }

  return cleanedBody ? `${cleanedBody.trim()}\n\n${block}` : block;
}
