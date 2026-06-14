import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createCreateCommand,
  renderTaskTemplate,
  resolveTaskTemplatePath,
} from "../commands/create.js";
import { createAcceptanceCriteriaCommand } from "../commands/ac.js";
import {
  parseAcceptanceCriteriaBody,
  serializeAcceptanceCriteriaBody,
  type Config,
  type Task,
  type TasksFile,
} from "@gh-gantt/shared";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const mockConfig: Config = {
  version: "1",
  project: { name: "test", github: { owner: "owner", repo: "repo", project_number: 1 } },
  sync: {
    auto_create_issues: false,
    field_mapping: {
      start_date: "Start",
      end_date: "End",
      status: "Status",
      estimate_hours: "Estimate",
    },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#000", github_label: null },
    feature: { label: "Feature", display: "bar", color: "#0f0", github_label: "feature" },
  },
  type_hierarchy: {},
  statuses: { field_name: "Status", values: {} },
  gantt: {
    default_view: "week",
    working_days: [1, 2, 3, 4, 5],
    colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
  },
  task_templates: {
    path: "templates",
    mapping: { feature: "feature.md" },
  },
  max_task_size_hours: 8,
};

function makeTasksFile(tasks: Task[] = []): TasksFile {
  return { tasks, cache: { comments: {}, reactions: {} } };
}

let currentTasksFile = makeTasksFile();
let writtenTasksFile: TasksFile | null = null;
let tmpRoot = "";

vi.mock("../store/config.js", () => ({
  ConfigStore: class {
    async read() {
      return mockConfig;
    }
  },
}));

vi.mock("../store/tasks.js", () => ({
  TasksStore: class {
    async read() {
      return clone(currentTasksFile);
    }

    async write(data: TasksFile) {
      writtenTasksFile = clone(data);
      currentTasksFile = clone(data);
    }
  },
}));

async function writeTemplate(content: string): Promise<void> {
  await mkdir(join(tmpRoot, "templates"), { recursive: true });
  await writeFile(join(tmpRoot, "templates", "feature.md"), content);
}

describe("[FR-CLI-012-AC1] create --template の task_templates 解決", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "gh-gantt-create-template-"));
    currentTasksFile = makeTasksFile();
    writtenTasksFile = null;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("mapping されたテンプレートファイルを project root 配下に解決する", () => {
    const result = resolveTaskTemplatePath("/repo", mockConfig.task_templates, "feature");

    expect(result).toMatchObject({ ok: true, templatePath: "/repo/templates/feature.md" });
  });

  it("task_templates.path の外へ出る mapping を拒否する", () => {
    const result = resolveTaskTemplatePath(
      "/repo",
      { path: "templates", mapping: { feature: "../secret.md" } },
      "feature",
    );

    expect(result).toEqual({
      ok: false,
      message: "Template path must stay within task_templates.path.",
    });
  });

  it("[FR-CLI-012-AC2] AC プレースホルダを空の受入基準セクションへ展開する", () => {
    const body = renderTaskTemplate("## {{title}}\n\n{{body}}\n\n{{acceptance_criteria}}", {
      title: "Feature task",
      type: "feature",
      body: "補足説明",
    });
    const parsed = parseAcceptanceCriteriaBody(body);

    expect(body).toContain("## Feature task");
    expect(body).toContain("補足説明");
    expect(body).toContain("## 受入基準");
    expect(parsed.body).toContain("補足説明");
    expect(parsed.acceptance_criteria).toEqual([]);
  });

  it("[FR-CLI-012-AC2] create --template は生成 draft body に AC スロットを含める", async () => {
    await writeTemplate(["## {{title}}", "", "{{body}}", "", "{{acceptance_criteria}}"].join("\n"));

    const cmd = createCreateCommand();
    await cmd.parseAsync(
      [
        "--title",
        "テンプレート task",
        "--type",
        "feature",
        "--template",
        "feature",
        "--body",
        "補足説明",
        "--json",
      ],
      { from: "user" },
    );

    const task = writtenTasksFile?.tasks[0];
    expect(task?.body).toContain("## テンプレート task");
    expect(task?.body).toContain("## 受入基準");
    expect(task?.acceptance_criteria).toEqual([]);
    expect(task?.acceptance_criteria_slot).toBe(true);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      task: { title: "テンプレート task", type: "feature" },
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("[FR-CLI-014-AC2] create --require-review は draft task にレビュー必須フラグを設定する", async () => {
    const cmd = createCreateCommand();
    await cmd.parseAsync(
      ["--title", "レビュー必須 task", "--type", "feature", "--require-review", "--json"],
      { from: "user" },
    );

    const task = writtenTasksFile?.tasks[0];
    expect(task?.require_review).toBe(true);
    expect(task?.review_approved_by).toBeNull();
    expect(task?.review_approved_at).toBeNull();
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      task: { title: "レビュー必須 task", require_review: true },
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("[FR-CLI-015-AC2] create --estimate-hours は閾値超過時に分解を促す警告を出す", async () => {
    const cmd = createCreateCommand();
    await cmd.parseAsync(
      ["--title", "大きい task", "--type", "feature", "--estimate-hours", "13", "--json"],
      { from: "user" },
    );

    const task = writtenTasksFile?.tasks[0];
    expect(task?.custom_fields).toMatchObject({ Estimate: 13 });
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      task: { title: "大きい task", custom_fields: { Estimate: 13 } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "警告: タスク見積もり 13h は閾値 8h を超えています。gh-gantt-decompose で分解してください。",
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("[FR-CLI-012-AC3] テンプレート生成後に ac add で受入基準を追加できる", async () => {
    await writeTemplate("説明\n\n{{acceptance_criteria}}");

    await createCreateCommand().parseAsync(
      ["--title", "テンプレート task", "--type", "feature", "--template", "feature", "--json"],
      { from: "user" },
    );
    await createAcceptanceCriteriaCommand().parseAsync(
      ["add", "draft-1", "テンプレートから追加できる", "--json"],
      { from: "user" },
    );

    const task = writtenTasksFile?.tasks[0];
    expect(task?.acceptance_criteria).toEqual([
      { description: "テンプレートから追加できる", checked: false },
    ]);

    const body = serializeAcceptanceCriteriaBody(task?.body ?? null, task?.acceptance_criteria, {
      includeEmptyBlock: task?.acceptance_criteria_slot === true,
    });
    expect(body).toContain("## 受入基準");
    expect(body).toContain("- [ ] テンプレートから追加できる");
    expect(body?.match(/## 受入基準/g)).toHaveLength(1);
  });

  it("[FR-CLI-012-AC1] symlink で task_templates.path 外へ出るテンプレートを拒否する", async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), "gh-gantt-external-template-"));
    try {
      await mkdir(join(tmpRoot, "templates"), { recursive: true });
      await writeFile(join(externalRoot, "feature.md"), "外部テンプレート");
      await symlink(join(externalRoot, "feature.md"), join(tmpRoot, "templates", "feature.md"));

      await createCreateCommand().parseAsync(
        ["--title", "外部 template", "--type", "feature", "--template", "feature"],
        { from: "user" },
      );

      expect(process.exitCode).toBe(1);
      expect(writtenTasksFile).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith("Template path must stay within task_templates.path.");
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
