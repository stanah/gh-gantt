const REPOSITORY_SELECTION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
] as const;

/** raw Git fixture を指定した repository へ隔離し、hook の他環境は維持する。 */
export function gitFixtureEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of REPOSITORY_SELECTION_VARIABLES) delete environment[name];
  return environment;
}
