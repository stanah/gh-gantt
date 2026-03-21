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
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLI = join(__dirname, "../../dist/index.js");
const TEST_DIR = "/tmp/gh-gantt-e2e";
const GANTT_DIR = join(TEST_DIR, ".gantt-sync");
const REPO = "stanah/gh-gantt-e2e-test";
const PROJECT_NUMBER = "4";

function run(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { cwd: TEST_DIR, encoding: "utf-8", timeout: 30000 }).trim();
  } catch (err: any) {
    return ((err.stdout as string) ?? "") + ((err.stderr as string) ?? "");
  }
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

describe("E2E sync engine", () => {
  beforeAll(() => {
    if (existsSync(GANTT_DIR)) {
      rmSync(GANTT_DIR, { recursive: true });
    }
    const output = ghGantt(["init", "--owner", "stanah", "--repo", "gh-gantt-e2e-test", "--project", PROJECT_NUMBER]);
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

    const issueState = gh(["issue", "view", "1", "--repo", REPO, "--json", "state", "-q", ".state"]);
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

  it("push after resolve succeeds", () => {
    const output = ghGantt(["push", "--yes"]);
    expect(output).not.toContain("未解決のコンフリクトがあります");
  }, 30000);

  // Restore issue #2 title
  it("restore: reset issue #2 title", () => {
    gh(["issue", "edit", "2", "--repo", REPO, "--title", "Task B: コンフリクトテスト用"]);
    ghGantt(["pull"]);
  }, 30000);

  // #15: remote deleted + local unchanged = deleted
  it("#15: remotely deleted task (local unchanged) is removed", () => {
    const beforeTasks = readTasks();
    const taskC = findTask(beforeTasks.tasks, 3);
    expect(taskC).toBeDefined();

    // Remove issue #3 from project
    const itemsJson = gh(["project", "item-list", PROJECT_NUMBER, "--owner", "stanah", "--format", "json"]);
    const items = JSON.parse(itemsJson);
    const item3 = items.items.find((i: any) => i.content?.number === 3);
    if (item3) {
      gh(["project", "item-delete", PROJECT_NUMBER, "--owner", "stanah", "--id", item3.id]);
    }

    ghGantt(["pull"]);

    const afterTasks = readTasks();
    const taskCAfter = findTask(afterTasks.tasks, 3);
    expect(taskCAfter).toBeUndefined();
  }, 30000);

  // #16: remote deleted + local changed = kept
  it("#16: remotely deleted task (local changed) is kept", () => {
    // Re-add issue #3 to project and verify it's in the project before pulling
    gh(["project", "item-add", PROJECT_NUMBER, "--owner", "stanah", "--url", `https://github.com/${REPO}/issues/3`]);
    // Wait for GitHub API propagation and verify item count
    let retries = 5;
    while (retries > 0) {
      execFileSync("sleep", ["2"]);
      const itemsCheck = gh(["project", "item-list", PROJECT_NUMBER, "--owner", "stanah", "--format", "json"]);
      const itemCount = JSON.parse(itemsCheck).items.length;
      if (itemCount >= 3) break;
      retries--;
    }
    const pullOutput = ghGantt(["pull"]);

    // Verify task #3 is back
    let tasksFile = readTasks();
    let task = findTask(tasksFile.tasks, 3);
    if (!task) {
      throw new Error(`Task #3 not found after re-add + pull. Pull output: ${pullOutput}`);
    }

    // Now modify locally
    task.title = "Task C: ローカル変更あり";
    writeTasks(tasksFile);

    // Remove from project again and wait for propagation
    const itemsJson = gh(["project", "item-list", PROJECT_NUMBER, "--owner", "stanah", "--format", "json"]);
    const items = JSON.parse(itemsJson);
    const item3 = items.items.find((i: any) => i.content?.number === 3);
    if (item3) {
      gh(["project", "item-delete", PROJECT_NUMBER, "--owner", "stanah", "--id", item3.id]);
    }
    // Wait for deletion to propagate
    let deleteRetries = 5;
    while (deleteRetries > 0) {
      execFileSync("sleep", ["2"]);
      const checkItems = gh(["project", "item-list", PROJECT_NUMBER, "--owner", "stanah", "--format", "json"]);
      const count = JSON.parse(checkItems).items.length;
      if (count <= 2) break;
      deleteRetries--;
    }

    const output = ghGantt(["pull"]);
    expect(output).toContain("locally modified but removed from remote");

    const afterTasks = readTasks();
    const taskAfter = findTask(afterTasks.tasks, 3);
    expect(taskAfter).toBeDefined();
    expect(taskAfter.title).toBe("Task C: ローカル変更あり");
  }, 30000);
});
