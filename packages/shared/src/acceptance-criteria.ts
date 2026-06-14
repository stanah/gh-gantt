import type { AcceptanceCriterion } from "./types.js";
import { extractManagedBlock } from "./managed-block.js";

export const ACCEPTANCE_CRITERIA_START_MARKER = "<!-- gh-gantt:acceptance-criteria:start -->";
export const ACCEPTANCE_CRITERIA_END_MARKER = "<!-- gh-gantt:acceptance-criteria:end -->";

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

export function hasAcceptanceCriteriaBlock(body: string | null): boolean {
  return (
    body != null &&
    extractManagedBlock(body, ACCEPTANCE_CRITERIA_START_MARKER, ACCEPTANCE_CRITERIA_END_MARKER) !=
      null
  );
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

function parseAcceptanceCriterionLine(line: string): AcceptanceCriterion | null {
  if (!line.startsWith("- [") || line[4] !== "]") return null;
  const marker = line[3];
  if (marker !== " " && marker !== "x" && marker !== "X") return null;
  if (line.length <= 5 || !/\s/.test(line[5])) return null;

  let descriptionStart = 5;
  while (descriptionStart < line.length && /\s/.test(line[descriptionStart])) {
    descriptionStart += 1;
  }

  return {
    checked: marker.toLowerCase() === "x",
    description: normalizeDescription(line.slice(descriptionStart)),
  };
}

export function parseAcceptanceCriteriaBody(body: string | null): {
  body: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  has_acceptance_criteria_block: boolean;
} {
  if (body == null) {
    return { body: null, acceptance_criteria: [], has_acceptance_criteria_block: false };
  }

  const block = extractManagedBlock(
    body,
    ACCEPTANCE_CRITERIA_START_MARKER,
    ACCEPTANCE_CRITERIA_END_MARKER,
  );
  if (!block) {
    return { body, acceptance_criteria: [], has_acceptance_criteria_block: false };
  }

  const criteria: AcceptanceCriterion[] = [];
  for (const line of block.content.split(/\r?\n/)) {
    const criterion = parseAcceptanceCriterionLine(line);
    if (criterion) criteria.push(criterion);
  }

  return {
    body: block.body,
    acceptance_criteria: normalizeAcceptanceCriteria(criteria),
    has_acceptance_criteria_block: true,
  };
}

export interface SerializeAcceptanceCriteriaBodyOptions {
  includeEmptyBlock?: boolean;
}

export function renderAcceptanceCriteriaBlock(
  criteria: readonly AcceptanceCriterion[] | undefined,
): string {
  return renderNormalizedAcceptanceCriteriaBlock(normalizeAcceptanceCriteria(criteria));
}

function renderNormalizedAcceptanceCriteriaBlock(
  normalizedCriteria: readonly AcceptanceCriterion[],
): string {
  return [
    ACCEPTANCE_CRITERIA_START_MARKER,
    "## 受入基準",
    "",
    ...normalizedCriteria.map((criterion) => {
      const marker = criterion.checked ? "x" : " ";
      return `- [${marker}] ${criterion.description}`;
    }),
    ACCEPTANCE_CRITERIA_END_MARKER,
  ].join("\n");
}

export function serializeAcceptanceCriteriaBody(
  body: string | null,
  criteria: readonly AcceptanceCriterion[] | undefined,
  options: SerializeAcceptanceCriteriaBodyOptions = {},
): string | null {
  const cleanedBody = parseAcceptanceCriteriaBody(body).body;
  const normalizedCriteria = normalizeAcceptanceCriteria(criteria);
  const shouldIncludeBlock =
    normalizedCriteria.length > 0 ||
    options.includeEmptyBlock === true ||
    hasAcceptanceCriteriaBlock(body);
  if (!shouldIncludeBlock) {
    return cleanedBody;
  }

  const block = renderNormalizedAcceptanceCriteriaBlock(normalizedCriteria);

  return cleanedBody ? `${cleanedBody.trim()}\n\n${block}` : block;
}
