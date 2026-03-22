/**
 * E2E tests for the sync engine against a real GitHub Project.
 *
 * Prerequisites:
 *   - Private repo: stanah/gh-gantt-e2e-test
 *   - GitHub Project #4: "gh-gantt E2E Test"
 *   - gh auth token must be valid
 *
 * These tests run sequentially and modify real GitHub state.
 * Run with: pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/e2e-sync.test.ts --timeout 60000
 *
 * Checklist items tested (from sync-git-model-checklist.md):
 *   #1  pull is always possible
 *   #2  pull with local changes — merge works
 *   #5  status shows changes
 *   #6  3-way merge auto-merges non-conflicting fields
 *   #7  conflict markers written for conflicting fields
 *   #8  conflicts command shows unresolved conflicts
 *   #9  resolve command resolves conflicts
 *   #10 pull blocked when conflicts unresolved
 *   #11 push blocked when conflicts unresolved
 *   #12 local changes remain pushable after pull
 *   #13 non-conflicting local changes pushable after pull
 *   #15 remote deleted + local unchanged = deleted
 *   #16 remote deleted + local changed = kept
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLI = join(__dirname, "../../dist/index.js");
const TEST_DIR = "/tmp/gh-gantt-e2e";
const GANTT_DIR = join(TEST_DIR, ".gantt-sync");
const REPO = "stanah/gh-gantt-e2e-test";
const PROJECT_NUMBER = "4";

function run(file: string, args: string[]): string {
  try {
    // Capture both stdout and stderr (warnings go to stderr)
    const result = execFileSync(file, args, {
      cwd: TEST_DIR,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch (err: any) {
    return ((err.stdout as string) ?? "") + ((err.stderr as string) ?? "");
  }
}

/** Run and capture both stdout and stderr */
function runWithStderr(file: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    cwd: TEST_DIR,
    encoding: "utf-8",
    timeout: 30000,
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function ghGantt(args: string[]): string {
  return run("node", [CLI, ...args]);
}

function gh(args: string[]): string {
  return run("gh", args);
}

function readTasks(): any {
  return JSON.parse(readFileSync(join(GANTT_DIR, "tasks.json"), "utf-8"));
}

function writeTasks(data: any): void {
  writeFileSync(join(GANTT_DIR, "tasks.json"), JSON.stringify(data, null, 2) + "\n");
}

function readSyncState(): any {
  return JSON.parse(readFileSync(join(GANTT_DIR, "sync-state.json"), "utf-8"));
}

function findTask(tasks: any[], issueNumber: number): any {
  return tasks.find((t: any) => t.github_issue === issueNumber);
}

/** Wait until project has exactly expectedCount items (with extra delay for GraphQL propagation) */
function waitForProjectItemCount(expectedCount: number, maxRetries = 10): void {
  for (let i = 0; i < maxRetries; i++) {
    execFileSync("sleep", ["3"]);
    const json = gh([
      "project",
      "item-list",
      PROJECT_NUMBER,
      "--owner",
      "stanah",
      "--format",
      "json",
    ]);
    const count = JSON.parse(json).items.length;
    if (count === expectedCount) {
      // Extra wait for GraphQL API propagation (REST and GraphQL may not be in sync)
      execFileSync("sleep", ["3"]);
      return;
    }
  }
}

/** Ensure issue is in the project and visible to pull (GraphQL propagation) */
function ensureInProject(issueNumber: number): void {
  const json = gh([
    "project",
    "item-list",
    PROJECT_NUMBER,
    "--owner",
    "stanah",
    "--format",
    "json",
  ]);
  const items = JSON.parse(json).items;
  const found = items.find((i: any) => i.content?.number === issueNumber);
  if (!found) {
    gh([
      "project",
      "item-add",
      PROJECT_NUMBER,
      "--owner",
      "stanah",
      "--url",
      `https://github.com/${REPO}/issues/${issueNumber}`,
    ]);
    waitForProjectItemCount(items.length + 1);
  }
  // Verify via pull --dry-run that GraphQL sees the item
  let retries = 10;
  while (retries > 0) {
    const pullOutput = ghGantt(["pull", "--dry-run"]);
    const fetchMatch = pullOutput.match(/Fetched (\d+) items/);
    const fetchedCount = fetchMatch ? parseInt(fetchMatch[1]) : 0;
    if (fetchedCount >= 3) return;
    execFileSync("sleep", ["3"]);
    retries--;
  }
}

/** Remove issue from project if present */
function removeFromProject(issueNumber: number): void {
  const json = gh([
    "project",
    "item-list",
    PROJECT_NUMBER,
    "--owner",
    "stanah",
    "--format",
    "json",
  ]);
  const items = JSON.parse(json).items;
  const found = items.find((i: any) => i.content?.number === issueNumber);
  if (found) {
    gh(["project", "item-delete", PROJECT_NUMBER, "--owner", "stanah", "--id", found.id]);
    waitForProjectItemCount(items.length - 1);
  }
}

describe("E2E sync engine", () => {
  beforeAll(() => {
    if (existsSync(GANTT_DIR)) {
      rmSync(GANTT_DIR, { recursive: true });
    }
    const output = ghGantt([
      "init",
      "--owner",
      "stanah",
      "--repo",
      "gh-gantt-e2e-test",
      "--project",
      PROJECT_NUMBER,
    ]);
    expect(output).toContain("Initialized gh-gantt");
  }, 30000);

  // #1: pull is always possible
  it("#1: pull with no changes succeeds", () => {
    const output = ghGantt(["pull"]);
    expect(output).toMatch(/Pull (summary|complete)/);
  }, 30000);

  // #5: status shows changes
  it("#5: status shows task counts", () => {
    const output = ghGantt(["status"]);
    expect(output).toContain("Local tasks:");
  }, 30000);

  // #2, #12: pull with local changes — merge works, local changes preserved
  it("#2, #12: pull with unpushed local changes succeeds and preserves them", () => {
    const tasksFile = readTasks();
    const task = findTask(tasksFile.tasks, 1);
    expect(task).toBeDefined();
    task.state = "closed";
    writeTasks(tasksFile);

    const output = ghGantt(["pull"]);
    expect(output).toContain("Pull complete.");
    expect(output).not.toContain("未pushの変更があります");

    const afterPull = readTasks();
    const taskAfter = findTask(afterPull.tasks, 1);
    expect(taskAfter.state).toBe("closed");
  }, 30000);

  // #13: push local changes to GitHub
  it("#13: push sends local changes to GitHub", () => {
    const output = ghGantt(["push", "--yes"]);
    expect(output).toContain("Push complete:");

    const issueState = gh([
      "issue",
      "view",
      "1",
      "--repo",
      REPO,
      "--json",
      "state",
      "-q",
      ".state",
    ]);
    expect(issueState).toBe("CLOSED");
  }, 30000);

  // Restore issue #1
  it("restore: reopen issue #1", () => {
    gh(["issue", "reopen", "1", "--repo", REPO]);
    ghGantt(["pull"]);
    const tasksFile = readTasks();
    const task = findTask(tasksFile.tasks, 1);
    expect(task.state).toBe("open");
  }, 30000);

  // #6, #7: 3-way merge and conflict markers
  it("#6, #7: 3-way merge with conflict produces markers", () => {
    const tasksFile = readTasks();
    const task = findTask(tasksFile.tasks, 2);
    task.title = "Task B: ローカル変更";
    writeTasks(tasksFile);

    gh(["issue", "edit", "2", "--repo", REPO, "--title", "Task B: リモート変更"]);

    const output = ghGantt(["pull"]);
    expect(output).toContain("Pull complete.");

    const afterPull = readTasks();
    expect(afterPull.has_conflicts).toBe(true);
    const conflictTask = findTask(afterPull.tasks, 2);
    expect(conflictTask.title_current).toBe("Task B: ローカル変更");
    expect(conflictTask.title_incoming).toBe("Task B: リモート変更");
  }, 30000);

  // #8: conflicts command
  it("#8: conflicts command shows unresolved conflicts", () => {
    const output = ghGantt(["conflicts"]);
    expect(output).toContain("#2");
    expect(output).toContain("title");
  }, 30000);

  // #10: pull blocked when conflicts unresolved
  it("#10: pull blocked when conflicts unresolved", () => {
    const output = ghGantt(["pull"]);
    expect(output).toContain("未解決のコンフリクトがあります");
  }, 30000);

  // #11: push blocked when conflicts unresolved
  it("#11: push blocked when conflicts unresolved", () => {
    const output = ghGantt(["push", "--yes"]);
    expect(output).toContain("未解決のコンフリクトがあります");
  }, 30000);

  // #9: resolve command
  it("#9: resolve with --theirs resolves conflict", () => {
    const output = ghGantt(["resolve", "2", "--theirs"]);
    expect(output).toContain("No conflicts.");

    const tasksFile = readTasks();
    expect(tasksFile.has_conflicts).toBeFalsy();
    const task = findTask(tasksFile.tasks, 2);
    expect(task.title).toBe("Task B: リモート変更");
    expect(task.title_current).toBeUndefined();
    expect(task.title_incoming).toBeUndefined();
  }, 30000);

  // #14: resolve → push reflects changes to GitHub
  it("#14: push after resolve sends resolved value to GitHub", () => {
    // Task #2 was resolved with --theirs (title = "Task B: リモート変更")
    const output = ghGantt(["push", "--yes"]);
    expect(output).not.toContain("未解決のコンフリクトがあります");
    expect(output).toContain("Push complete:");

    // Verify on GitHub
    const ghTitle = gh(["issue", "view", "2", "--repo", REPO, "--json", "title", "-q", ".title"]);
    expect(ghTitle).toBe("Task B: リモート変更");
  }, 30000);

  // Restore issue #2 title
  it("restore: reset issue #2 title", () => {
    gh(["issue", "edit", "2", "--repo", REPO, "--title", "Task B: コンフリクトテスト用"]);
    ghGantt(["pull"]);
  }, 30000);

  // #3: push blocked when remote has diverged
  it("#3: push blocked when remote has diverged", () => {
    // Modify task #1 locally (without pulling first)
    const tasksFile = readTasks();
    const task = findTask(tasksFile.tasks, 1);
    task.body = "local body change for #3";
    writeTasks(tasksFile);

    // Modify task #1 on GitHub (simulate concurrent remote change)
    gh(["issue", "edit", "1", "--repo", REPO, "--body", "remote body change for #3"]);

    // Wait until GraphQL returns a different updatedAt than our snapshot
    const syncState = readSyncState();
    const snapUpdatedAt = syncState.snapshots["stanah/gh-gantt-e2e-test#1"]?.updated_at;
    let remoteUpdated = false;
    for (let i = 0; i < 15; i++) {
      execFileSync("sleep", ["2"]);
      const remoteAt = gh([
        "api",
        "graphql",
        "-f",
        `query=query { repository(owner: "stanah", name: "gh-gantt-e2e-test") { issue(number: 1) { updatedAt } } }`,
        "-q",
        ".data.repository.issue.updatedAt",
      ]);
      if (remoteAt !== snapUpdatedAt) {
        remoteUpdated = true;
        break;
      }
    }
    expect(remoteUpdated).toBe(true);

    // Push without pulling first — should detect remote changed
    const { stdout, stderr } = runWithStderr("node", [CLI, "push", "--yes"]);
    const output = stdout + "\n" + stderr;
    expect(output).toContain("リモートが更新されています");
  }, 30000);

  // #4: push --force bypasses remote change check
  it("#4: push --force bypasses remote change check", () => {
    // Same state as #3 — local and remote have diverged
    const { stdout: forceOut, stderr: forceErr } = runWithStderr("node", [
      CLI,
      "push",
      "--force",
      "--yes",
    ]);
    const output = forceOut + "\n" + forceErr;
    expect(output).not.toContain("リモートが更新されています");
    expect(output).toContain("Push complete:");
  }, 30000);

  // Restore issue #1 body
  it("restore: reset issue #1 body", () => {
    gh(["issue", "edit", "1", "--repo", REPO, "--body", "E2Eテスト用タスクA"]);
    ghGantt(["pull"]);
  }, 30000);

  // #15: remote deleted + local unchanged = deleted
  it("#15: remotely deleted task (local unchanged) is removed", () => {
    // Setup: ensure #3 is in project and visible to GraphQL
    ensureInProject(3);
    // Re-init until GraphQL sees 3 tasks
    let found = false;
    for (let i = 0; i < 20; i++) {
      rmSync(GANTT_DIR, { recursive: true });
      const initOut = ghGantt([
        "init",
        "--owner",
        "stanah",
        "--repo",
        "gh-gantt-e2e-test",
        "--project",
        PROJECT_NUMBER,
      ]);
      if (initOut.includes("with 3 tasks")) {
        ghGantt(["pull"]); // Create snapshots
        found = true;
        break;
      }
      execFileSync("sleep", ["5"]);
    }
    expect(found).toBe(true);

    const beforeTasks = readTasks();
    const taskC = findTask(beforeTasks.tasks, 3);
    expect(taskC).toBeDefined();

    // Act: remove from project and pull
    removeFromProject(3);
    ghGantt(["pull"]);

    // Assert: task removed locally
    const afterTasks = readTasks();
    const taskCAfter = findTask(afterTasks.tasks, 3);
    expect(taskCAfter).toBeUndefined();
  }, 60000);

  // #16: remote deleted + local changed = kept
  it("#16: remotely deleted task (local changed) is kept", () => {
    // Setup: ensure #3 is in project and visible to GraphQL (init must see 3 tasks)
    ensureInProject(3);
    let initSuccess = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      rmSync(GANTT_DIR, { recursive: true });
      const initOutput = ghGantt([
        "init",
        "--owner",
        "stanah",
        "--repo",
        "gh-gantt-e2e-test",
        "--project",
        PROJECT_NUMBER,
      ]);
      if (initOutput.includes("with 3 tasks")) {
        ghGantt(["pull"]); // Creates snapshots
        initSuccess = true;
        break;
      }
      execFileSync("sleep", ["5"]);
    }
    if (!initSuccess) throw new Error("Setup failed: init never saw 3 tasks from GraphQL");

    const tasksFile = readTasks();
    const task = findTask(tasksFile.tasks, 3)!;

    // Act: modify locally then remove from project
    task.title = "Task C: ローカル変更あり";
    writeTasks(tasksFile);

    removeFromProject(3);
    const { stdout, stderr } = runWithStderr("node", [CLI, "pull"]);
    const output = stdout + "\n" + stderr;

    // Assert: task kept with warning (warning goes to stderr)
    expect(output).toContain("locally modified but removed from remote");

    const afterTasks = readTasks();
    const taskAfter = findTask(afterTasks.tasks, 3);
    expect(taskAfter).toBeDefined();
    expect(taskAfter.title).toBe("Task C: ローカル変更あり");
  }, 120000);
});
