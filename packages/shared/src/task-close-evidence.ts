export const TASK_CLOSE_EVIDENCE_START_MARKER = "<!-- gh-gantt:close-evidence:start -->";
export const TASK_CLOSE_EVIDENCE_END_MARKER = "<!-- gh-gantt:close-evidence:end -->";

const TASK_CLOSE_EVIDENCE_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(TASK_CLOSE_EVIDENCE_START_MARKER)}[\\s\\S]*?${escapeRegExp(
    TASK_CLOSE_EVIDENCE_END_MARKER,
  )}\\n*`,
  "im",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  const match = body.match(TASK_CLOSE_EVIDENCE_BLOCK_RE);
  if (!match) {
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
  const endMarker = TASK_CLOSE_EVIDENCE_END_MARKER.toLowerCase();
  for (const line of match[0].split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.toLowerCase() === endMarker) break;
    if (collectingEvidence) {
      evidenceLines.push(line);
      continue;
    }
    const recordedAtLine = line.match(/^Recorded-At:\s*(.*)$/i);
    if (recordedAtLine) {
      recordedAt = recordedAtLine[1].trim() || null;
      continue;
    }
    if (/^Evidence:\s*$/i.test(trimmedLine)) {
      collectingEvidence = true;
    }
  }

  const stripped = body
    .replace(TASK_CLOSE_EVIDENCE_BLOCK_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const evidence = evidenceLines.join("\n").trim();

  return {
    body: stripped.length > 0 ? stripped : null,
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
