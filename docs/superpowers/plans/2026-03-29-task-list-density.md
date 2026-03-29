# Task List Density Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TaskRow の表示密度を改善し、タイトル領域を ~132px 拡大する。ProgressBar を行背景に統合、PriorityBadge をアンテナアイコンに、StatusBadge を形状変化アイコンに変更する。

**Architecture:** 3つのコンポーネント（ProgressBar, PriorityBadge, StatusBadge）を段階的に改修。ProgressBar は TaskRow の背景レイヤーにインライン化（DetailHeader での使用は維持）。PriorityBadge と StatusBadge は既存の props インターフェースを維持したまま内部実装を書き換える。

**Tech Stack:** React, TypeScript, SVG (inline), CSS custom properties

**Spec:** `docs/superpowers/specs/2026-03-29-task-list-density-design.md`

---

## File Map

| Action  | File                                           | Responsibility                            |
| ------- | ---------------------------------------------- | ----------------------------------------- |
| Modify  | `packages/ui/src/components/TaskRow.tsx`       | ProgressBar import 削除、背景レイヤー追加 |
| Keep    | `packages/ui/src/components/ProgressBar.tsx`   | DetailHeader が引き続き使用するため残す   |
| Rewrite | `packages/ui/src/components/PriorityBadge.tsx` | アンテナアイコンに書き換え                |
| Rewrite | `packages/ui/src/components/StatusBadge.tsx`   | 形状変化 SVG アイコンに書き換え           |
| Modify  | `e2e/task-detail.spec.ts`                      | StatusBadge のテキスト参照を修正          |

---

### Task 1: ProgressBar の背景統合

**Files:**

- Modify: `packages/ui/src/components/TaskRow.tsx:1-5` (import), `packages/ui/src/components/TaskRow.tsx:108-189` (style), `packages/ui/src/components/TaskRow.tsx:314` (ProgressBar 使用箇所)

- [ ] **Step 1: TaskRow から ProgressBar import を削除**

`packages/ui/src/components/TaskRow.tsx` の import セクションを編集:

```tsx
// 削除: import { ProgressBar } from "./ProgressBar.js";
```

行 5 の `import { ProgressBar } from "./ProgressBar.js";` を削除する。

- [ ] **Step 2: TaskRow のルート div に position: relative と overflow: hidden を追加**

`packages/ui/src/components/TaskRow.tsx` の style オブジェクト（行 174-188）を編集。既に `position: "relative"` があるのでそのまま。`overflow: "hidden"` を追加:

```tsx
style={{
  display: "flex",
  position: "relative",
  alignItems: "center",
  gap: 6,
  padding: "3px 8px",
  paddingLeft: dropBorderLeft ? 5 + indent : 8 + indent,
  cursor: isDraggable ? "grab" : "pointer",
  background: bg,
  borderBottom: "1px solid var(--color-border-light)",
  borderLeft: dropBorderLeft,
  height: 28,
  minWidth: 0,
  opacity: isDragging ? 0.3 : isDimmed ? 0.4 : 1,
  overflow: "hidden",
}}
```

- [ ] **Step 3: 背景レイヤーを追加**

TaskRow の return 内、ルート div の最初の子要素（`{hasChildren ? (` の前）に背景レイヤーを追加:

```tsx
{
  /* Progress background layer */
}
{
  !isMilestone && progress > 0 && (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: `${progress}%`,
        background:
          progress === 100
            ? "rgba(137, 87, 229, 0.08)"
            : taskType
              ? `${taskType.color}14`
              : "rgba(63, 185, 80, 0.08)",
        pointerEvents: "none",
      }}
    />
  );
}
```

注: `${taskType.color}14` は 6桁 hex + `14` で 8% opacity。taskType.color が RGB hex（例: `#27AE60`）であることを前提とする。taskType が undefined の場合は緑のフォールバック。

- [ ] **Step 4: ProgressBar コンポーネントの呼び出しを削除**

行 314 の以下を削除:

```tsx
// 削除:
{
  !isMilestone && <ProgressBar progress={progress} color={taskType?.color} />;
}
```

- [ ] **Step 5: ビルド確認**

Run: `pnpm --filter @gh-gantt/ui exec vp build`
Expected: ビルド成功（エラーなし）

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/components/TaskRow.tsx
git commit -m "feat(ui): integrate progress bar as row background layer (#103)"
```

---

### Task 2: PriorityBadge のアンテナアイコン化

**Files:**

- Rewrite: `packages/ui/src/components/PriorityBadge.tsx`

- [ ] **Step 1: PriorityBadge を書き換え**

`packages/ui/src/components/PriorityBadge.tsx` を以下に書き換え:

```tsx
import React from "react";

export const PRIORITY_LEVELS = ["critical", "high", "medium", "low"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

const PRIORITY_CONFIG: Record<PriorityLevel, { bars: number; color: string }> = {
  critical: { bars: 4, color: "#e74c3c" },
  high: { bars: 3, color: "#f39c12" },
  medium: { bars: 2, color: "#3498db" },
  low: { bars: 1, color: "#888" },
};

const BAR_HEIGHTS = [4, 7, 10, 13];
const INACTIVE_COLOR = "rgba(200, 200, 200, 0.4)";

interface PriorityBadgeProps {
  priority: string | undefined;
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  if (!priority || typeof priority !== "string") return null;
  const level = priority.toLowerCase() as PriorityLevel;
  const config = PRIORITY_CONFIG[level];
  if (!config) return null;

  const label =
    level === "critical"
      ? "Critical"
      : level === "high"
        ? "High"
        : level === "medium"
          ? "Medium"
          : "Low";

  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "flex-end",
        gap: 1,
        height: 14,
        flexShrink: 0,
      }}
    >
      {BAR_HEIGHTS.map((h, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: h,
            borderRadius: 0.5,
            background: i < config.bars ? config.color : INACTIVE_COLOR,
          }}
        />
      ))}
    </span>
  );
}

export function getPriorityColor(priority: string | undefined): string | null {
  if (!priority || typeof priority !== "string") return null;
  const level = priority.toLowerCase() as PriorityLevel;
  return PRIORITY_CONFIG[level]?.color ?? null;
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm --filter @gh-gantt/ui exec vp build`
Expected: ビルド成功

- [ ] **Step 3: コミット**

```bash
git add packages/ui/src/components/PriorityBadge.tsx
git commit -m "feat(ui): replace priority badge with antenna icon (#103)"
```

---

### Task 3: StatusBadge の形状変化アイコン化

**Files:**

- Rewrite: `packages/ui/src/components/StatusBadge.tsx`

- [ ] **Step 1: StatusBadge を書き換え**

`packages/ui/src/components/StatusBadge.tsx` を以下に書き換え:

```tsx
import React from "react";
import type { StatusValue } from "../types/index.js";

interface StatusBadgeProps {
  status: string | undefined;
  statusValues: Record<string, StatusValue>;
}

/** Todo: empty circle */
function TodoIcon() {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        border: "1.5px solid #aaa",
        display: "inline-block",
        boxSizing: "border-box",
        flexShrink: 0,
      }}
    />
  );
}

/** In Progress: play triangle */
function InProgressIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
      <path d="M3 2.5L9.5 6L3 9.5Z" fill="#3fb950" />
    </svg>
  );
}

/** In Review: eye */
function InReviewIcon() {
  return (
    <svg width={14} height={12} viewBox="0 0 14 12" style={{ flexShrink: 0 }}>
      <path
        d="M7 3C4 3 1.5 6 1.5 6S4 9 7 9S12.5 6 12.5 6S10 3 7 3Z"
        fill="none"
        stroke="#f97316"
        strokeWidth={1.2}
      />
      <circle cx={7} cy={6} r={1.5} fill="#f97316" />
    </svg>
  );
}

/** Done: filled circle with checkmark */
function DoneIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
      <circle cx={6} cy={6} r={5} fill="#8957e5" />
      <path
        d="M3.5 6L5.2 7.7L8.5 4.3"
        fill="none"
        stroke="white"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getStatusIcon(status: string, isDone: boolean): React.ReactElement {
  const normalized = status.toLowerCase().replace(/\s+/g, "_");

  if (isDone) return <DoneIcon />;
  if (normalized === "in_progress") return <InProgressIcon />;
  if (normalized === "in_review") return <InReviewIcon />;
  if (normalized === "todo") return <TodoIcon />;

  // Fallback: empty circle for unknown statuses
  return <TodoIcon />;
}

export function StatusBadge({ status, statusValues }: StatusBadgeProps) {
  if (!status) return null;
  const sv = statusValues[status];
  const isDone = sv?.done ?? false;

  return (
    <span title={status} style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
      {getStatusIcon(status, isDone)}
    </span>
  );
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm --filter @gh-gantt/ui exec vp build`
Expected: ビルド成功

- [ ] **Step 3: コミット**

```bash
git add packages/ui/src/components/StatusBadge.tsx
git commit -m "feat(ui): replace status badge with shape-based icons (#103)"
```

---

### Task 4: ダークモード視認性確認

**Files:**

- Modify (if needed): `packages/ui/src/components/PriorityBadge.tsx`, `packages/ui/src/components/StatusBadge.tsx`

- [ ] **Step 1: 開発サーバーを起動して目視確認**

Run: `pnpm dev`

ブラウザで以下を確認:

1. ライトモード: アンテナバーの色、SVG アイコンの色、背景フラット塗りの視認性
2. ダークモード切替: テーマ切替ボタンでダークモードにし、同じ要素の視認性確認
3. アンテナバーの INACTIVE_COLOR がダークモードで見えるか
4. 背景フラット塗りの 8% opacity がダークモードで適切か

- [ ] **Step 2: 必要に応じてダークモード調整**

ダークモードでアンテナバーの非アクティブ色が見えにくい場合、`PriorityBadge.tsx` の `INACTIVE_COLOR` を CSS 変数に変更:

```tsx
// もし調整が必要な場合:
const INACTIVE_COLOR = "var(--color-priority-inactive, rgba(200, 200, 200, 0.4))";
```

`index.html` のダークモード CSS 変数に追加:

```css
--color-priority-inactive: rgba(100, 100, 100, 0.4);
```

問題なければこのステップはスキップ。

- [ ] **Step 3: コミット（変更があれば）**

```bash
git add packages/ui/src/components/PriorityBadge.tsx packages/ui/index.html
git commit -m "fix(ui): adjust dark mode colors for density icons (#103)"
```

---

### Task 5: E2E テスト更新

**Files:**

- Modify: `e2e/task-detail.spec.ts:24`

- [ ] **Step 1: E2E テストの StatusBadge テキスト参照を確認**

`e2e/task-detail.spec.ts` 行 24:

```ts
await expect(page.getByText("In Progress").first()).toBeVisible();
```

StatusBadge がテキストを表示しなくなったため、この行は TaskDetailPanel 内の StatusBadge テキスト表示（DetailHeader）を参照している可能性がある。DetailHeader の StatusBadge は別の表示（インラインバッジ）を使用しているため、まず E2E テストを実行して確認:

Run: `pnpm --filter @gh-gantt/ui exec pnpm exec playwright test`
Expected: テスト結果を確認し、失敗箇所を特定

- [ ] **Step 2: 失敗したテストを修正**

TaskRow 内の StatusBadge がテキストを表示しなくなったため、`page.getByText("In Progress")` が DetailHeader のテキストのみをマッチするか確認。DetailHeader は独自にステータスを表示しているため影響なしの可能性が高い。

失敗した場合は、テストのセレクタを `title` 属性ベースに変更:

```ts
// もし修正が必要な場合:
await expect(page.getByTitle("In Progress").first()).toBeVisible();
```

- [ ] **Step 3: 全テスト通過を確認**

Run: `pnpm --filter @gh-gantt/ui exec pnpm exec playwright test`
Expected: 全テスト PASS

- [ ] **Step 4: コミット（変更があれば）**

```bash
git add e2e/
git commit -m "fix(e2e): update selectors for new status/priority icons (#103)"
```

---

### Task 6: 全体ビルド・テスト確認

- [ ] **Step 1: 型チェック**

Run: `pnpm typecheck`
Expected: エラーなし

- [ ] **Step 2: lint**

Run: `pnpm lint`
Expected: エラーなし

- [ ] **Step 3: 全テスト**

Run: `pnpm test`
Expected: 全テスト PASS

- [ ] **Step 4: 全体ビルド**

Run: `pnpm build`
Expected: 全パッケージビルド成功
