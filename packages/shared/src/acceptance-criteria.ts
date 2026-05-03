import type { AcceptanceCriterion } from "./types.js";

export const ACCEPTANCE_CRITERIA_START_MARKER = "<!-- gh-gantt:acceptance-criteria:start -->";
export const ACCEPTANCE_CRITERIA_END_MARKER = "<!-- gh-gantt:acceptance-criteria:end -->";

const ACCEPTANCE_CRITERIA_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(ACCEPTANCE_CRITERIA_START_MARKER)}[\\s\\S]*?${escapeRegExp(
    ACCEPTANCE_CRITERIA_END_MARKER,
  )}\\n*`,
  "m",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

export function normalizeAcceptanceCriteria(
  criteria: readonly AcceptanceCriterion[] | undefined,
): AcceptanceCriterion[] {
  return (criteria ?? [])
    .map((criterion) => ({
      description: normalizeDescription(criterion.description),
      checked: criterion.checked,
    }))
    .filter((criterion) => criterion.description.length > 0);
}

export function parseAcceptanceCriteriaBody(body: string | null): {
  body: string | null;
  acceptance_criteria: AcceptanceCriterion[];
} {
  if (body == null) {
    return { body: null, acceptance_criteria: [] };
  }

  const match = body.match(ACCEPTANCE_CRITERIA_BLOCK_RE);
  if (!match) {
    return { body, acceptance_criteria: [] };
  }

  const criteria: AcceptanceCriterion[] = [];
  for (const line of match[0].split(/\r?\n/)) {
    const bullet = line.match(/^- \[( |x|X)\]\s+(.+)$/);
    if (!bullet) continue;
    criteria.push({
      checked: bullet[1].toLowerCase() === "x",
      description: normalizeDescription(bullet[2]),
    });
  }

  const stripped = body
    .replace(ACCEPTANCE_CRITERIA_BLOCK_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    body: stripped.length > 0 ? stripped : null,
    acceptance_criteria: normalizeAcceptanceCriteria(criteria),
  };
}

export function serializeAcceptanceCriteriaBody(
  body: string | null,
  criteria: readonly AcceptanceCriterion[] | undefined,
): string | null {
  const cleanedBody = parseAcceptanceCriteriaBody(body).body;
  const normalizedCriteria = normalizeAcceptanceCriteria(criteria);
  if (normalizedCriteria.length === 0) {
    return cleanedBody;
  }

  const block = [
    ACCEPTANCE_CRITERIA_START_MARKER,
    "## 受入基準",
    "",
    ...normalizedCriteria.map((criterion) => {
      const marker = criterion.checked ? "x" : " ";
      return `- [${marker}] ${criterion.description}`;
    }),
    ACCEPTANCE_CRITERIA_END_MARKER,
  ].join("\n");

  return cleanedBody ? `${cleanedBody.trim()}\n\n${block}` : block;
}
