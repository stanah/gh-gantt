export interface ManagedBlockMatch {
  block: string;
  content: string;
  body: string | null;
}

export function extractManagedBlock(
  body: string,
  startMarker: string,
  endMarker: string,
): ManagedBlockMatch | null {
  const lowerBody = body.toLowerCase();
  const lowerStartMarker = startMarker.toLowerCase();
  const lowerEndMarker = endMarker.toLowerCase();
  const markerStart = lowerBody.indexOf(lowerStartMarker);
  if (markerStart < 0) return null;

  const contentStart = markerStart + startMarker.length;
  const markerEnd = lowerBody.indexOf(lowerEndMarker, contentStart);
  if (markerEnd < 0) return null;

  const contentEnd = markerEnd;
  const markerEndAfter = markerEnd + endMarker.length;
  let blockStart = markerStart;
  while (blockStart > 0 && (body[blockStart - 1] === "\n" || body[blockStart - 1] === "\r")) {
    blockStart -= 1;
  }

  let blockEnd = markerEndAfter;
  while (blockEnd < body.length && (body[blockEnd] === "\n" || body[blockEnd] === "\r")) {
    blockEnd += 1;
  }

  const stripped = `${body.slice(0, blockStart)}\n${body.slice(blockEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    block: body.slice(markerStart, markerEndAfter),
    content: body.slice(contentStart, contentEnd),
    body: stripped.length > 0 ? stripped : null,
  };
}

export function splitManagedLine(line: string): { key: string; value: string } | null {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 0) return null;

  const key = line.slice(0, separatorIndex).trim().toLowerCase();
  if (key.length === 0) return null;

  return {
    key,
    value: line.slice(separatorIndex + 1).trim(),
  };
}
