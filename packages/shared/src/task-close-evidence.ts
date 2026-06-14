import { extractManagedBlock, splitManagedLine } from "./managed-block.js";

export const TASK_CLOSE_EVIDENCE_START_MARKER = "<!-- gh-gantt:close-evidence:start -->";
export const TASK_CLOSE_EVIDENCE_END_MARKER = "<!-- gh-gantt:close-evidence:end -->";

export function parseTaskCloseEvidenceBody(body: string | null): {
  body: string | null;
  evidence: string | null;
  recorded_at: string | null;
  has_close_evidence_block: boolean;
} {
  if (body == null) {
    return {
      body: null,
      evidence: null,
      recorded_at: null,
      has_close_evidence_block: false,
    };
  }

  const block = extractManagedBlock(
    body,
    TASK_CLOSE_EVIDENCE_START_MARKER,
    TASK_CLOSE_EVIDENCE_END_MARKER,
  );
  if (!block) {
    return {
      body,
      evidence: null,
      recorded_at: null,
      has_close_evidence_block: false,
    };
  }

  let recordedAt: string | null = null;
  let collectingEvidence = false;
  const evidenceLines: string[] = [];
  for (const line of block.content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (collectingEvidence) {
      evidenceLines.push(line);
      continue;
    }
    const managedLine = splitManagedLine(line);
    if (managedLine?.key === "recorded-at") {
      recordedAt = managedLine.value || null;
      continue;
    }
    if (trimmedLine.toLowerCase() === "evidence:") {
      collectingEvidence = true;
    }
  }

  const evidence = evidenceLines.join("\n").trim();

  return {
    body: block.body,
    evidence: evidence.length > 0 ? evidence : null,
    recorded_at: recordedAt,
    has_close_evidence_block: true,
  };
}

export function renderTaskCloseEvidenceBlock(evidence: string, recordedAt: string): string | null {
  const trimmedEvidence = evidence.trim();
  const trimmedRecordedAt = recordedAt.trim();
  if (trimmedEvidence.length === 0 || trimmedRecordedAt.length === 0) {
    return null;
  }

  return [
    TASK_CLOSE_EVIDENCE_START_MARKER,
    "## 完了証跡",
    "",
    `Recorded-At: ${trimmedRecordedAt}`,
    "Evidence:",
    trimmedEvidence,
    TASK_CLOSE_EVIDENCE_END_MARKER,
  ].join("\n");
}

export function serializeTaskCloseEvidenceBody(
  body: string | null,
  evidence: string | null | undefined,
  recordedAt: string,
): string | null {
  const cleanedBody = parseTaskCloseEvidenceBody(body).body;
  const block = renderTaskCloseEvidenceBlock(evidence ?? "", recordedAt);
  if (!block) {
    return cleanedBody;
  }

  return cleanedBody ? `${cleanedBody.trim()}\n\n${block}` : block;
}
