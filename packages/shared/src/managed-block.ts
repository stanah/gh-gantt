export interface ManagedBlockMatch {
  block: string;
  content: string;
  body: string | null;
}

function asciiLowerCode(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function markerMatchesAt(body: string, marker: string, index: number): boolean {
  if (index + marker.length > body.length) return false;

  for (let i = 0; i < marker.length; i += 1) {
    if (asciiLowerCode(body.charCodeAt(index + i)) !== asciiLowerCode(marker.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function indexOfMarker(body: string, marker: string, fromIndex = 0): number {
  for (let i = Math.max(0, fromIndex); i <= body.length - marker.length; i += 1) {
    if (markerMatchesAt(body, marker, i)) return i;
  }
  return -1;
}

export function extractManagedBlock(
  body: string,
  startMarker: string,
  endMarker: string,
): ManagedBlockMatch | null {
  const markerStart = indexOfMarker(body, startMarker);
  if (markerStart < 0) return null;

  const contentStart = markerStart + startMarker.length;
  const markerEnd = indexOfMarker(body, endMarker, contentStart);
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
