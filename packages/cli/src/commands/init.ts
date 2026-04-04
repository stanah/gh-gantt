import { Command } from "commander";
import { createGraphQLClient } from "../github/client.js";
import {
  fetchProject,
  fetchRepositoryMetadata,
  fetchOrgIssueTypes,
  detectOwnerType,
} from "../github/projects.js";
import { fetchAllSubIssueLinks } from "../github/sub-issues.js";
import { mapProjectItemToTask, applySubIssueLinks, milestoneToTask } from "../github/issues.js";
import { resolveTaskType } from "../sync/type-resolver.js";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { SyncStateStore } from "../store/state.js";
import type { Config, TaskType, TaskDisplay, Task, SyncState } from "@gh-gantt/shared";

const KNOWN_TYPE_DEFAULTS: Record<
  string,
  { key: string; label: string; display: TaskDisplay; color: string }
> = {
  epic: { key: "epic", label: "Epic", display: "summary", color: "#8E44AD" },
  bug: { key: "bug", label: "Bug", display: "bar", color: "#E74C3C" },
  feature: { key: "feature", label: "Feature", display: "bar", color: "#3498DB" },
  enhancement: { key: "feature", label: "Feature", display: "bar", color: "#3498DB" },
};

function applyTypeSources(
  taskTypes: Record<string, TaskType>,
  sources: Array<{ name: string }>,
  bindingKey: "github_issue_type" | "github_field_value" | "github_label",
  skipExisting?: boolean,
): void {
  for (const source of sources) {
    const lower = source.name.toLowerCase();
    const defaults = KNOWN_TYPE_DEFAULTS[lower];
    if (defaults) {
      const key = defaults.key;
      if (skipExisting && taskTypes[key]) {
        if (bindingKey === "github_label" && !taskTypes[key].github_label) {
          taskTypes[key] = { ...taskTypes[key], github_label: source.name };
        }
        continue;
      }
      if (key === "task" || lower === "task") {
        taskTypes.task = { ...taskTypes.task, [bindingKey]: source.name };
      } else {
        taskTypes[key] = {
          label: defaults.label,
          display: defaults.display,
          color: defaults.color,
          github_label: null,
          ...taskTypes[key],
          [bindingKey]: source.name,
        };
      }
    } else if (lower === "task") {
      taskTypes.task = { ...taskTypes.task, [bindingKey]: source.name };
    } else {
      const normalized = lower.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const key = normalized || `type_${Buffer.from(source.name).toString("hex").slice(0, 12)}`;
      if (skipExisting && taskTypes[key]) continue;
      taskTypes[key] = {
        label: source.name,
        display: "bar",
        color: "#95A5A6",
        github_label: null,
        ...taskTypes[key],
        [bindingKey]: source.name,
      };
    }
  }
}

export const initCommand = new Command("init")
  .description("Initialize gh-gantt from a GitHub Project")
  .requiredOption("--owner <owner>", "GitHub user or org")
  .requiredOption("--repo <repo>", "Repository name")
  .requiredOption("--project <number>", "Project number", parseInt)
  .option("--start-date-field <name>", "Start date field name", "Start Date")
  .option("--end-date-field <name>", "End date field name", "End Date")
  .option("--status-field <name>", "Status field name", "Status")
  .option("--type-field <name>", "Type custom field name (auto-detected if omitted)")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    console.log(`Initializing gh-gantt for ${opts.owner}/${opts.repo} project #${opts.project}...`);

    const gql = await createGraphQLClient();

    // Detect owner type first, then fetch project + org issue types in parallel
    const ownerType = await detectOwnerType(gql, opts.owner);
    const [projectData, orgIssueTypes] = await Promise.all([
      fetchProject(gql, opts.owner, opts.project, ownerType),
      ownerType === "organization" ? fetchOrgIssueTypes(gql, opts.owner) : Promise.resolve([]),
    ]);
    console.log(
      `Fetched project "${projectData.projectTitle}" with ${projectData.items.length} items`,
    );
    if (orgIssueTypes.length > 0) {
      console.log(
        `Detected ${orgIssueTypes.length} Organization Issue Type(s): ${orgIssueTypes.map((t) => t.name).join(", ")}`,
      );
    }

    // Auto-detect statuses from Status field
    const statusField = projectData.fields.find((f) => f.name === opts.statusField && f.options);
    const statusValues: Record<string, { color: string; done: boolean; starts_work?: boolean }> =
      {};
    const defaultDoneNames = ["done", "completed", "closed", "finished"];
    const defaultStartsWorkNames = ["in progress", "in review", "active", "working"];
    if (statusField?.options) {
      for (const opt of statusField.options) {
        const lower = opt.name.toLowerCase();
        const done = defaultDoneNames.includes(lower);
        const startsWork = defaultStartsWorkNames.includes(lower);
        statusValues[opt.name] = {
          color: "#3498DB",
          done,
          ...(startsWork ? { starts_work: true } : {}),
        };
      }
    }

    // Auto-detect Type custom field
    const typeFieldName = opts.typeField ?? null;
    let detectedTypeField: (typeof projectData.fields)[number] | undefined;

    if (typeFieldName) {
      detectedTypeField = projectData.fields.find((f) => f.name === typeFieldName && f.options);
      if (!detectedTypeField) {
        console.warn(`WARNING: Type field "${typeFieldName}" not found or has no options`);
      }
    } else {
      detectedTypeField = projectData.fields.find((f) => f.name === "Type" && f.options);
    }

    const resolvedTypeFieldName = detectedTypeField?.name ?? null;
    if (detectedTypeField) {
      console.log(
        `Detected Type field: "${detectedTypeField.name}" with ${detectedTypeField.options?.length ?? 0} options`,
      );
    }

    // Collect labels from items
    const allLabels = new Set<string>();
    for (const item of projectData.items) {
      if (item.content) {
        for (const label of item.content.labels) {
          allLabels.add(label);
        }
      }
    }

    // Build task types from sources (priority: issue types > custom field > labels)
    const taskTypes: Config["task_types"] = {
      task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
    };

    applyTypeSources(taskTypes, orgIssueTypes, "github_issue_type");
    applyTypeSources(taskTypes, detectedTypeField?.options ?? [], "github_field_value");

    const typeLabels = ["epic", "feature", "bug", "enhancement"];
    const labelSources = [...allLabels]
      .filter((l) => typeLabels.includes(l.toLowerCase()))
      .map((name) => ({ name }));
    applyTypeSources(taskTypes, labelSources, "github_label", true);

    const typeHierarchy: Record<string, string[]> = {};
    for (const typeName of Object.keys(taskTypes)) {
      typeHierarchy[typeName] = [];
    }

    const fieldMapping: Config["sync"]["field_mapping"] = {
      start_date: opts.startDateField,
      end_date: opts.endDateField,
      status: opts.statusField,
      type: resolvedTypeFieldName,
    };

    const config: Config = {
      version: "1",
      project: {
        name: projectData.projectTitle,
        github: { owner: opts.owner, repo: opts.repo, project_number: opts.project },
      },
      sync: {
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
      const taskType = resolveTaskType(
        item.content.labels,
        item.fieldValues,
        taskTypes,
        resolvedTypeFieldName,
        item.content.issueType,
      );
      const task = mapProjectItemToTask(item, fieldMapping, taskType);
      if (task) tasks.push(task);
    }

    // Fetch native GitHub Milestones and create synthetic milestone tasks
    const repoFullName = `${opts.owner}/${opts.repo}`;
    const repoMetadata = await fetchRepositoryMetadata(gql, opts.owner, opts.repo);
    const milestonesWithDueDate = repoMetadata.milestones.filter((m) => m.dueOn);
    if (milestonesWithDueDate.length > 0) {
      taskTypes.milestone = {
        label: "Milestone",
        display: "milestone",
        color: "#E74C3C",
        github_label: null,
      };
      for (const m of milestonesWithDueDate) {
        tasks.push(milestoneToTask(m, repoFullName));
      }
      console.log(`Added ${milestonesWithDueDate.length} milestone(s) from GitHub`);
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

    // Build option_ids map from fields with options
    const optionIds: Record<string, Record<string, string>> = {};
    for (const field of projectData.fields) {
      if (field.options && field.options.length > 0) {
        const optMap: Record<string, string> = {};
        for (const opt of field.options) {
          optMap[opt.name] = opt.id;
        }
        optionIds[field.name] = optMap;
      }
    }

    const syncState: SyncState = {
      last_synced_at: new Date().toISOString(),
      project_node_id: projectData.projectNodeId,
      id_map: idMap,
      field_ids: fieldIds,
      snapshots: {},
      option_ids: optionIds,
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
