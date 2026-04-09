# pull GraphQL pre-check 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pull 時に変化がなければ 1 回の GraphQL で skip し、フル fetch を回避する

**Architecture:** `queries.ts` に pre-check クエリを追加、`projects.ts` に `checkRemoteChanges()` 関数を追加、`pull-executor.ts` の先頭に pre-check フローを挿入。`pull.ts` に `--full-fetch` オプションを追加。

**Tech Stack:** TypeScript, @octokit/graphql, Vitest

---

## ファイル構成

| ファイル                                           | 操作 | 責務                           |
| -------------------------------------------------- | ---- | ------------------------------ |
| `packages/cli/src/github/queries.ts`               | 修正 | pre-check クエリ定数を追加     |
| `packages/cli/src/github/projects.ts`              | 修正 | `checkRemoteChanges()` を追加  |
| `packages/cli/src/sync/pull-executor.ts`           | 修正 | pre-check フローを挿入         |
| `packages/cli/src/commands/pull.ts`                | 修正 | `--full-fetch` オプション追加  |
| `packages/cli/src/__tests__/precheck.test.ts`      | 新規 | checkRemoteChanges 単体テスト  |
| `packages/cli/src/__tests__/pull-precheck.test.ts` | 新規 | pull-executor pre-check テスト |

---

### Task 1: pre-check クエリ定義の追加

**Files:**

- Modify: `packages/cli/src/github/queries.ts`

- [ ] **Step 1: クエリ定数を追加**

`queries.ts` の末尾（`ISSUE_RELATIONSHIPS_QUERY` の後）に追加:

```typescript
export const ISSUES_SINCE_QUERY = `
  query($owner: String!, $repo: String!, $since: DateTime!) {
    repository(owner: $owner, name: $repo) {
      issues(filterBy: { since: $since }, first: 1) {
        totalCount
      }
    }
  }
`;
```

- [ ] **Step 2: lint 確認**

Run: `pnpm lint`
Expected: pass（warn のみ）

- [ ] **Step 3: コミット**

```bash
git add packages/cli/src/github/queries.ts
git commit -m "feat(sync): pre-check 用 ISSUES_SINCE_QUERY を追加 (#157)"
```

---

### Task 2: checkRemoteChanges 関数の実装（TDD）

**Files:**

- Create: `packages/cli/src/__tests__/precheck.test.ts`
- Modify: `packages/cli/src/github/projects.ts`

- [ ] **Step 1: テストファイルを作成**

```typescript
import { describe, it, expect, vi } from "vitest";
import { checkRemoteChanges } from "../github/projects.js";

describe("checkRemoteChanges", () => {
  it("totalCount > 0 のとき true を返す", async () => {
    const gql = vi.fn().mockResolvedValue({
      repository: { issues: { totalCount: 3 } },
    });
    const result = await checkRemoteChanges(
      gql as any,
      "stanah",
      "gh-gantt",
      "2026-04-01T00:00:00Z",
    );
    expect(result).toBe(true);
    expect(gql).toHaveBeenCalledOnce();
  });

  it("totalCount === 0 のとき false を返す", async () => {
    const gql = vi.fn().mockResolvedValue({
      repository: { issues: { totalCount: 0 } },
    });
    const result = await checkRemoteChanges(
      gql as any,
      "stanah",
      "gh-gantt",
      "2026-04-01T00:00:00Z",
    );
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @gh-gantt/cli exec vp test run src/__tests__/precheck.test.ts`
Expected: FAIL — `checkRemoteChanges` が export されていない

- [ ] **Step 3: 関数を実装**

`packages/cli/src/github/projects.ts` の末尾に追加:

```typescript
import { ISSUES_SINCE_QUERY } from "./queries.js";

export async function checkRemoteChanges(
  gql: typeof graphql,
  owner: string,
  repo: string,
  since: string,
): Promise<boolean> {
  const result: any = await gql(ISSUES_SINCE_QUERY, { owner, repo, since });
  return result.repository.issues.totalCount > 0;
}
```

注: `import { ISSUES_SINCE_QUERY }` は既存の import 文にマージすること。

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @gh-gantt/cli exec vp test run src/__tests__/precheck.test.ts`
Expected: 2 tests passed

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/__tests__/precheck.test.ts packages/cli/src/github/projects.ts
git commit -m "feat(sync): checkRemoteChanges 関数を実装 (#157)"
```

---

### Task 3: pull-executor に pre-check フローを挿入（TDD）

**Files:**

- Create: `packages/cli/src/__tests__/pull-precheck.test.ts`
- Modify: `packages/cli/src/sync/pull-executor.ts`

- [ ] **Step 1: テストファイルを作成**

```typescript
import { describe, it, expect, vi } from "vitest";
import type { Config, SyncState, TasksFile } from "@gh-gantt/shared";

// executePull は内部で fetchProject, checkRemoteChanges 等を呼ぶ。
// これらを mock するため vi.mock を使う。
vi.mock("../github/projects.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../github/projects.js")>();
  return {
    ...original,
    fetchProject: vi.fn(),
    fetchRepositoryMetadata: vi.fn(),
    checkRemoteChanges: vi.fn(),
  };
});

vi.mock("../github/sub-issues.js", () => ({
  fetchAllIssueRelationshipLinks: vi.fn().mockResolvedValue({
    subIssueLinks: [],
    blockedByLinks: [],
  }),
}));

import { executePull } from "../sync/pull-executor.js";
import { fetchProject, fetchRepositoryMetadata, checkRemoteChanges } from "../github/projects.js";

const mockFetchProject = vi.mocked(fetchProject);
const mockFetchRepoMeta = vi.mocked(fetchRepositoryMetadata);
const mockCheckRemote = vi.mocked(checkRemoteChanges);

function makeConfig(): Config {
  return {
    project: {
      github: { owner: "stanah", repo: "gh-gantt", project_number: 1 },
    },
    sync: { auto_create_issues: false },
    task_types: {},
  } as Config;
}

function makeEmptySyncState(): SyncState {
  return {
    last_synced_at: "2026-04-01T00:00:00Z",
    project_node_id: "PVT_1",
    id_map: {},
    field_ids: {},
    snapshots: {},
  };
}

function makeEmptyTasksFile(): TasksFile {
  return { tasks: [], cache: { comments: {}, reactions: {} } };
}

const gql = vi.fn();

describe("[Issue #157] pull pre-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // fetchRepositoryMetadata のデフォルト
    mockFetchRepoMeta.mockResolvedValue({
      labelMap: new Map(),
      milestoneMap: new Map(),
      milestones: [],
    });
    // fetchProject のデフォルト
    mockFetchProject.mockResolvedValue({
      projectNodeId: "PVT_1",
      projectTitle: "Test",
      fields: [],
      items: [],
    });
  });

  it("pre-check で変化なし → fetchProject が呼ばれず skipped=true", async () => {
    mockCheckRemote.mockResolvedValue(false);
    const syncState = makeEmptySyncState();

    const { result } = await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState);

    expect(mockCheckRemote).toHaveBeenCalledOnce();
    expect(mockFetchProject).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });

  it("pre-check で変化あり → fetchProject が呼ばれる", async () => {
    mockCheckRemote.mockResolvedValue(true);
    const syncState = makeEmptySyncState();

    const { result } = await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState);

    expect(mockCheckRemote).toHaveBeenCalledOnce();
    expect(mockFetchProject).toHaveBeenCalledOnce();
    expect(result.skipped).toBe(false);
  });

  it("fullFetch=true → checkRemoteChanges が呼ばれず fetchProject が呼ばれる", async () => {
    const syncState = makeEmptySyncState();

    await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState, {
      fullFetch: true,
    });

    expect(mockCheckRemote).not.toHaveBeenCalled();
    expect(mockFetchProject).toHaveBeenCalledOnce();
  });

  it("force=true → checkRemoteChanges が呼ばれず fetchProject が呼ばれる", async () => {
    const syncState = makeEmptySyncState();

    await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState, { force: true });

    expect(mockCheckRemote).not.toHaveBeenCalled();
    expect(mockFetchProject).toHaveBeenCalledOnce();
  });

  it("last_synced_at が空 → checkRemoteChanges が呼ばれず fetchProject が呼ばれる", async () => {
    const syncState = { ...makeEmptySyncState(), last_synced_at: "" };

    await executePull(gql as any, makeConfig(), makeEmptyTasksFile(), syncState);

    expect(mockCheckRemote).not.toHaveBeenCalled();
    expect(mockFetchProject).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm --filter @gh-gantt/cli exec vp test run src/__tests__/pull-precheck.test.ts`
Expected: FAIL — pre-check ロジックが未実装のため、checkRemoteChanges が呼ばれない等

- [ ] **Step 3: pull-executor.ts を修正**

`packages/cli/src/sync/pull-executor.ts` の変更:

3-1. import に `checkRemoteChanges` を追加:

```typescript
import { fetchProject, fetchRepositoryMetadata, checkRemoteChanges } from "../github/projects.js";
```

3-2. `PullOptions` に `fullFetch` を追加:

```typescript
export interface PullOptions {
  force?: boolean;
  fullFetch?: boolean;
}
```

3-3. `executePull` 関数内、sync-state 検証の後（行62）、fetchProject の前（行70）に pre-check を挿入:

```typescript
// Pre-check: issue の更新有無を軽量クエリで確認し、変化なし時はフル fetch をスキップする。
// force / fullFetch / 初回同期（last_synced_at 空）の場合はバイパス。
const skipPrecheck = opts.force || opts.fullFetch || !syncState.last_synced_at;
if (!skipPrecheck) {
  const hasChanges = await checkRemoteChanges(gql, owner, repoName, syncState.last_synced_at);
  if (!hasChanges) {
    return {
      result: {
        added: 0,
        updated: 0,
        removed: 0,
        conflicts: 0,
        hasConflicts: false,
        details: [],
        skipped: true,
        syncStateFindings,
      },
      tasksFile,
      syncState,
    };
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm --filter @gh-gantt/cli exec vp test run src/__tests__/pull-precheck.test.ts`
Expected: 5 tests passed

- [ ] **Step 5: 既存テストが壊れていないことを確認**

Run: `pnpm --filter @gh-gantt/cli test`
Expected: all tests passed

- [ ] **Step 6: コミット**

```bash
git add packages/cli/src/__tests__/pull-precheck.test.ts packages/cli/src/sync/pull-executor.ts
git commit -m "feat(sync): pull-executor に pre-check フローを挿入 (#157)"
```

---

### Task 4: --full-fetch オプションの追加

**Files:**

- Modify: `packages/cli/src/commands/pull.ts`

- [ ] **Step 1: オプションを追加**

`pull.ts` の `.option("--json", ...)` の後に追加:

```typescript
  .option("--full-fetch", "Skip pre-check and always fetch all project data")
```

- [ ] **Step 2: executePull の呼び出しに fullFetch を渡す**

既存の `executePull` 呼び出し（行43付近）を変更:

```typescript
    } = await executePull(gql, config, tasksFile, syncState, {
      force: opts.force,
      fullFetch: opts.fullFetch,
    });
```

- [ ] **Step 3: ビルド確認**

Run: `pnpm build`
Expected: success

- [ ] **Step 4: lint 確認**

Run: `pnpm lint`
Expected: pass

- [ ] **Step 5: 全テスト実行**

Run: `pnpm test`
Expected: all passed

- [ ] **Step 6: コミット**

```bash
git add packages/cli/src/commands/pull.ts
git commit -m "feat(sync): pull に --full-fetch オプションを追加 (#157)"
```
