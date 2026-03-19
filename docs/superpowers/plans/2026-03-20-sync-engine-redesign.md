# Sync Engine Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** git モデルに準拠したフィールド単位 3-way merge で同期エンジンを再設計し、ローカル編集が暗黙的に失われないようにする

**Architecture:** snapshot (前回同期時点) を base として、ローカルとリモートのフィールド単位 3-way merge を行う。コンフリクトは `_current` / `_incoming` マーカーとして `tasks.json` に記録し、`resolve` コマンドで解決する。push/pull にガードを追加し、未解決コンフリクトや未push変更がある場合は操作を中断する。

**Tech Stack:** TypeScript, Zod, Commander.js, Vitest

**Spec:** `docs/superpowers/specs/2026-03-20-sync-engine-redesign.md`

---

## File Structure

### 新規作成

| File | Responsibility |
|------|---------------|
| `packages/cli/src/sync/three-way-merge.ts` | フィールド単位 3-way merge ロジック |
| `packages/cli/src/sync/conflict-marker.ts` | JSON コンフリクトマーカーの読み書き・検出・解決 |
| `packages/cli/src/commands/conflicts.ts` | `gh-gantt conflicts` コマンド |
| `packages/cli/src/commands/resolve.ts` | `gh-gantt resolve` コマンド |
| `packages/cli/src/__tests__/three-way-merge.test.ts` | 3-way merge 単体テスト |
| `packages/cli/src/__tests__/conflict-marker.test.ts` | マーカー操作 単体テスト |
| `packages/cli/src/__tests__/conflicts-command.test.ts` | conflicts コマンド テスト |
| `packages/cli/src/__tests__/resolve-command.test.ts` | resolve コマンド テスト |
| `packages/cli/src/__tests__/pull-guards.test.ts` | pull ガード統合テスト |
| `.claude/skills/conflict-resolution/SKILL.md` | AI コンフリクト解決スキル |

### 改修

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | `ConflictStrategy` 削除、`TasksFile` に `has_conflicts` 追加 |
| `packages/shared/src/schema.ts` | `TasksFileWithConflictsSchema` 追加、`ConflictStrategySchema` 削除、`ConfigSchema` から `conflict_strategy` 削除 |
| `packages/cli/src/store/tasks.ts` | `WithConflicts` スキーマ対応 |
| `packages/cli/src/sync/mapper.ts` | `mergeRemoteIntoLocal` 削除 |
| `packages/cli/src/commands/pull.ts` | 未push変更ガード、3-way merge 統合 |
| `packages/cli/src/commands/push.ts` | マーカーチェック、`--force` オプション追加 |
| `packages/cli/src/sync/push-executor.ts` | リモート変更チェックロジック |
| `packages/cli/src/commands/init.ts:143` | `conflict_strategy` をデフォルト config から削除 |
| `packages/cli/src/index.ts` | conflicts / resolve コマンド登録 |

### 削除

| File | Reason |
|------|--------|
| `packages/cli/src/sync/conflict.ts` | `three-way-merge.ts` + `conflict-marker.ts` に置き換え |
| `packages/cli/src/__tests__/conflict.test.ts` | 対応する新テストに置き換え |
| `packages/cli/src/__tests__/pull-conflicts.test.ts` | pull 統合テストに置き換え |

---

## Task 1: shared 型とスキーマの更新

**Files:**
- Modify: `packages/shared/src/types.ts:3,60-66,74-83`
- Modify: `packages/shared/src/schema.ts:5,66-100,102-112,150`
- Test: `packages/shared/src/__tests__/schema.test.ts`

- [ ] **Step 1: types.ts の変更内容を確認**

`types.ts` から `ConflictStrategy` を削除し、`TasksFile` に `has_conflicts` を追加、`SyncConfig` から `conflict_strategy` を削除する。

- [ ] **Step 2: テストを先に書く**

`packages/shared/src/__tests__/schema.test.ts` に以下を追加:

```typescript
describe("TasksFileWithConflictsSchema", () => {
  it("should accept tasks with conflict marker keys", () => {
    const data = {
      tasks: [{
        id: "owner/repo#1", type: "task", github_issue: 1, github_repo: "owner/repo",
        parent: null, sub_tasks: [], title: "Test", body: null, state: "open",
        state_reason: null, assignees: [], labels: [], milestone: null, linked_prs: [],
        created_at: "", updated_at: "", closed_at: null, custom_fields: {},
        start_date: null, end_date: null, date: null, blocked_by: [],
        state_current: "open", state_incoming: "closed",
      }],
      cache: { comments: {}, reactions: {} },
      has_conflicts: true,
    };
    expect(() => TasksFileWithConflictsSchema.parse(data)).not.toThrow();
  });

  it("should reject conflict markers in strict TasksFileSchema", () => {
    const data = {
      tasks: [{
        id: "owner/repo#1", type: "task", github_issue: 1, github_repo: "owner/repo",
        parent: null, sub_tasks: [], title: "Test", body: null, state: "open",
        state_reason: null, assignees: [], labels: [], milestone: null, linked_prs: [],
        created_at: "", updated_at: "", closed_at: null, custom_fields: {},
        start_date: null, end_date: null, date: null, blocked_by: [],
        state_current: "open", state_incoming: "closed",
      }],
      cache: { comments: {}, reactions: {} },
    };
    expect(() => TasksFileSchema.parse(data)).toThrow();
  });
});

describe("ConfigSchema without conflict_strategy", () => {
  it("should accept config without conflict_strategy", () => {
    // config without sync.conflict_strategy should be valid
  });

  it("should accept config with unknown keys via passthrough", () => {
    // config with legacy conflict_strategy should not throw
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `pnpm --filter @gh-gantt/shared exec vitest run src/__tests__/schema.test.ts`
Expected: FAIL (`TasksFileWithConflictsSchema` が未定義)

- [ ] **Step 4: types.ts を更新**

```typescript
// 削除: export type ConflictStrategy = "remote-wins" | "local-wins" | "manual";

// TasksFile に has_conflicts 追加
export interface TasksFile {
  tasks: Task[];
  cache: {
    comments: Record<string, Array<{ author: string; body: string; created_at: string }>>;
    reactions: Record<string, Record<string, number>>;
  };
  has_conflicts?: boolean;
}

// SyncConfig から conflict_strategy 削除
export interface SyncConfig {
  auto_create_issues: boolean;
  field_mapping: {
    start_date: string;
    end_date: string;
    status: string;
    type?: string | null;
  };
}
```

- [ ] **Step 5: schema.ts を更新**

```typescript
// ConflictStrategySchema を削除
// ConfigSchema.sync から conflict_strategy を削除、.passthrough() を追加
export const ConfigSchema = z.object({
  // ... (既存フィールドそのまま)
  sync: z.object({
    auto_create_issues: z.boolean(),
    field_mapping: z.object({
      start_date: z.string(),
      end_date: z.string(),
      status: z.string(),
      type: z.string().nullable().optional(),
    }),
  }).passthrough(),  // 既存 config の conflict_strategy を許容
  // ...
});

// TasksFileSchema に has_conflicts 追加
export const TasksFileSchema = z.object({
  tasks: z.array(TaskSchema),
  cache: z.object({
    comments: z.record(z.array(z.object({
      author: z.string(),
      body: z.string(),
      created_at: z.string(),
    }))),
    reactions: z.record(z.record(z.number())),
  }),
  has_conflicts: z.boolean().optional(),
});

// コンフリクトマーカー付き読み込み用
export const TasksFileWithConflictsSchema = z.object({
  tasks: z.array(TaskSchema.passthrough()),
  cache: z.object({
    comments: z.record(z.array(z.object({
      author: z.string(),
      body: z.string(),
      created_at: z.string(),
    }))),
    reactions: z.record(z.record(z.number())),
  }),
  has_conflicts: z.boolean().optional(),
});
```

- [ ] **Step 6: ConflictStrategy の参照を削除**

`types.ts` の他ファイルで `ConflictStrategy` を import している箇所を検索して削除。

Run: `cd packages && grep -r "ConflictStrategy" --include="*.ts" -l`

- [ ] **Step 6b: init.ts から conflict_strategy を削除**

`packages/cli/src/commands/init.ts:143` の `conflict_strategy: "remote-wins",` を削除する。

- [ ] **Step 7: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/shared exec vitest run src/__tests__/schema.test.ts`
Expected: PASS

- [ ] **Step 8: ビルド確認**

Run: `pnpm --filter @gh-gantt/shared build`
Expected: SUCCESS

- [ ] **Step 9: コミット**

```bash
git add packages/shared/
git commit -m "refactor: remove ConflictStrategy, add has_conflicts and WithConflicts schema"
```

---

## Task 2: three-way-merge.ts の実装

**Files:**
- Create: `packages/cli/src/sync/three-way-merge.ts`
- Test: `packages/cli/src/__tests__/three-way-merge.test.ts`

- [ ] **Step 1: テストを書く**

`packages/cli/src/__tests__/three-way-merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../sync/three-way-merge.js";
import type { SyncFields } from "@gh-gantt/shared";

function makeSyncFields(overrides: Partial<SyncFields> = {}): SyncFields {
  return {
    title: "Test", body: null, state: "open", type: "task",
    assignees: [], labels: [], milestone: null, custom_fields: {},
    parent: null, sub_tasks: [], start_date: null, end_date: null,
    date: null, blocked_by: [],
    ...overrides,
  };
}

describe("threeWayMerge", () => {
  it("no changes → returns base, no conflicts", () => {
    const base = makeSyncFields();
    const result = threeWayMerge(base, base, base);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.state).toBe("open");
  });

  it("remote-only change → adopts incoming", () => {
    const base = makeSyncFields({ state: "open" });
    const current = makeSyncFields({ state: "open" });
    const incoming = makeSyncFields({ state: "closed" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.state).toBe("closed");
  });

  it("local-only change → adopts current", () => {
    const base = makeSyncFields({ state: "open" });
    const current = makeSyncFields({ state: "closed" });
    const incoming = makeSyncFields({ state: "open" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.state).toBe("closed");
  });

  it("both changed to same value → adopts current, no conflict", () => {
    const base = makeSyncFields({ state: "open" });
    const current = makeSyncFields({ state: "closed" });
    const incoming = makeSyncFields({ state: "closed" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.state).toBe("closed");
  });

  it("both changed to different values → conflict", () => {
    const base = makeSyncFields({ milestone: null });
    const current = makeSyncFields({ milestone: "v1.0" });
    const incoming = makeSyncFields({ milestone: "v2.0" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      field: "milestone",
      base: null,
      current: "v1.0",
      incoming: "v2.0",
    });
  });

  it("multiple fields: some auto-merge, some conflict", () => {
    const base = makeSyncFields({ state: "open", milestone: null, start_date: "2026-01-01" });
    const current = makeSyncFields({ state: "closed", milestone: "v1.0", start_date: "2026-01-01" });
    const incoming = makeSyncFields({ state: "open", milestone: "v2.0", start_date: "2026-02-01" });
    const result = threeWayMerge(base, current, incoming);
    expect(result.merged.state).toBe("closed");       // local-only
    expect(result.merged.start_date).toBe("2026-02-01"); // remote-only
    expect(result.conflicts).toHaveLength(1);           // milestone conflicts
    expect(result.conflicts[0].field).toBe("milestone");
  });

  it("array fields: assignees comparison with sort", () => {
    const base = makeSyncFields({ assignees: ["alice"] });
    const current = makeSyncFields({ assignees: ["alice", "bob"] });
    const incoming = makeSyncFields({ assignees: ["alice"] });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.assignees).toEqual(["alice", "bob"]);
  });

  it("blocked_by: comparison includes type and lag", () => {
    const dep = { task: "owner/repo#2", type: "finish-to-start" as const, lag: 0 };
    const depChanged = { task: "owner/repo#2", type: "finish-to-start" as const, lag: 1 };
    const base = makeSyncFields({ blocked_by: [dep] });
    const current = makeSyncFields({ blocked_by: [depChanged] });
    const incoming = makeSyncFields({ blocked_by: [dep] });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.blocked_by[0].lag).toBe(1);
  });

  it("custom_fields: key order does not matter", () => {
    const base = makeSyncFields({ custom_fields: { a: "1", b: "2" } });
    const current = makeSyncFields({ custom_fields: { b: "2", a: "1" } });
    const incoming = makeSyncFields({ custom_fields: { a: "1", b: "2" } });
    const result = threeWayMerge(base, current, incoming);
    expect(result.conflicts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/three-way-merge.test.ts`
Expected: FAIL

- [ ] **Step 3: three-way-merge.ts を実装**

`packages/cli/src/sync/three-way-merge.ts`:

```typescript
import type { SyncFields } from "@gh-gantt/shared";

export interface FieldConflict {
  field: string;
  base: unknown;
  current: unknown;
  incoming: unknown;
}

export interface MergeResult {
  merged: SyncFields;
  conflicts: FieldConflict[];
}

// Re-export from shared constant to avoid duplication with conflict-marker.ts
export const SYNC_FIELD_KEYS: (keyof SyncFields)[] = [
  "title", "body", "state", "type",
  "assignees", "labels", "milestone", "custom_fields",
  "parent", "sub_tasks", "start_date", "end_date",
  "date", "blocked_by",
];

function normalize(value: unknown): string {
  if (Array.isArray(value)) {
    const sorted = [...value].sort((a, b) => {
      if (typeof a === "object" && a !== null && "task" in a) {
        return (a as { task: string }).task.localeCompare((b as { task: string }).task);
      }
      return String(a).localeCompare(String(b));
    });
    return JSON.stringify(sorted);
  }
  if (typeof value === "object" && value !== null) {
    const sorted = Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

function fieldsEqual(a: unknown, b: unknown): boolean {
  return normalize(a) === normalize(b);
}

export function threeWayMerge(
  base: SyncFields,
  current: SyncFields,
  incoming: SyncFields,
): MergeResult {
  const merged = { ...current };
  const conflicts: FieldConflict[] = [];

  for (const key of SYNC_FIELD_KEYS) {
    const baseVal = base[key];
    const currentVal = current[key];
    const incomingVal = incoming[key];

    const baseEqCurrent = fieldsEqual(baseVal, currentVal);
    const baseEqIncoming = fieldsEqual(baseVal, incomingVal);

    if (baseEqCurrent && baseEqIncoming) {
      // No change
      continue;
    } else if (baseEqCurrent && !baseEqIncoming) {
      // Remote-only change → adopt incoming
      (merged as Record<string, unknown>)[key] = incomingVal;
    } else if (!baseEqCurrent && baseEqIncoming) {
      // Local-only change → keep current (already in merged)
      continue;
    } else {
      // Both changed
      if (fieldsEqual(currentVal, incomingVal)) {
        // Same value → keep current
        continue;
      } else {
        // Conflict
        conflicts.push({ field: key, base: baseVal, current: currentVal, incoming: incomingVal });
      }
    }
  }

  return { merged, conflicts };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/three-way-merge.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/sync/three-way-merge.ts packages/cli/src/__tests__/three-way-merge.test.ts
git commit -m "feat: add field-level three-way merge for sync engine"
```

---

## Task 3: conflict-marker.ts の実装

**Files:**
- Create: `packages/cli/src/sync/conflict-marker.ts`
- Test: `packages/cli/src/__tests__/conflict-marker.test.ts`

- [ ] **Step 1: テストを書く**

`packages/cli/src/__tests__/conflict-marker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  applyConflictMarkers,
  detectMarkers,
  resolveMarker,
  hasUnresolvedMarkers,
} from "../sync/conflict-marker.js";
import type { Task } from "@gh-gantt/shared";
import type { FieldConflict } from "../sync/three-way-merge.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "owner/repo#1", type: "task", github_issue: 1, github_repo: "owner/repo",
    parent: null, sub_tasks: [], title: "Test", body: null, state: "open",
    state_reason: null, assignees: [], labels: [], milestone: null, linked_prs: [],
    created_at: "", updated_at: "", closed_at: null, custom_fields: {},
    start_date: null, end_date: null, date: null, blocked_by: [],
    ...overrides,
  };
}

describe("applyConflictMarkers", () => {
  it("adds _current and _incoming keys for each conflict", () => {
    const task = makeTask({ state: "open", milestone: null });
    const conflicts: FieldConflict[] = [
      { field: "state", base: "open", current: "open", incoming: "closed" },
      { field: "milestone", base: null, current: "v1.0", incoming: "v2.0" },
    ];
    const result = applyConflictMarkers(task, conflicts);
    expect(result.state_current).toBe("open");
    expect(result.state_incoming).toBe("closed");
    expect(result.milestone_current).toBe("v1.0");
    expect(result.milestone_incoming).toBe("v2.0");
    // Original field keeps current value
    expect(result.state).toBe("open");
    expect(result.milestone).toBe("v1.0");
  });
});

describe("detectMarkers", () => {
  it("detects conflict markers from task data", () => {
    const data: Record<string, unknown> = {
      state: "open", state_current: "open", state_incoming: "closed",
      title: "Test",
    };
    const markers = detectMarkers(data);
    expect(markers).toHaveLength(1);
    expect(markers[0].field).toBe("state");
    expect(markers[0].current).toBe("open");
    expect(markers[0].incoming).toBe("closed");
  });

  it("ignores orphaned markers (only _current without _incoming)", () => {
    const data: Record<string, unknown> = {
      state: "open", state_current: "open",
    };
    const markers = detectMarkers(data);
    expect(markers).toHaveLength(0);
  });

  it("ignores markers for non-SyncFields keys", () => {
    const data: Record<string, unknown> = {
      foo_current: "a", foo_incoming: "b",
    };
    const markers = detectMarkers(data);
    expect(markers).toHaveLength(0);
  });
});

describe("resolveMarker", () => {
  it("ours: keeps current value, removes markers", () => {
    const data: Record<string, unknown> = {
      state: "open", state_current: "open", state_incoming: "closed",
    };
    resolveMarker(data, "state", "ours");
    expect(data.state).toBe("open");
    expect(data.state_current).toBeUndefined();
    expect(data.state_incoming).toBeUndefined();
  });

  it("theirs: adopts incoming value, removes markers", () => {
    const data: Record<string, unknown> = {
      state: "open", state_current: "open", state_incoming: "closed",
    };
    resolveMarker(data, "state", "theirs");
    expect(data.state).toBe("closed");
    expect(data.state_current).toBeUndefined();
    expect(data.state_incoming).toBeUndefined();
  });
});

describe("hasUnresolvedMarkers", () => {
  it("returns true when markers exist", () => {
    const data = { state_current: "open", state_incoming: "closed" };
    expect(hasUnresolvedMarkers(data)).toBe(true);
  });

  it("returns false when no markers", () => {
    const data = { state: "open", title: "Test" };
    expect(hasUnresolvedMarkers(data)).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/conflict-marker.test.ts`
Expected: FAIL

- [ ] **Step 3: conflict-marker.ts を実装**

`packages/cli/src/sync/conflict-marker.ts`:

```typescript
import type { Task, SyncFields } from "@gh-gantt/shared";
import type { FieldConflict } from "./three-way-merge.js";

import { SYNC_FIELD_KEYS } from "./three-way-merge.js";

const SYNC_FIELD_KEY_SET: Set<string> = new Set(SYNC_FIELD_KEYS);

export function applyConflictMarkers(
  task: Task,
  conflicts: FieldConflict[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...task };
  for (const conflict of conflicts) {
    result[`${conflict.field}_current`] = conflict.current;
    result[`${conflict.field}_incoming`] = conflict.incoming;
  }
  return result;
}

export function detectMarkers(
  task: Record<string, unknown>,
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  const seen = new Set<string>();

  for (const key of Object.keys(task)) {
    if (!key.endsWith("_current")) continue;
    const field = key.slice(0, -"_current".length);
    if (!SYNC_FIELD_KEY_SET.has(field)) continue;
    if (seen.has(field)) continue;

    const incomingKey = `${field}_incoming`;
    if (!(incomingKey in task)) continue;

    seen.add(field);
    conflicts.push({
      field,
      base: undefined, // base is retrieved from snapshot externally
      current: task[key],
      incoming: task[incomingKey],
    });
  }

  return conflicts;
}

export function resolveMarker(
  task: Record<string, unknown>,
  field: string,
  choice: "ours" | "theirs",
): void {
  const currentKey = `${field}_current`;
  const incomingKey = `${field}_incoming`;

  if (choice === "theirs") {
    task[field] = task[incomingKey];
  }
  // "ours" → keep current value (already in task[field])

  delete task[currentKey];
  delete task[incomingKey];
}

export function hasUnresolvedMarkers(
  task: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(task)) {
    if (!key.endsWith("_current")) continue;
    const field = key.slice(0, -"_current".length);
    if (!SYNC_FIELD_KEY_SET.has(field)) continue;
    if (`${field}_incoming` in task) return true;
  }
  return false;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/conflict-marker.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/sync/conflict-marker.ts packages/cli/src/__tests__/conflict-marker.test.ts
git commit -m "feat: add conflict marker read/write/resolve for JSON tasks"
```

---

## Task 4: TasksStore のコンフリクト対応

**Files:**
- Modify: `packages/cli/src/store/tasks.ts`

- [ ] **Step 1: tasks.ts を更新**

`TasksStore.read()` を `TasksFileWithConflictsSchema` で読み込むように変更。これにより、マーカー付き `tasks.json` も読み込み可能になる。

```typescript
import { TasksFileWithConflictsSchema, GANTT_DIR, TASKS_FILE } from "@gh-gantt/shared";
// ...
async read(): Promise<TasksFile> {
  const raw = await readFile(this.path, "utf-8");
  return TasksFileWithConflictsSchema.parse(JSON.parse(raw)) as TasksFile;
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm --filter @gh-gantt/cli build`
Expected: SUCCESS

- [ ] **Step 3: コミット**

```bash
git add packages/cli/src/store/tasks.ts
git commit -m "refactor: use WithConflicts schema for tasks.json reads"
```

---

## Task 5: conflicts コマンドの実装

**Files:**
- Create: `packages/cli/src/commands/conflicts.ts`
- Modify: `packages/cli/src/index.ts:10-21`
- Test: `packages/cli/src/__tests__/conflicts-command.test.ts`

- [ ] **Step 1: テストを書く**

`packages/cli/src/__tests__/conflicts-command.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatConflictList } from "../commands/conflicts.js";

describe("formatConflictList", () => {
  it("formats conflict list with base values", () => {
    const tasks = [
      {
        id: "owner/repo#8",
        title: "ドラッグ&ドロップ",
        state: "open",
        state_current: "open",
        state_incoming: "closed",
        github_issue: 8,
      },
    ];
    const snapshots = {
      "owner/repo#8": { hash: "", synced_at: "", syncFields: { state: "open" } },
    };
    const output = formatConflictList(tasks as any, snapshots as any);
    expect(output).toContain("#8");
    expect(output).toContain("state");
    expect(output).toContain("current=open");
    expect(output).toContain("incoming=closed");
  });

  it("returns 'No conflicts' when no markers", () => {
    const output = formatConflictList([], {});
    expect(output).toContain("No conflicts");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/conflicts-command.test.ts`
Expected: FAIL

- [ ] **Step 3: conflicts.ts を実装**

`packages/cli/src/commands/conflicts.ts`:

```typescript
import { Command } from "commander";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { detectMarkers } from "../sync/conflict-marker.js";
import type { SyncState } from "@gh-gantt/shared";

export function formatConflictList(
  tasks: Record<string, unknown>[],
  snapshots: SyncState["snapshots"],
  filterIssue?: number,
): string {
  const lines: string[] = [];
  let totalConflicts = 0;
  let taskCount = 0;

  for (const task of tasks) {
    const markers = detectMarkers(task);
    if (markers.length === 0) continue;

    const issueNum = task.github_issue as number | null;
    if (filterIssue !== undefined && issueNum !== filterIssue) continue;

    const taskId = task.id as string;
    const snapshot = snapshots[taskId];
    const baseFields = snapshot?.syncFields as Record<string, unknown> | undefined;

    taskCount++;
    lines.push(`  #${issueNum ?? taskId}: ${task.title as string}`);

    for (const marker of markers) {
      const base = baseFields?.[marker.field];
      const baseStr = base === undefined ? "?" : String(base ?? "null");
      lines.push(
        `    ${marker.field}: current=${String(marker.current ?? "null")}  incoming=${String(marker.incoming ?? "null")}  base=${baseStr}`,
      );
      totalConflicts++;
    }
    lines.push("");
  }

  if (taskCount === 0) {
    return "No conflicts.";
  }

  lines.push(`${taskCount} task(s), ${totalConflicts} conflict(s)`);
  return lines.join("\n");
}

export const conflictsCommand = new Command("conflicts")
  .description("Show unresolved sync conflicts")
  .argument("[issue]", "Filter by issue number", parseInt)
  .action(async (issue?: number) => {
    const cwd = process.cwd();
    const tasksStore = new TasksStore(cwd);
    const stateStore = new SyncStateStore(cwd);
    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();

    const rawTasks = (tasksFile as any).tasks as Record<string, unknown>[];
    const output = formatConflictList(rawTasks, syncState.snapshots, issue);
    console.log(output);
  });
```

- [ ] **Step 4: index.ts にコマンド登録**

`packages/cli/src/index.ts` に追加:

```typescript
import { conflictsCommand } from "./commands/conflicts.js";
// ...
program.addCommand(conflictsCommand);
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/conflicts-command.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/cli/src/commands/conflicts.ts packages/cli/src/__tests__/conflicts-command.test.ts packages/cli/src/index.ts
git commit -m "feat: add gh-gantt conflicts command"
```

---

## Task 6: resolve コマンドの実装

**Files:**
- Create: `packages/cli/src/commands/resolve.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/__tests__/resolve-command.test.ts`

- [ ] **Step 1: テストを書く**

`packages/cli/src/__tests__/resolve-command.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveAll } from "../commands/resolve.js";

describe("resolveAll", () => {
  it("resolves all markers with --ours", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8", state: "open",
        state_current: "open", state_incoming: "closed",
        milestone: "v1.0", milestone_current: "v1.0", milestone_incoming: "v2.0",
      },
    ];
    resolveAll(tasks, "ours");
    expect(tasks[0].state).toBe("open");
    expect(tasks[0].milestone).toBe("v1.0");
    expect(tasks[0].state_current).toBeUndefined();
    expect(tasks[0].state_incoming).toBeUndefined();
  });

  it("resolves all markers with --theirs", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8", state: "open",
        state_current: "open", state_incoming: "closed",
      },
    ];
    resolveAll(tasks, "theirs");
    expect(tasks[0].state).toBe("closed");
    expect(tasks[0].state_current).toBeUndefined();
  });

  it("resolves specific task only", () => {
    const tasks: Record<string, unknown>[] = [
      { id: "owner/repo#8", github_issue: 8, state_current: "open", state_incoming: "closed", state: "open" },
      { id: "owner/repo#11", github_issue: 11, milestone_current: "v1", milestone_incoming: "v2", milestone: "v1" },
    ];
    resolveAll(tasks, "ours", 8);
    expect(tasks[0].state_current).toBeUndefined(); // resolved
    expect(tasks[1].milestone_current).toBe("v1");  // untouched
  });

  it("resolves specific field only", () => {
    const tasks: Record<string, unknown>[] = [
      {
        id: "owner/repo#8", github_issue: 8, state: "open",
        state_current: "open", state_incoming: "closed",
        milestone: "v1.0", milestone_current: "v1.0", milestone_incoming: "v2.0",
      },
    ];
    resolveAll(tasks, "theirs", 8, "state");
    expect(tasks[0].state).toBe("closed");
    expect(tasks[0].state_current).toBeUndefined();
    expect(tasks[0].milestone_current).toBe("v1.0"); // untouched
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/resolve-command.test.ts`
Expected: FAIL

- [ ] **Step 3: resolve.ts を実装**

`packages/cli/src/commands/resolve.ts`:

```typescript
import { Command } from "commander";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import { detectMarkers, resolveMarker, hasUnresolvedMarkers } from "../sync/conflict-marker.js";
import { hashTask } from "../sync/hash.js";
import { formatConflictList } from "./conflicts.js";
import type { Task, TasksFile } from "@gh-gantt/shared";
import * as readline from "node:readline/promises";

export function resolveAll(
  tasks: Record<string, unknown>[],
  choice: "ours" | "theirs",
  filterIssue?: number,
  filterField?: string,
): void {
  for (const task of tasks) {
    if (filterIssue !== undefined && (task.github_issue as number) !== filterIssue) continue;

    const markers = detectMarkers(task);
    for (const marker of markers) {
      if (filterField !== undefined && marker.field !== filterField) continue;
      resolveMarker(task, marker.field, choice);
    }
  }
}

export const resolveCommand = new Command("resolve")
  .description("Resolve sync conflicts")
  .argument("[issue]", "Filter by issue number", parseInt)
  .option("--ours", "Resolve all conflicts with local values")
  .option("--theirs", "Resolve all conflicts with remote values")
  .option("--field <field>", "Resolve only specific field")
  .action(async (issue: number | undefined, opts: { ours?: boolean; theirs?: boolean; field?: string }) => {
    const cwd = process.cwd();
    const tasksStore = new TasksStore(cwd);
    const stateStore = new SyncStateStore(cwd);
    const tasksFile = await tasksStore.read();
    const syncState = await stateStore.read();
    const rawTasks = (tasksFile as any).tasks as Record<string, unknown>[];

    if (opts.ours || opts.theirs) {
      const choice = opts.ours ? "ours" : "theirs";
      resolveAll(rawTasks, choice, issue, opts.field);
    } else {
      // Interactive mode
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      for (const task of rawTasks) {
        if (issue !== undefined && (task.github_issue as number) !== issue) continue;
        const markers = detectMarkers(task);
        for (const marker of markers) {
          if (opts.field && marker.field !== opts.field) continue;
          const snapshot = syncState.snapshots[task.id as string];
          const base = (snapshot?.syncFields as Record<string, unknown>)?.[marker.field];
          console.log(`\n#${task.github_issue}: ${marker.field}`);
          console.log(`  current (local):  ${String(marker.current ?? "null")}`);
          console.log(`  incoming (remote): ${String(marker.incoming ?? "null")}`);
          console.log(`  base (snapshot):   ${String(base ?? "null")}`);
          const answer = await rl.question("  ? ours or theirs: ");
          if (answer === "ours" || answer === "theirs") {
            resolveMarker(task, marker.field, answer);
          } else {
            console.log("  Skipped (invalid input)");
          }
        }
      }
      rl.close();
    }

    // Update has_conflicts flag
    const stillHasConflicts = rawTasks.some((t) => hasUnresolvedMarkers(t));
    (tasksFile as any).has_conflicts = stillHasConflicts;

    // Update snapshots for resolved tasks
    for (const task of rawTasks) {
      if (!hasUnresolvedMarkers(task)) {
        const taskId = task.id as string;
        const snap = syncState.snapshots[taskId];
        if (snap) {
          const t = task as unknown as Task;
          snap.hash = hashTask(t);
          snap.syncFields = {
            title: t.title, body: t.body, state: t.state, type: t.type,
            assignees: [...t.assignees].sort(), labels: [...t.labels].sort(),
            milestone: t.milestone, custom_fields: t.custom_fields,
            parent: t.parent, sub_tasks: [...t.sub_tasks].sort(),
            start_date: t.start_date, end_date: t.end_date, date: t.date,
            blocked_by: [...t.blocked_by].sort((a, b) => a.task.localeCompare(b.task)),
          };
        }
      }
    }

    await tasksStore.write(tasksFile);
    await stateStore.write(syncState);

    if (stillHasConflicts) {
      console.log("\nSome conflicts remain:");
      console.log(formatConflictList(rawTasks, syncState.snapshots));
    } else {
      console.log("\nAll conflicts resolved. Run `gh-gantt push` to sync changes.");
    }
  });
```

- [ ] **Step 4: index.ts にコマンド登録**

```typescript
import { resolveCommand } from "./commands/resolve.js";
// ...
program.addCommand(resolveCommand);
```

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/resolve-command.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/cli/src/commands/resolve.ts packages/cli/src/__tests__/resolve-command.test.ts packages/cli/src/index.ts
git commit -m "feat: add gh-gantt resolve command with ours/theirs/interactive modes"
```

---

## Task 7: pull コマンドの改修 (ガード + 3-way merge 統合)

**Files:**
- Modify: `packages/cli/src/commands/pull.ts`
- Modify: `packages/cli/src/sync/mapper.ts:52-71` (mergeRemoteIntoLocal 削除)
- Delete: `packages/cli/src/sync/conflict.ts`
- Delete: `packages/cli/src/__tests__/conflict.test.ts`
- Delete: `packages/cli/src/__tests__/pull-conflicts.test.ts`

- [ ] **Step 1: mapper.ts から mergeRemoteIntoLocal を削除**

`packages/cli/src/sync/mapper.ts` の lines 52-71 を削除。import している箇所を検索して更新。

Run: `grep -rn "mergeRemoteIntoLocal" packages/cli/src/ --include="*.ts"`

- [ ] **Step 2: conflict.ts を削除**

```bash
rm packages/cli/src/sync/conflict.ts
rm packages/cli/src/__tests__/conflict.test.ts
rm packages/cli/src/__tests__/pull-conflicts.test.ts
```

- [ ] **Step 3: pull.ts を改修**

`packages/cli/src/commands/pull.ts` の主要な変更:

1. import を更新: `conflict.ts` → `three-way-merge.ts` + `conflict-marker.ts`
2. ステップ1: 未push変更ガード追加 (draft タスク除外)
3. ステップ2: 未解決マーカーチェック追加
4. ステップ4: `mergeRemoteIntoLocal` → `threeWayMerge` + `applyConflictMarkers` に差し替え
5. `confirmConflicts` を削除 (マーカー方式に置き換え)
6. delete/modify コンフリクト処理追加
7. read-only フィールドの更新ロジック追加

主な変更箇所:

```typescript
import { threeWayMerge } from "../sync/three-way-merge.js";
import { applyConflictMarkers, hasUnresolvedMarkers } from "../sync/conflict-marker.js";
import { computeLocalDiff } from "../sync/diff.js";
import { isDraftTask } from "../github/issues.js";

// pull アクション内:

// Step 1: 未push変更ガード
const localDiffs = computeLocalDiff(tasksFile.tasks, syncState);
const nonDraftDiffs = localDiffs.filter((d) => !isDraftTask(d.id));
if (nonDraftDiffs.length > 0 && !opts.force) {
  console.error("未pushの変更があります。先に push するか --force で上書きしてください");
  process.exit(1);
}

// Step 2: 未解決マーカーチェック
if (tasksFile.has_conflicts) {
  console.error("未解決のコンフリクトがあります。先に resolve してください");
  process.exit(1);
}

// Step 4: 3-way merge
for (const remoteTask of remoteTasks) {
  const localTask = localMap.get(remoteTask.id);
  const snapshot = syncState.snapshots[remoteTask.id];

  if (!snapshot) {
    // New remote task
    mergedTasks.push(remoteTask);
    continue;
  }

  if (!localTask) continue;

  const remoteHash = hashTask(remoteTask);
  if (remoteHash === (snapshot.remoteHash ?? snapshot.hash)) {
    // Remote unchanged → keep local
    mergedTasks.push(localTask);
    continue;
  }

  if (!snapshot.syncFields) {
    // No syncFields → fall back to remote
    mergedTasks.push(remoteTask);
    continue;
  }

  const localFields = extractSyncFields(localTask);
  const remoteFields = extractSyncFields(remoteTask);
  const { merged, conflicts } = threeWayMerge(snapshot.syncFields, localFields, remoteFields);

  // Apply merged sync fields to task
  const mergedTask = { ...localTask, ...merged };
  // Update read-only fields from remote
  mergedTask.created_at = remoteTask.created_at;
  mergedTask.updated_at = remoteTask.updated_at;
  mergedTask.closed_at = remoteTask.closed_at;
  mergedTask.state_reason = remoteTask.state_reason;
  mergedTask.linked_prs = remoteTask.linked_prs;

  if (conflicts.length > 0) {
    const marked = applyConflictMarkers(mergedTask, conflicts);
    mergedTasks.push(marked as any);
    hasConflictsFlag = true;
  } else {
    mergedTasks.push(mergedTask);
  }
}

// Delete/modify conflict for tasks removed from remote
for (const localTask of tasksFile.tasks) {
  if (isDraftTask(localTask.id)) continue;
  if (remoteMap.has(localTask.id)) continue;
  const snapshot = syncState.snapshots[localTask.id];
  if (!snapshot) continue;
  const localHash = hashTask(localTask);
  if (localHash !== snapshot.hash) {
    // Local modified + remote deleted → keep with warning
    console.warn(`Warning: #${localTask.github_issue} was deleted remotely but has local changes. Keeping local copy.`);
    mergedTasks.push(localTask);
  }
  // else: local unchanged + remote deleted → remove (don't add to mergedTasks)
}
```

- [ ] **Step 4: ビルド確認**

Run: `pnpm --filter @gh-gantt/cli build`
Expected: SUCCESS

- [ ] **Step 5: 既存テスト確認**

Run: `pnpm --filter @gh-gantt/cli test`
Expected: PASS (削除したテストを除く)

- [ ] **Step 6: コミット**

```bash
git add packages/cli/src/commands/pull.ts packages/cli/src/sync/mapper.ts
git rm packages/cli/src/sync/conflict.ts packages/cli/src/__tests__/conflict.test.ts packages/cli/src/__tests__/pull-conflicts.test.ts
git commit -m "refactor: replace remote-wins merge with 3-way merge in pull command"
```

---

## Task 7b: pull ガードの統合テスト

**Files:**
- Create: `packages/cli/src/__tests__/pull-guards.test.ts`

- [ ] **Step 1: テストを書く**

`packages/cli/src/__tests__/pull-guards.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeLocalDiff } from "../sync/diff.js";
import { isDraftTask } from "../github/issues.js";
import { hasUnresolvedMarkers } from "../sync/conflict-marker.js";
import type { Task, SyncState, TasksFile } from "@gh-gantt/shared";

// Test helpers to create minimal Task and SyncState fixtures

describe("pull guards", () => {
  describe("unpushed changes guard", () => {
    it("detects modified non-draft tasks as unpushed changes", () => {
      // Task with hash different from snapshot
    });

    it("excludes draft tasks from unpushed check", () => {
      // Draft task should not block pull
    });
  });

  describe("unresolved conflicts guard", () => {
    it("detects conflict markers in tasks", () => {
      const task = { state_current: "open", state_incoming: "closed" };
      expect(hasUnresolvedMarkers(task)).toBe(true);
    });

    it("passes when no conflict markers", () => {
      const task = { state: "open" };
      expect(hasUnresolvedMarkers(task)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: テストが通ることを確認**

Run: `pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/pull-guards.test.ts`
Expected: PASS

- [ ] **Step 3: コミット**

```bash
git add packages/cli/src/__tests__/pull-guards.test.ts
git commit -m "test: add pull guard integration tests"
```

---

## Task 8: push コマンドの改修 (ガード追加)

**Files:**
- Modify: `packages/cli/src/commands/push.ts`
- Modify: `packages/cli/src/sync/push-executor.ts`

- [ ] **Step 1: push.ts にマーカーチェックと `--force` オプション追加**

`packages/cli/src/commands/push.ts`:
- `.option("--force", "Skip remote change check")` を追加
- push アクション内、diff 計算前にマーカーチェック:

```typescript
// Step 1: 未解決マーカーチェック (--force でもスキップ不可)
if (tasksFile.has_conflicts) {
  console.error("未解決のコンフリクトがあります。先に resolve してください");
  process.exit(1);
}
```

- `executePush` 呼び出し時に `{ force: opts.force }` を渡す

- [ ] **Step 2: push-executor.ts にリモート変更チェック追加**

`executePush` のシグネチャに `opts?: { force?: boolean }` を追加。

リモート変更チェックは初期実装では以下の方針:
- push 対象タスクの `updated_at` を snapshot の `updated_at` と比較
- 不一致があれば「リモートが更新されています。先に pull してください」と警告して中断
- `--force` でスキップ可能

```typescript
// リモート変更チェック
if (!opts?.force) {
  const staleTaskIds: string[] = [];
  for (const diff of diffs) {
    if (diff.type !== "modified") continue;
    const snapshot = syncState.snapshots[diff.id];
    if (!snapshot?.updated_at) continue;
    const localTask = tasksFile.tasks.find((t) => t.id === diff.id);
    if (localTask && localTask.updated_at !== snapshot.updated_at) {
      staleTaskIds.push(diff.id);
    }
  }
  if (staleTaskIds.length > 0) {
    console.error("リモートが更新されています。先に pull してください");
    console.error("  " + staleTaskIds.join("\n  "));
    console.error("--force で強制 push できます");
    return { result: { created: 0, updated: 0, skipped: 0 }, tasksFile, syncState };
  }
}
```

NOTE: この方式は `updated_at` がローカル編集でも変わるため偽陽性がある。将来的に GitHub API での lightweight チェック (`GET /issues/{number}` の `updated_at` 比較) に置き換えることを推奨。

- [ ] **Step 4: ビルド確認**

Run: `pnpm --filter @gh-gantt/cli build`
Expected: SUCCESS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/commands/push.ts packages/cli/src/sync/push-executor.ts
git commit -m "feat: add conflict and remote-change guards to push command"
```

---

## Task 9: mapper.test.ts の更新

**Files:**
- Modify: `packages/cli/src/__tests__/mapper.test.ts`

- [ ] **Step 1: mergeRemoteIntoLocal のテストを削除**

`packages/cli/src/__tests__/mapper.test.ts` から `mergeRemoteIntoLocal` 関連のテストを削除。`mapRemoteItemToTask` のテストはそのまま残す。

- [ ] **Step 2: テスト確認**

Run: `pnpm --filter @gh-gantt/cli test`
Expected: PASS

- [ ] **Step 3: コミット**

```bash
git add packages/cli/src/__tests__/mapper.test.ts
git commit -m "test: remove mergeRemoteIntoLocal tests (replaced by three-way-merge)"
```

---

## Task 10: 全体ビルド・テスト・型チェック

**Files:** None (verification only)

- [ ] **Step 1: shared ビルド**

Run: `pnpm --filter @gh-gantt/shared build`
Expected: SUCCESS

- [ ] **Step 2: CLI ビルド**

Run: `pnpm --filter @gh-gantt/cli build`
Expected: SUCCESS

- [ ] **Step 3: UI ビルド**

Run: `pnpm --filter @gh-gantt/ui build`
Expected: SUCCESS

- [ ] **Step 4: 全テスト**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 5: 型チェック**

Run: `pnpm typecheck`
Expected: SUCCESS

- [ ] **Step 6: 不要な import/export の残骸がないか確認**

Run: `grep -rn "ConflictStrategy\|mergeRemoteIntoLocal\|detectConflicts" packages/ --include="*.ts" -l`
Expected: ヒットなし (テストファイルの import 等が残っていないか)

---

## Task 11: コンフリクト解決スキルの作成

**Files:**
- Create: `.claude/skills/conflict-resolution/SKILL.md`

- [ ] **Step 1: スキルファイルを作成**

`.claude/skills/conflict-resolution/SKILL.md`:

```markdown
---
name: conflict-resolution
description: gh-gantt の同期コンフリクトを CLI で自動解決する。pull 後にコンフリクトが発生した場合、または「コンフリクトを解決して」と指示された場合にトリガー。
---

# gh-gantt Conflict Resolution

gh-gantt pull 後に発生した同期コンフリクトを CLI コマンドで解決する。

## Workflow

1. コンフリクト一覧を取得:
   ```bash
   gh-gantt conflicts
   ```

2. 各コンフリクトについて current / incoming / base を確認し、適切な値を判断

3. CLI で解決:
   ```bash
   # 特定フィールドを解決
   gh-gantt resolve <issue-number> --field <field> --ours
   gh-gantt resolve <issue-number> --field <field> --theirs

   # タスク全体を一括解決
   gh-gantt resolve <issue-number> --ours
   gh-gantt resolve <issue-number> --theirs
   ```

4. 全解決を確認:
   ```bash
   gh-gantt conflicts
   # → "No conflicts."
   ```

5. push を提案:
   ```bash
   gh-gantt push
   ```

## Decision Guidelines

| Field | Guideline |
|-------|-----------|
| `state` | ローカルで closed にしたなら実装完了の意図 → `--ours`。PR 未マージなら `--theirs` |
| `start_date` / `end_date` | リモートがスケジュール調整なら `--theirs`。ローカルが作業実績なら `--ours` |
| `milestone` | プロジェクト管理者の意図を尊重 → `--theirs` 優先 |
| `assignees` / `labels` | リモートを尊重 → `--theirs` 優先 |
| 判断がつかない場合 | ユーザーに確認する |

## Important

- `tasks.json` を直接編集しない。必ず `gh-gantt resolve` コマンドを使う
- 解決後は `gh-gantt conflicts` で残りがないことを確認する
- コンフリクトが残っている状態では `push` も `pull` もできない
```

- [ ] **Step 2: コミット**

```bash
git add .claude/skills/conflict-resolution/SKILL.md
git commit -m "feat: add conflict resolution skill for AI agents"
```

---

## Task 12: 最終統合テスト

**Files:** None (verification only)

- [ ] **Step 1: CLI のヘルプ出力確認**

Run: `./gh-gantt --help`
Expected: `conflicts` と `resolve` コマンドが表示される

- [ ] **Step 2: conflicts コマンドの動作確認**

Run: `./gh-gantt conflicts`
Expected: 現在の状態に応じた出力

- [ ] **Step 3: 全テスト最終確認**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: 最終コミット (必要な場合のみ)**

修正があれば最終コミット。

---

## Deferred: UI 変更 (別 PR)

以下のUI変更はスペックに記載されているが、本計画のスコープ外。CLI の実装が安定してから別 PR で対応する:

- `has_conflicts === true` 時のバナー警告表示
- コンフリクトタスクの警告アイコン表示
- コンフリクト中のフィールド編集無効化
- push ボタンの無効化
- API レスポンスでのマーカー付きタスク対応 (`.passthrough()` 対応)
