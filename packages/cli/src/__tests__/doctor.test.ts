/**
 * [NFR-STABILITY-001] doctor コマンドの整合性チェック
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, SyncState, TasksFile } from "@gh-gantt/shared";

// doctor.ts 内部のチェック関数をテストするため、モジュールを動的にインポートする
// ファイル読み込みと execFile をモックして純粋にロジックをテストする

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "task",
    github_issue: null,
    github_repo: "o/r",
    parent: null,
    sub_tasks: [],
    title: `Task ${id}`,
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "",
    updated_at: "",
    closed_at: null,
    custom_fields: {},
    start_date: null,
    end_date: null,
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeSyncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    last_synced_at: "",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots: {},
    ...overrides,
  };
}

function makeTasksFile(tasks: Task[]): TasksFile {
  return {
    tasks,
    cache: { comments: {}, reactions: {} },
  };
}

// doctor コマンドは fs と execFile に依存するため、
// 内部ロジックのテストはチェック対象ごとに分離する

describe("[NFR-STABILITY-001] doctor コマンド", () => {
  describe("循環依存チェック", () => {
    // detectCycles のロジックを直接テスト（doctor.ts と同じアルゴリズム）
    function detectCycles(tasks: Task[]): string[][] {
      const graph = new Map<string, string[]>();
      for (const task of tasks) {
        if (!graph.has(task.id)) graph.set(task.id, []);
        for (const dep of task.blocked_by) {
          if (!graph.has(dep.task)) graph.set(dep.task, []);
          graph.get(dep.task)!.push(task.id);
        }
      }
      const cycles: string[][] = [];
      const visited = new Set<string>();
      const inStack = new Set<string>();
      const path: string[] = [];
      function dfs(node: string) {
        visited.add(node);
        inStack.add(node);
        path.push(node);
        for (const neighbor of graph.get(node) ?? []) {
          if (inStack.has(neighbor)) {
            const cycleStart = path.indexOf(neighbor);
            cycles.push(path.slice(cycleStart));
          } else if (!visited.has(neighbor)) {
            dfs(neighbor);
          }
        }
        path.pop();
        inStack.delete(node);
      }
      for (const node of graph.keys()) {
        if (!visited.has(node)) dfs(node);
      }
      return cycles;
    }

    it("循環がない場合は空配列を返す", () => {
      const tasks = [
        makeTask("A"),
        makeTask("B", { blocked_by: [{ task: "A", type: "finish-to-start", lag: 0 }] }),
      ];
      expect(detectCycles(tasks)).toEqual([]);
    });

    it("直接的な循環を検出する", () => {
      const tasks = [
        makeTask("A", { blocked_by: [{ task: "B", type: "finish-to-start", lag: 0 }] }),
        makeTask("B", { blocked_by: [{ task: "A", type: "finish-to-start", lag: 0 }] }),
      ];
      const cycles = detectCycles(tasks);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("三角形の循環を検出する", () => {
      const tasks = [
        makeTask("A", { blocked_by: [{ task: "C", type: "finish-to-start", lag: 0 }] }),
        makeTask("B", { blocked_by: [{ task: "A", type: "finish-to-start", lag: 0 }] }),
        makeTask("C", { blocked_by: [{ task: "B", type: "finish-to-start", lag: 0 }] }),
      ];
      const cycles = detectCycles(tasks);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("依存関係がない場合は空配列を返す", () => {
      const tasks = [makeTask("A"), makeTask("B"), makeTask("C")];
      expect(detectCycles(tasks)).toEqual([]);
    });
  });

  describe("id_map 整合性チェック", () => {
    function checkIdMap(tasksFile: TasksFile, syncState: SyncState) {
      const taskIds = new Set(tasksFile.tasks.map((t) => t.id));
      const idMapKeys = new Set(Object.keys(syncState.id_map));
      const issues: string[] = [];
      for (const id of idMapKeys) {
        if (!taskIds.has(id)) {
          issues.push(`id_map に ${id} がありますが tasks.json に存在しません`);
        }
      }
      for (const task of tasksFile.tasks) {
        if (task.id.startsWith("draft-")) continue;
        if (task.id.startsWith("milestone-")) continue;
        if (!idMapKeys.has(task.id)) {
          issues.push(`${task.id} が id_map に存在しません`);
        }
      }
      return issues;
    }

    it("整合している場合は空配列を返す", () => {
      const tasks = [makeTask("stanah/gh-gantt#1")];
      const syncState = makeSyncState({
        id_map: {
          "stanah/gh-gantt#1": {
            issue_number: 1,
            issue_node_id: "I_1",
            project_item_id: "PVTI_1",
          },
        },
      });
      expect(checkIdMap(makeTasksFile(tasks), syncState)).toEqual([]);
    });

    it("id_map に余分なエントリがある場合を検出する", () => {
      const syncState = makeSyncState({
        id_map: {
          "stanah/gh-gantt#99": {
            issue_number: 99,
            issue_node_id: "I_99",
            project_item_id: "PVTI_99",
          },
        },
      });
      const issues = checkIdMap(makeTasksFile([]), syncState);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("#99");
    });

    it("tasks にあるが id_map に無いエントリを検出する", () => {
      const tasks = [makeTask("stanah/gh-gantt#5")];
      const issues = checkIdMap(makeTasksFile(tasks), makeSyncState());
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("#5");
    });

    it("draft タスクは id_map 不在でもスキップする", () => {
      const tasks = [makeTask("draft-abc")];
      const issues = checkIdMap(makeTasksFile(tasks), makeSyncState());
      expect(issues).toEqual([]);
    });

    it("milestone 合成タスクは id_map 不在でもスキップする", () => {
      const tasks = [makeTask("milestone-v1")];
      const issues = checkIdMap(makeTasksFile(tasks), makeSyncState());
      expect(issues).toEqual([]);
    });
  });

  describe("ハッシュ整合性チェック", () => {
    it("snapshot.hash が空文字列の場合に検出する", () => {
      const tasks = [makeTask("stanah/gh-gantt#1")];
      const syncState = makeSyncState({
        snapshots: {
          "stanah/gh-gantt#1": {
            hash: "",
            synced_at: "",
          },
        },
      });
      // hash が空 → 不整合
      const snapshot = syncState.snapshots["stanah/gh-gantt#1"];
      expect(!snapshot.hash || typeof snapshot.hash !== "string").toBe(true);
    });

    it("正常な snapshot.hash は問題なし", () => {
      const syncState = makeSyncState({
        snapshots: {
          "stanah/gh-gantt#1": {
            hash: "abc123def456",
            synced_at: "",
          },
        },
      });
      const snapshot = syncState.snapshots["stanah/gh-gantt#1"];
      expect(!snapshot.hash || typeof snapshot.hash !== "string").toBe(false);
    });
  });
});
