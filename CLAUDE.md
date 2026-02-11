# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

gh-gantt is a GitHub Projects Gantt chart tool with hierarchical progress tracking. It syncs tasks bidirectionally with GitHub Projects (V2) via GraphQL API and renders an interactive Gantt chart in the browser. Authentication uses `gh auth token` (GitHub CLI).

## Commands

```bash
# Install dependencies
pnpm install

# Build all packages (shared must build first as cli/ui depend on it)
pnpm build

# Dev mode (runs all packages in parallel - CLI watch + Vite dev server)
pnpm dev

# Run all tests
pnpm test

# Run tests for a single package
pnpm --filter @gh-gantt/cli test
pnpm --filter @gh-gantt/shared test
pnpm --filter @gh-gantt/ui test

# Run a single test file
pnpm --filter @gh-gantt/cli exec vitest run src/__tests__/hash.test.ts

# Type checking
pnpm typecheck

# CLI entry point (after build)
./gh-gantt <command>
```

## Architecture

**Monorepo** using pnpm workspaces with three packages under `packages/`:

### `@gh-gantt/shared` — Shared types and validation
- `types.ts` — Core domain types: `Task`, `Config`, `SyncState`, `TasksFile`
- `schema.ts` — Zod schemas mirroring every type (used for JSON file validation)
- `constants.ts` — File paths (`.gantt-sync/` dir), port numbers

### `@gh-gantt/cli` — Node.js CLI (Commander + Express)
- **Commands** (`commands/`): `init`, `pull`, `push`, `status`, `serve`
- **GitHub layer** (`github/`): GraphQL client via `@octokit/graphql`, queries for Projects V2, issue mutations, sub-issue link resolution
- **Store** (`store/`): File-based persistence — reads/writes JSON files in `.gantt-sync/` directory (`gantt.config.json`, `tasks.json`, `sync-state.json`), validates with Zod on read
- **Sync engine** (`sync/`): Diff computation, hash-based change detection, conflict resolution, remote-to-local field mapping
- **Server** (`server/api.ts`): Express REST API mounted by `serve` command — `GET /api/config`, `GET /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/sync/pull`, `POST /api/sync/push`, `GET /api/sync/status`

### `@gh-gantt/ui` — React SPA (Vite + D3)
- `App.tsx` — Root component wiring together tree view, Gantt chart, toolbar, and detail panel
- **Components** (`components/`): `GanttChart` (D3-based timeline with bars/milestones/summary), `TaskTree` (hierarchical task list), `TaskDetailPanel` (side panel editor), `Toolbar` (zoom/view controls + sync buttons)
- **Hooks** (`hooks/`): `useApi` (data fetching), `useTaskTree` (hierarchy flattening + collapse), `useGanttScale` (D3 time scale + zoom), `useDragResize` (bar drag/resize), `useTypeFilter`
- **Lib** (`lib/`): Pure utility functions — `date-utils`, `dependency-graph`, `progress`, `summary-calc`

### Data Flow
1. `gh-gantt init` scaffolds `.gantt-sync/` with config
2. `gh-gantt pull` fetches from GitHub Projects V2 → writes `tasks.json`
3. `gh-gantt serve` starts Express (port 3000) serving both API and built UI
4. In dev mode, Vite dev server (port 5173) proxies `/api` to Express
5. UI fetches tasks/config via REST, edits go through `PATCH /api/tasks/:id`
6. `push` (via API or CLI) diffs local tasks against snapshots and updates GitHub

## Key Conventions

- **ESM throughout** — all packages use `"type": "module"`, imports need `.js` extensions
- **Zod validation on all file reads** — stores parse JSON through schemas, never trust raw data
- **Build tool**: tsup for cli/shared, Vite for ui
- **Test framework**: Vitest (no separate config files, uses package.json scripts)
- **TypeScript target**: ES2022, strict mode, bundler module resolution
- **Local state directory**: `.gantt-sync/` (gitignored) holds all project data files

## Task Management via CLI

**IMPORTANT: `.gantt-sync/tasks.json` を直接編集してはならない。**
常に CLI コマンドでタスクを管理すること。直接編集はバリデーションをバイパスし、同期状態を破損させる可能性がある。

### よく使うコマンド
```bash
# タスク作成
./gh-gantt create --title "タスク名" --type task --start-date 2026-03-01 --end-date 2026-03-15

# タスク更新（単体）
./gh-gantt task update 6 --milestone v1.0
./gh-gantt task update 6 --start-date 2026-03-01 --end-date 2026-03-15
./gh-gantt task update 6 --label priority

# タスク更新（バルク）
./gh-gantt task update --filter-state open --milestone v1.0

# 依存関係・親子関係
./gh-gantt task link 7 --blocked-by 6
./gh-gantt task link 6 --set-parent draft-1

# マイルストーン
./gh-gantt milestone list
./gh-gantt milestone create "v1.0" --due-date 2026-06-01

# マイルストーン作成 → GitHub に反映
./gh-gantt milestone create "v2.0" --due-date 2026-12-01
./gh-gantt push  # GitHub Milestone が自動作成される（Issue ではなく Milestone として）

# 同期
./gh-gantt pull && ./gh-gantt push
```
