import { withResolvedGitPath } from "./git-executable.js";

const GIT_REPOSITORY_SELECTION_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

/** projectRoot を正本とし、Git 診断を安定した英語へ固定する subprocess 環境。 */
export function gitCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of GIT_REPOSITORY_SELECTION_VARIABLES) delete environment[name];
  environment.LC_ALL = "C";
  return withResolvedGitPath(environment);
}

/** `LC_ALL=C` で実行した Git subprocess の non-repository 診断を判定する。 */
export function isNotGitRepositoryError(error: unknown): boolean {
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  return stderr.includes("not a git repository") || stderr.includes("not a git work tree");
}
