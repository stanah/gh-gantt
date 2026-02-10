import type { Config } from "@gh-gantt/shared";

export function resolveTaskId(input: string, config: Config): string {
  const { owner, repo } = config.project.github;
  const repoFullName = `${owner}/${repo}`;

  // Already fully qualified: owner/repo#6
  if (input.includes("/") && input.includes("#")) {
    return input;
  }

  // #6 or just 6
  const stripped = input.startsWith("#") ? input.slice(1) : input;

  // draft-1 format
  if (stripped.startsWith("draft-")) {
    return `${repoFullName}#${stripped}`;
  }

  // Numeric
  if (/^\d+$/.test(stripped)) {
    return `${repoFullName}#${stripped}`;
  }

  // Fallback: treat as-is with repo prefix
  return `${repoFullName}#${stripped}`;
}
