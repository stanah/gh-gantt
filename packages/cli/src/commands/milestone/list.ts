import { Command } from "commander";
import Table from "cli-table3";
import { ConfigStore } from "../../store/config.js";
import { TasksStore } from "../../store/tasks.js";
import type { Task } from "@gh-gantt/shared";

interface MilestoneInfo {
  name: string;
  taskId: string | null;
  dueDate: string | null;
  state: string | null;
  taskCount: number;
}

function collectMilestones(tasks: Task[]): MilestoneInfo[] {
  const milestoneMap = new Map<string, MilestoneInfo>();

  // Collect milestone-type tasks (synthetic milestones from GitHub)
  for (const t of tasks) {
    if (t.type === "milestone" || t.type === "milestone_type") {
      milestoneMap.set(t.title, {
        name: t.title,
        taskId: t.id,
        dueDate: t.date ?? t.end_date,
        state: t.state,
        taskCount: 0,
      });
    }
  }

  // Count tasks referencing each milestone and discover milestones from references
  for (const t of tasks) {
    if (t.milestone) {
      // Skip self-referencing milestone tasks
      if ((t.type === "milestone" || t.type === "milestone_type") && t.milestone === t.title) continue;
      const existing = milestoneMap.get(t.milestone);
      if (existing) {
        existing.taskCount++;
      } else {
        milestoneMap.set(t.milestone, {
          name: t.milestone,
          taskId: null,
          dueDate: null,
          state: null,
          taskCount: 1,
        });
      }
    }
  }

  return Array.from(milestoneMap.values());
}

export const milestoneListCommand = new Command("list")
  .description("List milestones")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const projectRoot = process.cwd();
    const configStore = new ConfigStore(projectRoot);
    const tasksStore = new TasksStore(projectRoot);

    await configStore.read(); // validate config exists
    const tasksFile = await tasksStore.read();

    const milestones = collectMilestones(tasksFile.tasks);

    if (opts.json) {
      console.log(JSON.stringify({ milestones }, null, 2));
      return;
    }

    if (milestones.length === 0) {
      console.log("No milestones found.");
      return;
    }

    const table = new Table({
      head: ["Name", "Due Date", "State", "Tasks"],
      style: { head: [], border: [], compact: true },
      chars: {
        top: "", "top-mid": "", "top-left": "", "top-right": "",
        bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
        left: "", "left-mid": "", mid: "", "mid-mid": "",
        right: "", "right-mid": "", middle: "  ",
      },
    });

    for (const m of milestones) {
      table.push([m.name, m.dueDate ?? "-", m.state ?? "-", String(m.taskCount)]);
    }

    console.log(table.toString());
  });

export { collectMilestones };
