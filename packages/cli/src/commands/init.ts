import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import { fetchProject } from "../github/projects.js";
import { fetchAllSubIssueLinks } from "../github/sub-issues.js";
import { mapProjectItemToTask, applySubIssueLinks } from "../github/issues.js";
import { resolveTaskType } from "../sync/type-resolver.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import type { Config, Task, SyncState } from "@gh-gantt/shared";

export const initCommand = new Command("init")
  .description("Initialize gh-gantt from a GitHub Project")
  .requiredOption("--owner <owner>", "GitHub user or org")
  .requiredOption("--repo <repo>", "Repository name")
  .requiredOption("--project <number>", "Project number", parseInt)
  .option("--start-date-field <name>", "Start date field name", "Start Date")
  .option("--end-date-field <name>", "End date field name", "End Date")
  .option("--status-field <name>", "Status field name", "Status")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    console.log(`Initializing gh-gantt for ${opts.owner}/${opts.repo} project #${opts.project}...`);

    const gql = await createGraphQLClient();
    const projectData = await fetchProject(gql, opts.owner, opts.project);
    console.log(`Fetched project "${projectData.projectTitle}" with ${projectData.items.length} items`);

    // Auto-detect statuses from Status field
    const statusField = projectData.fields.find(
      (f) => f.name === opts.statusField && f.options,
    );
    const statusValues: Record<string, { color: string; done: boolean }> = {};
    const defaultDoneNames = ["done", "completed", "closed", "finished"];
    if (statusField?.options) {
      for (const opt of statusField.options) {
        statusValues[opt.name] = {
          color: "#3498DB",
          done: defaultDoneNames.includes(opt.name.toLowerCase()),
        };
      }
    }

    // Auto-detect task types from labels
    const allLabels = new Set<string>();
    for (const item of projectData.items) {
      if (item.content) {
        for (const label of item.content.labels) {
          allLabels.add(label);
        }
      }
    }

    const taskTypes: Config["task_types"] = {
      task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
    };

    // Detect common label patterns for task types
    const typeLabels = ["epic", "milestone", "feature", "bug", "enhancement"];
    for (const label of allLabels) {
      const lower = label.toLowerCase();
      if (typeLabels.includes(lower)) {
        if (lower === "epic") {
          taskTypes.epic = { label: "Epic", display: "summary", color: "#8E44AD", github_label: label };
        } else if (lower === "milestone") {
          taskTypes.milestone_type = { label: "Milestone", display: "milestone", color: "#E74C3C", github_label: label };
        } else if (lower === "bug") {
          taskTypes.bug = { label: "Bug", display: "bar", color: "#E74C3C", github_label: label };
        } else if (lower === "enhancement" || lower === "feature") {
          taskTypes.feature = { label: "Feature", display: "bar", color: "#3498DB", github_label: label };
        }
      }
    }

    const typeHierarchy: Record<string, string[]> = {};
    for (const typeName of Object.keys(taskTypes)) {
      typeHierarchy[typeName] = [];
    }

    const fieldMapping = {
      start_date: opts.startDateField,
      end_date: opts.endDateField,
      status: opts.statusField,
    };

    const config: Config = {
      version: "1",
      project: {
        name: projectData.projectTitle,
        github: { owner: opts.owner, repo: opts.repo, project_number: opts.project },
      },
      sync: {
        conflict_strategy: "remote-wins",
        auto_create_issues: false,
        field_mapping: fieldMapping,
      },
      task_types: taskTypes,
      type_hierarchy: typeHierarchy,
      statuses: {
        field_name: opts.statusField,
        values: statusValues,
      },
      gantt: {
        default_view: "month",
        working_days: [1, 2, 3, 4, 5],
        colors: {
          critical_path: "#E74C3C",
          on_track: "#2ECC71",
          at_risk: "#F39C12",
          overdue: "#E74C3C",
        },
      },
    };

    // Map project items to tasks
    const tasks: Task[] = [];
    for (const item of projectData.items) {
      if (!item.content) continue;
      const taskType = resolveTaskType(item.content.labels, taskTypes);
      const task = mapProjectItemToTask(item, fieldMapping, taskType);
      if (task) tasks.push(task);
    }

    // Fetch sub-issue relationships
    console.log("Fetching sub-issue relationships...");
    const issueItems = projectData.items
      .filter((i) => i.content)
      .map((i) => ({
        number: i.content!.number,
        repository: i.content!.repository,
      }));
    const subIssueLinks = await fetchAllSubIssueLinks(gql, issueItems);
    applySubIssueLinks(tasks, subIssueLinks);
    console.log(`Found ${subIssueLinks.length} sub-issue relationships`);

    // Build sync state
    const idMap: SyncState["id_map"] = {};
    for (const item of projectData.items) {
      if (!item.content) continue;
      const taskId = `${item.content.repository}#${item.content.number}`;
      idMap[taskId] = {
        issue_number: item.content.number,
        issue_node_id: item.content.nodeId,
        project_item_id: item.id,
      };
    }

    const fieldIds: Record<string, string> = {};
    for (const field of projectData.fields) {
      if (field.id && field.name) {
        fieldIds[field.name] = field.id;
      }
    }

    const syncState: SyncState = {
      last_synced_at: new Date().toISOString(),
      project_node_id: projectData.projectNodeId,
      id_map: idMap,
      field_ids: fieldIds,
      snapshots: {},
    };

    // Write files
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);
    const stateStore = new SyncStateStore(projectRoot);

    await configStore.write(config);
    await tasksStore.write({ tasks, cache: { comments: {}, reactions: {} } });
    await stateStore.write(syncState);

    console.log(`Initialized gh-gantt with ${tasks.length} tasks`);
    console.log("Files created in .gantt-sync/:");
    console.log("  - gantt.config.json");
    console.log("  - tasks.json");
    console.log("  - sync-state.json");
  });
