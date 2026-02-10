---
name: gh-gantt-workflow
description: GitHub Issue-driven development workflow using gh-gantt for task synchronization and Gantt chart visualization. Use when (1) starting work on a GitHub Issue, (2) setting up gh-gantt for a project, (3) syncing tasks between local and GitHub Projects, (4) creating feature branches tied to issues, (5) managing project progress with Gantt charts, (6) creating or pushing draft tasks to GitHub.
---

# gh-gantt Workflow

Issue-driven development with gh-gantt for bidirectional sync between GitHub Projects (V2) and local task files, with interactive Gantt chart visualization.

## Setup

Initialize for an existing GitHub Project:

```bash
gh-gantt init --owner <owner> --repo <repo> --project <number>
```

This creates `.gantt-sync/` with config, tasks, and sync state. Add `.gantt-sync/` to `.gitignore`.

For command details: see [references/commands.md](references/commands.md).

## Development Cycle

### 1. Sync & Select

Pull latest project state and pick an issue:

```bash
gh-gantt pull
gh issue list
gh issue view <number>
```

Optionally visualize with `gh-gantt serve` (opens Gantt chart at http://localhost:3000).

### 2. Branch

Create a feature branch from the issue:

```
feat/issue-<number>-<short-description>    # features
fix/issue-<number>-<short-description>     # bug fixes
```

```bash
git checkout -b feat/issue-<number>-<description> main
```

### 3. Develop & Verify

Implement the change. Run project-specific checks before committing:

- Type checking
- Tests
- Build verification

### 4. Commit & PR

Commit with conventional commit messages (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).

Create a PR referencing the issue:

```bash
git push -u origin <branch-name>
gh pr create --title "<title>" --body "Closes #<number>"
```

### 5. Sync Back

After merge, sync the updated state:

```bash
gh-gantt pull
```

## Task Creation

Create draft tasks locally and push to GitHub:

```bash
gh-gantt create --title "New feature" --type feature --start-date 2025-03-01 --end-date 2025-03-15
gh-gantt push
```

Or create via the Gantt UI (`gh-gantt serve`).

## Status Check

Review sync state and pending changes:

```bash
gh-gantt status
```

Shows local changes, remote changes, conflicts, and draft tasks.

## Quick Reference

| Phase | Commands |
|-------|----------|
| Start of work | `gh-gantt pull` → `gh issue view <n>` → `git checkout -b feat/issue-<n>-...` |
| During work | `gh-gantt serve` for visualization |
| End of work | commit → PR with `Closes #<n>` → merge → `gh-gantt pull` |
| New task | `gh-gantt create` → `gh-gantt push` |
| Check status | `gh-gantt status` |

For full command reference: see [references/commands.md](references/commands.md).
