# #69 タスク詳細パネルのレイアウト改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TaskDetailPanel を GitHub Issue 風の2カラムレイアウトに改善し、Description への到達性を向上させる

**Architecture:** TaskDetailPanel を3つのサブコンポーネント（DetailHeader, DetailMainContent, DetailMetaSidebar）に分割。パネル幅に応じて2カラム/1カラムを切り替える。Sub-tasks はツリー表示にする。

**Tech Stack:** React, TypeScript (ESM), Vitest, CSS Custom Properties

---

## File Structure

| File                                                      | Action  | Responsibility                                                           |
| --------------------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `packages/ui/src/components/detail/DetailHeader.tsx`      | Create  | パンくずタイトル + State バッジ + Progress                               |
| `packages/ui/src/components/detail/DetailMetaSidebar.tsx` | Create  | 右サイドバーのメタフィールド（2カラム時）/ インラインバッジ（1カラム時） |
| `packages/ui/src/components/detail/DetailSubTasks.tsx`    | Create  | Sub-tasks ツリー表示                                                     |
| `packages/ui/src/components/detail/DetailRelations.tsx`   | Create  | Blocked by + Linked PRs（タイトル付き）                                  |
| `packages/ui/src/components/TaskDetailPanel.tsx`          | Rewrite | 上記コンポーネントを組み合わせて2カラム/1カラム切り替え                  |
| `packages/ui/src/App.tsx`                                 | Modify  | tasks 配列を TaskDetailPanel に渡す（タイトル解決用）                    |
| `packages/ui/src/__tests__/detail-header.test.tsx`        | Create  | DetailHeader テスト                                                      |
| `packages/ui/src/__tests__/detail-sub-tasks.test.tsx`     | Create  | DetailSubTasks テスト                                                    |
| `packages/ui/src/__tests__/detail-panel.test.tsx`         | Create  | TaskDetailPanel 統合テスト                                               |

---

### Task 1: DetailHeader — パンくずタイトル + State バッジ

**Files:**

- Create: `packages/ui/src/components/detail/DetailHeader.tsx`
- Test: `packages/ui/src/__tests__/detail-header.test.tsx`

- [ ] **Step 1: テストを書く**

```tsx
// packages/ui/src/__tests__/detail-header.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailHeader } from "../components/detail/DetailHeader.js";

const baseTask = {
  id: "owner/repo#1",
  title: "Test task",
  github_issue: 1,
  github_repo: "owner/repo",
  state: "open" as const,
  parent: null,
  _progress: 50,
};

describe("DetailHeader", () => {
  it("renders task title with issue number", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );
    expect(html).toContain("Test task");
    expect(html).toContain("#1");
  });

  it("renders parent breadcrumb when parent exists", () => {
    const parent = { id: "owner/repo#10", title: "Parent Epic", github_issue: 10 };
    const html = renderToStaticMarkup(
      <DetailHeader
        task={{ ...baseTask, parent: "owner/repo#10" }}
        parentTask={parent}
        onSelectTask={() => {}}
      />,
    );
    expect(html).toContain("Parent Epic");
    expect(html).toContain("#10");
    expect(html).toContain("Test task");
  });

  it("does not render parent breadcrumb when parent is null", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );
    expect(html).not.toContain("Parent Epic");
  });

  it("renders open state badge", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );
    expect(html).toContain("Open");
  });

  it("renders progress bar", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );
    expect(html).toContain("50%");
  });

  it("links title to GitHub issue", () => {
    const html = renderToStaticMarkup(
      <DetailHeader task={baseTask} parentTask={null} onSelectTask={() => {}} />,
    );
    expect(html).toContain("https://github.com/owner/repo/issues/1");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/ui && pnpm exec vp test run src/__tests__/detail-header.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: DetailHeader を実装**

```tsx
// packages/ui/src/components/detail/DetailHeader.tsx
import React from "react";
import { ProgressBar } from "../ProgressBar.js";

interface DetailHeaderProps {
  task: {
    id: string;
    title: string;
    github_issue: number | null;
    github_repo: string;
    state: "open" | "closed";
    parent: string | null;
    _progress?: number;
  };
  parentTask: { id: string; title: string; github_issue: number | null } | null;
  onSelectTask: (taskId: string) => void;
  isMilestone?: boolean;
  taskTypeColor?: string;
}

export function DetailHeader({
  task,
  parentTask,
  onSelectTask,
  isMilestone,
  taskTypeColor,
}: DetailHeaderProps) {
  const githubUrl = isMilestone
    ? (() => {
        const suffix = task.id.split("#").pop();
        return suffix && /^\d+$/.test(suffix) && task.github_repo
          ? `https://github.com/${task.github_repo}/milestone/${suffix}`
          : null;
      })()
    : task.github_issue
      ? `https://github.com/${task.github_repo}/issues/${task.github_issue}`
      : null;

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Parent breadcrumb */}
      {parentTask && (
        <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>
          <a
            onClick={() => onSelectTask(parentTask.id)}
            style={{ color: "var(--color-text-muted)", cursor: "pointer", textDecoration: "none" }}
          >
            {parentTask.title}{" "}
            {parentTask.github_issue != null && (
              <span style={{ color: "var(--color-text-muted)", opacity: 0.6 }}>
                #{parentTask.github_issue}
              </span>
            )}
          </a>
        </div>
      )}

      {/* Current task title */}
      <div>
        {githubUrl ? (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: "var(--color-info)",
              textDecoration: "none",
            }}
          >
            {task.title}{" "}
            <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>
              #{task.github_issue ?? task.id.split("#").pop()}
            </span>{" "}
            ↗
          </a>
        ) : (
          <span style={{ fontSize: 17, fontWeight: 600, color: "var(--color-text)" }}>
            {task.title}
          </span>
        )}
      </div>

      {/* State badge */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
        <span
          style={{
            padding: "2px 10px",
            fontSize: 12,
            background:
              task.state === "open" ? "var(--color-success-bg)" : "var(--color-complete-bg)",
            color: task.state === "open" ? "var(--color-success)" : "var(--color-complete)",
            borderRadius: 12,
          }}
        >
          {task.state === "open" ? "● Open" : "● Closed"}
        </span>
      </div>

      {/* Progress bar */}
      {!isMilestone && task._progress != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <ProgressBar progress={task._progress} color={taskTypeColor} />
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{task._progress}%</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd packages/ui && pnpm exec vp test run src/__tests__/detail-header.test.tsx`
Expected: 6 tests passed

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/components/detail/DetailHeader.tsx packages/ui/src/__tests__/detail-header.test.tsx
git commit -m "feat(ui): DetailHeader パンくずタイトル + State バッジコンポーネント (#69)"
```

---

### Task 2: DetailSubTasks — ツリー表示

**Files:**

- Create: `packages/ui/src/components/detail/DetailSubTasks.tsx`
- Test: `packages/ui/src/__tests__/detail-sub-tasks.test.tsx`

- [ ] **Step 1: テストを書く**

```tsx
// packages/ui/src/__tests__/detail-sub-tasks.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailSubTasks } from "../components/detail/DetailSubTasks.js";
import type { Task } from "../types/index.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "r#1",
    type: "task",
    github_issue: 1,
    github_repo: "r",
    parent: null,
    sub_tasks: [],
    title: "Task",
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

describe("DetailSubTasks", () => {
  it("renders nothing when sub_tasks is empty", () => {
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={[]} allTasks={[]} onSelectTask={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("renders sub-task titles and issue numbers", () => {
    const tasks = [
      makeTask({ id: "r#2", title: "Child A", github_issue: 2, state: "open" }),
      makeTask({ id: "r#3", title: "Child B", github_issue: 3, state: "closed" }),
    ];
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={["r#2", "r#3"]} allTasks={tasks} onSelectTask={() => {}} />,
    );
    expect(html).toContain("Child A");
    expect(html).toContain("#2");
    expect(html).toContain("Child B");
    expect(html).toContain("#3");
    expect(html).toContain("Open");
    expect(html).toContain("Closed");
    expect(html).toContain("Sub-tasks (2)");
  });

  it("renders nested children with indentation", () => {
    const tasks = [
      makeTask({ id: "r#2", title: "Parent Child", github_issue: 2, sub_tasks: ["r#4"] }),
      makeTask({ id: "r#4", title: "Grandchild", github_issue: 4 }),
    ];
    const html = renderToStaticMarkup(
      <DetailSubTasks subTaskIds={["r#2"]} allTasks={tasks} onSelectTask={() => {}} />,
    );
    expect(html).toContain("Parent Child");
    expect(html).toContain("Grandchild");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/ui && pnpm exec vp test run src/__tests__/detail-sub-tasks.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: DetailSubTasks を実装**

```tsx
// packages/ui/src/components/detail/DetailSubTasks.tsx
import React, { useState } from "react";
import type { Task } from "../../types/index.js";

interface DetailSubTasksProps {
  subTaskIds: string[];
  allTasks: Task[];
  onSelectTask: (taskId: string) => void;
}

export function DetailSubTasks({ subTaskIds, allTasks, onSelectTask }: DetailSubTasksProps) {
  if (subTaskIds.length === 0) return null;

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--color-text-muted)",
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        Sub-tasks ({subTaskIds.length})
      </div>
      <div style={{ fontSize: 12 }}>
        {subTaskIds.map((id) => {
          const task = taskMap.get(id);
          return (
            <SubTaskNode
              key={id}
              taskId={id}
              task={task}
              depth={0}
              taskMap={taskMap}
              onSelectTask={onSelectTask}
            />
          );
        })}
      </div>
    </div>
  );
}

function SubTaskNode({
  taskId,
  task,
  depth,
  taskMap,
  onSelectTask,
}: {
  taskId: string;
  task: Task | undefined;
  depth: number;
  taskMap: Map<string, Task>;
  onSelectTask: (taskId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const children = task?.sub_tasks ?? [];
  const hasChildren = children.length > 0;
  const issueNum = taskId.split("#").pop();

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 0",
          paddingLeft: depth * 20,
        }}
      >
        {/* Collapse toggle */}
        {hasChildren ? (
          <span
            onClick={() => setCollapsed((c) => !c)}
            style={{
              color: "var(--color-text-muted)",
              cursor: "pointer",
              fontSize: 10,
              width: 14,
              textAlign: "center",
              userSelect: "none",
            }}
          >
            {collapsed ? "▶" : "▼"}
          </span>
        ) : (
          <span style={{ width: 14 }} />
        )}

        {/* State dot */}
        <span
          style={{
            color: task?.state === "closed" ? "var(--color-complete)" : "var(--color-in-progress)",
          }}
        >
          ●
        </span>

        {/* Issue number */}
        <span
          onClick={() => onSelectTask(taskId)}
          style={{ color: "var(--color-info)", cursor: "pointer" }}
        >
          #{issueNum}
        </span>

        {/* Title */}
        <span
          style={{
            color: "var(--color-text)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task?.title ?? taskId}
        </span>

        {/* State badge */}
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            background:
              task?.state === "closed" ? "var(--color-complete-bg)" : "var(--color-border-light)",
            color: task?.state === "closed" ? "var(--color-complete)" : "var(--color-text-muted)",
            borderRadius: 12,
            flexShrink: 0,
          }}
        >
          {task?.state === "closed" ? "Closed" : "Open"}
        </span>
      </div>

      {/* Children */}
      {hasChildren &&
        !collapsed &&
        children.map((childId) => (
          <SubTaskNode
            key={childId}
            taskId={childId}
            task={taskMap.get(childId)}
            depth={depth + 1}
            taskMap={taskMap}
            onSelectTask={onSelectTask}
          />
        ))}
    </>
  );
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd packages/ui && pnpm exec vp test run src/__tests__/detail-sub-tasks.test.tsx`
Expected: 3 tests passed

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/components/detail/DetailSubTasks.tsx packages/ui/src/__tests__/detail-sub-tasks.test.tsx
git commit -m "feat(ui): DetailSubTasks ツリー表示コンポーネント (#69)"
```

---

### Task 3: DetailRelations — Blocked by + Linked PRs

**Files:**

- Create: `packages/ui/src/components/detail/DetailRelations.tsx`

- [ ] **Step 1: DetailRelations を実装**

```tsx
// packages/ui/src/components/detail/DetailRelations.tsx
import React from "react";
import type { Task, Dependency } from "../../types/index.js";

interface DetailRelationsProps {
  blockedBy: Dependency[];
  linkedPrs: number[];
  allTasks: Task[];
  onSelectTask: (taskId: string) => void;
  githubRepo: string;
}

export function DetailRelations({
  blockedBy,
  linkedPrs,
  allTasks,
  onSelectTask,
  githubRepo,
}: DetailRelationsProps) {
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  if (blockedBy.length === 0 && linkedPrs.length === 0) return null;

  return (
    <>
      {blockedBy.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 11,
              color: "var(--color-text-muted)",
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            Blocked by
          </div>
          {blockedBy.map((dep) => {
            const depTask = taskMap.get(dep.task);
            const issueNum = dep.task.split("#").pop();
            return (
              <div
                key={dep.task}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  padding: "3px 0",
                }}
              >
                <span style={{ color: "var(--color-danger)" }}>⊘</span>
                <span
                  onClick={() => onSelectTask(dep.task)}
                  style={{ color: "var(--color-info)", cursor: "pointer" }}
                >
                  #{issueNum}
                </span>
                <span
                  style={{
                    color: "var(--color-text)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {depTask?.title ?? dep.task}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {linkedPrs.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 11,
              color: "var(--color-text-muted)",
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            Linked PRs
          </div>
          {linkedPrs.map((pr) => (
            <div
              key={pr}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                padding: "3px 0",
              }}
            >
              <span style={{ color: "var(--color-complete)" }}>⊕</span>
              <a
                href={`https://github.com/${githubRepo}/pull/${pr}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--color-info)", textDecoration: "none" }}
              >
                #{pr}
              </a>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: 成功

- [ ] **Step 3: コミット**

```bash
git add packages/ui/src/components/detail/DetailRelations.tsx
git commit -m "feat(ui): DetailRelations Blocked by/Linked PRs コンポーネント (#69)"
```

---

### Task 4: DetailMetaSidebar — 右サイドバー

**Files:**

- Create: `packages/ui/src/components/detail/DetailMetaSidebar.tsx`

- [ ] **Step 1: DetailMetaSidebar を実装**

既存の TaskDetailPanel.tsx のメタフィールド部分（Status, Priority, State, Type, Dates, Assignees, Labels, Milestone）を抽出して、サイドバー向けの縦1列レイアウトに再構成する。

```tsx
// packages/ui/src/components/detail/DetailMetaSidebar.tsx
import React from "react";
import type { Task, Config } from "../../types/index.js";

interface DetailMetaSidebarProps {
  task: Task;
  config: Config;
  onUpdate: (updates: Partial<Task>) => void;
  isMilestone: boolean;
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-muted)",
  marginBottom: 4,
  fontWeight: 600,
  display: "block",
};

const selectStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  width: "100%",
};

const dateInputStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  width: "100%",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 14,
};

const separatorStyle: React.CSSProperties = {
  marginBottom: 14,
  paddingTop: 10,
  borderTop: "1px solid var(--color-border-light)",
};

export function DetailMetaSidebar({ task, config, onUpdate, isMilestone }: DetailMetaSidebarProps) {
  const statusFieldName = config.statuses.field_name;
  const currentStatus = task.custom_fields[statusFieldName] as string | undefined;
  const statusOptions = Object.keys(config.statuses.values);

  return (
    <div style={{ fontSize: 12 }}>
      {/* Status */}
      {!isMilestone && (
        <div style={sectionStyle}>
          <label style={labelStyle}>Status</label>
          <select
            value={currentStatus ?? ""}
            onChange={(e) =>
              onUpdate({
                custom_fields: { ...task.custom_fields, [statusFieldName]: e.target.value },
              })
            }
            style={selectStyle}
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Priority */}
      {!isMilestone &&
        (() => {
          const priorityFieldName = config.sync?.field_mapping?.priority;
          if (!priorityFieldName) return null;
          const rawPriority = task.custom_fields[priorityFieldName];
          const currentPriority = typeof rawPriority === "string" ? rawPriority.toLowerCase() : "";
          return (
            <div style={sectionStyle}>
              <label style={labelStyle}>Priority</label>
              <select
                value={currentPriority}
                onChange={(e) =>
                  onUpdate({
                    custom_fields: {
                      ...task.custom_fields,
                      [priorityFieldName]: e.target.value || undefined,
                    },
                  })
                }
                style={selectStyle}
              >
                <option value="">None</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          );
        })()}

      {/* Type */}
      {!isMilestone && (
        <div style={sectionStyle}>
          <label style={labelStyle}>Type</label>
          <select
            value={task.type}
            onChange={(e) => onUpdate({ type: e.target.value })}
            style={selectStyle}
          >
            {Object.entries(config.task_types)
              .filter(([name]) => name !== "milestone")
              .map(([name, def]) => (
                <option key={name} value={name}>
                  {def.label}
                </option>
              ))}
          </select>
        </div>
      )}

      {/* Dates */}
      <div style={separatorStyle}>
        {isMilestone ? (
          <div>
            <label style={labelStyle}>Due Date</label>
            <input
              type="date"
              value={(task.date ?? "").slice(0, 10)}
              onChange={(e) => onUpdate({ date: e.target.value || null })}
              style={dateInputStyle}
            />
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>Start Date</label>
              <input
                type="date"
                value={(task.start_date ?? "").slice(0, 10)}
                onChange={(e) => onUpdate({ start_date: e.target.value || null })}
                style={dateInputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>End Date</label>
              <input
                type="date"
                value={(task.end_date ?? "").slice(0, 10)}
                onChange={(e) => onUpdate({ end_date: e.target.value || null })}
                style={dateInputStyle}
              />
            </div>
          </>
        )}
      </div>

      {/* Assignees */}
      {!isMilestone && (
        <div style={separatorStyle}>
          <label style={labelStyle}>Assignees</label>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {task.assignees.map((a) => (
              <span
                key={a}
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  background: "var(--color-selected-bg)",
                  borderRadius: 12,
                }}
              >
                {a}
              </span>
            ))}
            {task.assignees.length === 0 && (
              <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>None</span>
            )}
          </div>
        </div>
      )}

      {/* Labels */}
      {!isMilestone && (
        <div style={sectionStyle}>
          <label style={labelStyle}>Labels</label>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {task.labels.map((l) => (
              <span
                key={l}
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  background: "var(--color-border-light)",
                  borderRadius: 3,
                }}
              >
                {l}
              </span>
            ))}
            {task.labels.length === 0 && (
              <span style={{ color: "var(--color-text-muted)", fontSize: 11 }}>None</span>
            )}
          </div>
        </div>
      )}

      {/* Milestone */}
      {task.milestone && (
        <div style={sectionStyle}>
          <label style={labelStyle}>Milestone</label>
          <span style={{ color: "var(--color-text)" }}>{task.milestone}</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm build`
Expected: 成功

- [ ] **Step 3: コミット**

```bash
git add packages/ui/src/components/detail/DetailMetaSidebar.tsx
git commit -m "feat(ui): DetailMetaSidebar 右サイドバーコンポーネント (#69)"
```

---

### Task 5: TaskDetailPanel リライト — 2カラム/1カラム切り替え

**Files:**

- Rewrite: `packages/ui/src/components/TaskDetailPanel.tsx`
- Modify: `packages/ui/src/App.tsx`
- Test: `packages/ui/src/__tests__/detail-panel.test.tsx`

- [ ] **Step 1: テストを書く**

```tsx
// packages/ui/src/__tests__/detail-panel.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskDetailPanel } from "../components/TaskDetailPanel.js";
import type { Task, Config } from "../types/index.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "r#1",
    type: "task",
    github_issue: 1,
    github_repo: "r",
    parent: null,
    sub_tasks: [],
    title: "Test",
    body: "desc",
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

const config: Config = {
  version: "1",
  project: { name: "test", github: { owner: "r", repo: "r", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start", end_date: "End", status: "Status" },
  },
  task_types: { task: { label: "Task", display: "bar", color: "#00f", github_label: null } },
  type_hierarchy: {},
  statuses: { field_name: "Status", values: { Todo: { color: "#ccc", done: false } } },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
};

describe("TaskDetailPanel", () => {
  it("renders title with issue number", () => {
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={makeTask()}
        config={config}
        comments={[]}
        allTasks={[makeTask()]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );
    expect(html).toContain("Test");
    expect(html).toContain("#1");
  });

  it("renders description", () => {
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={makeTask()}
        config={config}
        comments={[]}
        allTasks={[makeTask()]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );
    expect(html).toContain("desc");
  });

  it("renders sub-tasks with titles", () => {
    const parent = makeTask({ id: "r#1", sub_tasks: ["r#2"] });
    const child = makeTask({ id: "r#2", title: "Child Task", github_issue: 2 });
    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={parent}
        config={config}
        comments={[]}
        allTasks={[parent, child]}
        onUpdate={() => {}}
        onClose={() => {}}
        onSelectTask={() => {}}
      />,
    );
    expect(html).toContain("Child Task");
    expect(html).toContain("#2");
  });
});
```

- [ ] **Step 2: TaskDetailPanel をリライト**

新しい TaskDetailPanel は以下の構成：

- props に `allTasks: Task[]` と `onSelectTask: (taskId: string) => void` を追加
- `width` に応じて2カラム（≥560px）/1カラム（＜560px）を切り替え
- DetailHeader, DetailMetaSidebar, DetailSubTasks, DetailRelations を組み合わせ
- タイトル編集、JSONコピー、コメント表示は既存ロジックを維持

- [ ] **Step 3: App.tsx を修正**

`TaskDetailPanel` に `allTasks={tasks}` と `onSelectTask={handleSelectTask}` を渡す。

- [ ] **Step 4: ビルド・テスト・lint 確認**

Run: `pnpm build && pnpm --filter @gh-gantt/ui test && pnpm lint`
Expected: 全 pass

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/components/TaskDetailPanel.tsx packages/ui/src/App.tsx packages/ui/src/__tests__/detail-panel.test.tsx
git commit -m "feat(ui): TaskDetailPanel 2カラムレイアウト統合 (#69)"
```

---

### Task 6: 最終検証 + フォーマット

- [ ] **Step 1: 全テスト実行**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: 全 pass、0 errors

- [ ] **Step 2: フォーマット修正（必要なら）**

Run: `pnpm exec vp check --fix`

- [ ] **Step 3: 最終コミット（必要なら）**

```bash
git add -A && git commit -m "chore(ui): フォーマット修正 (#69)"
```
