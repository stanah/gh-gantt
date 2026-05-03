export const TASK_ROLES_START_MARKER = "<!-- gh-gantt:roles:start -->";
export const TASK_ROLES_END_MARKER = "<!-- gh-gantt:roles:end -->";

const TASK_ROLES_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(TASK_ROLES_START_MARKER)}[\\s\\S]*?${escapeRegExp(
    TASK_ROLES_END_MARKER,
  )}\\n*`,
  "m",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTaskRoleLogin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") {
    return null;
  }
  const withoutMention = trimmed.replace(/^@+/, "").trim();
  return withoutMention.length > 0 ? withoutMention : null;
}

export function parseTaskRolesBody(body: string | null): {
  body: string | null;
  implementer: string | null;
  reviewer: string | null;
  has_roles_block: boolean;
} {
  if (body == null) {
    return { body: null, implementer: null, reviewer: null, has_roles_block: false };
  }

  const match = body.match(TASK_ROLES_BLOCK_RE);
  if (!match) {
    return { body, implementer: null, reviewer: null, has_roles_block: false };
  }

  let implementer: string | null = null;
  let reviewer: string | null = null;
  for (const line of match[0].split(/\r?\n/)) {
    const roleLine = line.match(/^(Implementer|Reviewer):\s*(.*)$/i);
    if (!roleLine) continue;
    if (roleLine[1].toLowerCase() === "implementer") {
      implementer = normalizeTaskRoleLogin(roleLine[2]);
    } else {
      reviewer = normalizeTaskRoleLogin(roleLine[2]);
    }
  }

  const stripped = body
    .replace(TASK_ROLES_BLOCK_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    body: stripped.length > 0 ? stripped : null,
    implementer,
    reviewer,
    has_roles_block: true,
  };
}

export function renderTaskRolesBlock(roles: {
  implementer?: string | null;
  reviewer?: string | null;
}): string | null {
  const implementer = normalizeTaskRoleLogin(roles.implementer);
  const reviewer = normalizeTaskRoleLogin(roles.reviewer);
  if (!implementer && !reviewer) {
    return null;
  }

  const lines = [TASK_ROLES_START_MARKER];
  if (implementer) lines.push(`Implementer: @${implementer}`);
  if (reviewer) lines.push(`Reviewer: @${reviewer}`);
  lines.push(TASK_ROLES_END_MARKER);
  return lines.join("\n");
}

export function serializeTaskRolesBody(
  body: string | null,
  roles: {
    implementer?: string | null;
    reviewer?: string | null;
  },
): string | null {
  const cleanedBody = parseTaskRolesBody(body).body;
  const block = renderTaskRolesBlock(roles);
  if (!block) {
    return cleanedBody;
  }

  return cleanedBody ? `${cleanedBody.trim()}\n\n${block}` : block;
}
