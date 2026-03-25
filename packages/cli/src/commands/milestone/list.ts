import type { Task } from "@gh-gantt/shared";

export interface MilestoneInfo {
  name: string;
  taskId: string | null;
  dueDate: string | null;
  state: string | null;
  taskCount: number;
}

export function collectMilestones(tasks: Task[]): MilestoneInfo[] {
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
      if ((t.type === "milestone" || t.type === "milestone_type") && t.milestone === t.title)
        continue;
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
