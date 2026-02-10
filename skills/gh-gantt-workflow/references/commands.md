# gh-gantt Command Reference

## Table of Contents

- [init](#init)
- [pull](#pull)
- [push](#push)
- [status](#status)
- [create](#create)
- [serve](#serve)

---

## init

Initialize gh-gantt for a GitHub Project. Creates `.gantt-sync/` directory with config, tasks, and sync state.

```bash
gh-gantt init --owner <owner> --repo <repo> --project <number>
```

**Required options:**
- `--owner <owner>` — GitHub user or org
- `--repo <repo>` — Repository name
- `--project <number>` — GitHub Project number

**Optional options:**
- `--start-date-field <name>` — Custom start date field (default: "Start Date")
- `--end-date-field <name>` — Custom end date field (default: "End Date")
- `--status-field <name>` — Custom status field (default: "Status")

**What it does:**
1. Fetches all items and fields from the GitHub Project (V2)
2. Auto-detects task types from labels (epic, milestone, feature, bug)
3. Resolves sub-issue hierarchy
4. Generates `gantt.config.json`, `tasks.json`, `sync-state.json` in `.gantt-sync/`

---

## pull

Fetch latest changes from GitHub Project and merge into local tasks.

```bash
gh-gantt pull [--dry-run]
```

**Options:**
- `--dry-run` — Preview changes without applying

**Output:** `Pull summary: +N ~N -N` (added, updated, removed)

**Behavior:**
- Compares remote state against snapshots using hash-based diff
- Merges remote changes while preserving local-only edits
- Adds new remote tasks, removes remotely-deleted tasks (except drafts)
- Updates snapshots after sync

---

## push

Push local changes to GitHub. Creates issues from drafts, updates existing issues.

```bash
gh-gantt push [--dry-run]
```

**Options:**
- `--dry-run` — Preview changes without applying

**Output:** `Push complete: N created, N updated, N skipped.`

**Behavior:**
- Diffs local tasks against last-synced snapshots
- Creates GitHub issues from draft tasks (prefixed `draft-`)
- Updates existing issues with local field changes
- Respects `conflict_strategy` in config

---

## status

Show sync status overview.

```bash
gh-gantt status
```

**Output includes:**
- Last sync timestamp
- Local/remote task counts
- Local changes (added/modified/removed)
- Remote changes pending pull
- Conflicts detected
- Draft tasks not yet pushed

---

## create

Create a draft task locally (not yet a GitHub issue).

```bash
gh-gantt create --title <title> [--type <type>] [--body <body>] \
  [--start-date <YYYY-MM-DD>] [--end-date <YYYY-MM-DD>] [--parent <id>]
```

**Options:**
- `--title <title>` — Task title (required)
- `--type <type>` — Task type (task, epic, feature, bug, etc.)
- `--body <body>` — Description
- `--start-date <date>` — Start date (YYYY-MM-DD)
- `--end-date <date>` — End date (YYYY-MM-DD)
- `--parent <id>` — Parent task ID for hierarchy

Draft tasks get ID format `draft-owner/repo-N`. Push to create as GitHub issues.

---

## serve

Start web server with Gantt chart UI and REST API.

```bash
gh-gantt serve [-p <port>] [--api-only]
```

**Options:**
- `-p, --port <port>` — Server port (default: 3000)
- `--api-only` — API server only, no UI serving

**REST API endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Project configuration |
| GET | `/api/tasks` | All tasks with progress |
| POST | `/api/tasks` | Create draft task |
| PATCH | `/api/tasks/:id` | Update task fields |
| POST | `/api/sync/pull` | Pull from GitHub |
| POST | `/api/sync/push` | Push to GitHub |
| GET | `/api/sync/status` | Sync status |

---

## .gantt-sync/ Directory

All local state is stored in `.gantt-sync/` (should be gitignored):

| File | Purpose |
|------|---------|
| `gantt.config.json` | Project config (types, statuses, field mapping, display) |
| `tasks.json` | All tasks with metadata and comments cache |
| `sync-state.json` | Sync metadata (timestamps, ID mappings, snapshots) |

**Task ID formats:**
- GitHub issue: `owner/repo#123`
- Draft task: `draft-owner/repo-N`

**Conflict strategies** (in config):
- `remote-wins` — GitHub is source of truth
- `local-wins` — Local edits take precedence
- `manual` — Requires manual resolution
