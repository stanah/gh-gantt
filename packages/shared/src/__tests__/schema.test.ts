import { describe, it, expect } from "vitest";
import { ConfigSchema, TasksFileSchema, TasksFileWithConflictsSchema } from "../schema.js";

const validTask = {
  id: "owner/repo#1",
  type: "task",
  github_issue: 1,
  github_repo: "owner/repo",
  parent: null,
  sub_tasks: [],
  title: "Test",
  body: null,
  state: "open" as const,
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
};

const validConfig = {
  version: "1",
  project: {
    name: "test",
    github: { owner: "stanah", repo: "my-repo", project_number: 1 },
  },
  sync: {
    auto_create_issues: false,
    field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
  },
  task_types: {
    task: { label: "Task", display: "bar", color: "#27AE60", github_label: null },
  },
  type_hierarchy: { task: [] },
  statuses: {
    field_name: "Status",
    values: {
      Done: { color: "#2ECC71", done: true },
      Todo: { color: "#3498DB", done: false },
    },
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

describe("[NFR-STORE-001-AC1] 不正な形式のファイルを読み込んだ場合にバリデーションエラーを返す", () => {
  it("validates a minimal valid config without conflict_strategy", () => {
    expect(ConfigSchema.parse(validConfig)).toBeDefined();
  });

  it("accepts config with legacy conflict_strategy via passthrough", () => {
    const configWithLegacy = {
      ...validConfig,
      sync: {
        ...validConfig.sync,
        conflict_strategy: "remote-wins",
      },
    };
    expect(() => ConfigSchema.parse(configWithLegacy)).not.toThrow();
  });

  it("preserves legacy conflict_strategy in parsed output via passthrough", () => {
    const configWithLegacy = {
      ...validConfig,
      sync: {
        ...validConfig.sync,
        conflict_strategy: "remote-wins",
      },
    };
    const result = ConfigSchema.parse(configWithLegacy);
    expect((result.sync as unknown as Record<string, unknown>).conflict_strategy).toBe(
      "remote-wins",
    );
  });

  it("accepts config with priority in field_mapping", () => {
    const configWithPriority = {
      ...validConfig,
      sync: {
        ...validConfig.sync,
        field_mapping: {
          ...validConfig.sync.field_mapping,
          priority: "Priority",
        },
      },
    };
    const parsed = ConfigSchema.parse(configWithPriority);
    expect(parsed.sync.field_mapping.priority).toBe("Priority");
  });

  it("accepts config without priority in field_mapping", () => {
    const parsed = ConfigSchema.parse(validConfig);
    expect(parsed.sync.field_mapping.priority).toBeUndefined();
  });

  it("rejects config with invalid display type", () => {
    const config = {
      ...validConfig,
      sync: { ...validConfig.sync, conflict_strategy: "remote-wins" },
      task_types: {
        task: { label: "Task", display: "invalid", color: "#000", github_label: null },
      },
    };
    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("accepts optional sprints config", () => {
    const config = {
      ...validConfig,
      sync: { ...validConfig.sync, conflict_strategy: "remote-wins" },
      sprints: [
        {
          name: "Sprint 1",
          start_date: "2026-03-01",
          end_date: "2026-03-14",
          color: "#1E90FF",
        },
      ],
    };

    const parsed = ConfigSchema.parse(config);
    expect(parsed.sprints).toEqual(config.sprints);
  });

  describe("[FR-VIS-016-AC2] gantt.holidays を設定として検証できる", () => {
    it("gantt.holidays を設定として受理する", () => {
      const config = {
        ...validConfig,
        gantt: {
          ...validConfig.gantt,
          holidays: [{ date: "2026-01-06", name: "Company holiday" }],
        },
      };

      const parsed = ConfigSchema.parse(config);
      expect(parsed.gantt.holidays).toEqual([{ date: "2026-01-06", name: "Company holiday" }]);
    });

    it("date のない gantt.holidays は拒否する", () => {
      const config = {
        ...validConfig,
        gantt: {
          ...validConfig.gantt,
          holidays: [{ name: "Company holiday" }],
        },
      };

      expect(() => ConfigSchema.parse(config)).toThrow();
    });
  });

  describe("[FR-VIS-018-AC3] gantt.at_risk_threshold_days を設定として検証できる", () => {
    it("gantt.at_risk_threshold_days を設定として受理する", () => {
      const config = {
        ...validConfig,
        gantt: {
          ...validConfig.gantt,
          at_risk_threshold_days: 5,
        },
      };

      const parsed = ConfigSchema.parse(config);
      expect(parsed.gantt.at_risk_threshold_days).toBe(5);
    });

    it("gantt.at_risk_threshold_days が 0 以下なら拒否する", () => {
      const config = {
        ...validConfig,
        gantt: {
          ...validConfig.gantt,
          at_risk_threshold_days: 0,
        },
      };

      expect(() => ConfigSchema.parse(config)).toThrow();
    });

    it("gantt.at_risk_threshold_days が小数なら拒否する", () => {
      const config = {
        ...validConfig,
        gantt: {
          ...validConfig.gantt,
          at_risk_threshold_days: 2.5,
        },
      };

      expect(() => ConfigSchema.parse(config)).toThrow();
    });
  });

  it("rejects sprint config missing required fields", () => {
    const config = {
      ...validConfig,
      sync: { ...validConfig.sync, conflict_strategy: "remote-wins" },
      sprints: [
        {
          name: "Sprint 1",
          start_date: "2026-03-01",
          end_date: "2026-03-14",
        },
      ],
    };

    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("[FR-STORE-001-AC2] grouping.label_prefix を設定として受理する", () => {
    const config = {
      ...validConfig,
      grouping: {
        label_prefix: "pkg:",
      },
    };

    const parsed = ConfigSchema.parse(config);
    expect(parsed.grouping).toEqual({ label_prefix: "pkg:" });
  });

  it("[FR-STORE-001-AC2] grouping.label_prefix が空なら拒否する", () => {
    const config = {
      ...validConfig,
      grouping: {
        label_prefix: "",
      },
    };

    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("[FR-STORE-001-AC3] doctor.stale_in_progress_days を設定として受理する", () => {
    const config = {
      ...validConfig,
      doctor: {
        stale_in_progress_days: 14,
      },
    };

    const parsed = ConfigSchema.parse(config);
    expect(parsed.doctor).toEqual({ stale_in_progress_days: 14 });
  });

  it("[FR-STORE-001-AC3] doctor.stale_in_progress_days が 0 以下なら拒否する", () => {
    const config = {
      ...validConfig,
      doctor: {
        stale_in_progress_days: 0,
      },
    };

    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("accepts config with task_templates", () => {
    const config = {
      ...validConfig,
      task_templates: {
        path: ".github/ISSUE_TEMPLATE",
        mapping: {
          task: "task.md",
          bug: "bug_report.yml",
        },
      },
    };
    const parsed = ConfigSchema.parse(config);
    expect(parsed.task_templates).toEqual({
      path: ".github/ISSUE_TEMPLATE",
      mapping: {
        task: "task.md",
        bug: "bug_report.yml",
      },
    });
  });

  it("accepts config with task_templates without mapping", () => {
    const config = {
      ...validConfig,
      task_templates: {
        path: ".github/ISSUE_TEMPLATE",
      },
    };
    const parsed = ConfigSchema.parse(config);
    expect(parsed.task_templates).toEqual({
      path: ".github/ISSUE_TEMPLATE",
    });
  });

  it("accepts config without task_templates", () => {
    const parsed = ConfigSchema.parse(validConfig);
    expect(parsed.task_templates).toBeUndefined();
    expect(parsed.require_review_for_types).toEqual([]);
  });

  it("[FR-CLI-014-AC1] require_review_for_types を config として受理する", () => {
    const config = {
      ...validConfig,
      require_review_for_types: ["feature", "epic"],
    };
    const parsed = ConfigSchema.parse(config);
    expect(parsed.require_review_for_types).toEqual(["feature", "epic"]);
  });

  it("rejects task_templates without path", () => {
    const config = {
      ...validConfig,
      task_templates: {
        mapping: { task: "task.md" },
      },
    };
    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("rejects task_templates with empty path", () => {
    const config = {
      ...validConfig,
      task_templates: {
        path: "",
      },
    };
    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("rejects task_templates with empty mapping value", () => {
    const config = {
      ...validConfig,
      task_templates: {
        path: ".github/ISSUE_TEMPLATE",
        mapping: { task: "" },
      },
    };
    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("normalizes legacy default_view 'day' to 'week'", () => {
    const config = {
      ...validConfig,
      gantt: { ...validConfig.gantt, default_view: "day" },
    };
    const parsed = ConfigSchema.parse(config);
    expect(parsed.gantt.default_view).toBe("week");
  });
});

describe("[FR-CLI-015-AC1] タスクサイズ閾値と見積もり field mapping の設定検証", () => {
  it("max_task_size_hours と estimate_hours field mapping を設定として受理する", () => {
    const config = {
      ...validConfig,
      max_task_size_hours: 8,
      sync: {
        ...validConfig.sync,
        field_mapping: {
          ...validConfig.sync.field_mapping,
          estimate_hours: "Estimate",
        },
      },
    };

    const parsed = ConfigSchema.parse(config);
    expect(parsed.max_task_size_hours).toBe(8);
    expect(parsed.sync.field_mapping.estimate_hours).toBe("Estimate");
  });

  it("max_task_size_hours が 0 以下なら拒否する", () => {
    const config = {
      ...validConfig,
      max_task_size_hours: 0,
    };

    expect(() => ConfigSchema.parse(config)).toThrow();
  });
});

describe("[FR-CLI-016-AC2] close evidence requirement の設定検証", () => {
  it("require_close_evidence を設定として受理する", () => {
    const parsed = ConfigSchema.parse({
      ...validConfig,
      require_close_evidence: true,
    });

    expect(parsed.require_close_evidence).toBe(true);
  });

  it("require_close_evidence 未指定時は false として扱う", () => {
    const parsed = ConfigSchema.parse(validConfig);

    expect(parsed.require_close_evidence).toBe(false);
  });
});

describe("TasksFileSchema", () => {
  it("[FR-CLI-011-AC1] acceptance_criteria 未指定の既存 task を空配列として受理する", () => {
    const data = {
      tasks: [validTask],
      cache: { comments: {}, reactions: {} },
    };
    const parsed = TasksFileSchema.parse(data);
    expect(parsed.tasks[0].acceptance_criteria).toEqual([]);
    expect(parsed.tasks[0].acceptance_criteria_slot).toBe(false);
    expect(parsed.tasks[0].implementer).toBeNull();
    expect(parsed.tasks[0].reviewer).toBeNull();
    expect(parsed.tasks[0].require_review).toBe(false);
    expect(parsed.tasks[0].review_approved_by).toBeNull();
    expect(parsed.tasks[0].review_approved_at).toBeNull();
  });

  it("[FR-CLI-011-AC1] acceptance_criteria を task の first-class フィールドとして受理する", () => {
    const data = {
      tasks: [
        {
          ...validTask,
          acceptance_criteria: [{ description: "期待する出力を表示できる", checked: false }],
        },
      ],
      cache: { comments: {}, reactions: {} },
    };
    const parsed = TasksFileSchema.parse(data);
    expect(parsed.tasks[0].acceptance_criteria).toEqual([
      { description: "期待する出力を表示できる", checked: false },
    ]);
  });

  it("[FR-CLI-012-AC2] acceptance_criteria_slot を task の同期メタデータとして受理する", () => {
    const data = {
      tasks: [{ ...validTask, acceptance_criteria_slot: true }],
      cache: { comments: {}, reactions: {} },
    };
    const parsed = TasksFileSchema.parse(data);
    expect(parsed.tasks[0].acceptance_criteria_slot).toBe(true);
  });

  it("[FR-CLI-013-AC1] implementer/reviewer を task の first-class フィールドとして受理する", () => {
    const data = {
      tasks: [{ ...validTask, implementer: "alice", reviewer: "bob" }],
      cache: { comments: {}, reactions: {} },
    };
    const parsed = TasksFileSchema.parse(data);
    expect(parsed.tasks[0].implementer).toBe("alice");
    expect(parsed.tasks[0].reviewer).toBe("bob");
  });

  it("[FR-CLI-014-AC1] review requirement と approval を task の first-class フィールドとして受理する", () => {
    const data = {
      tasks: [
        {
          ...validTask,
          require_review: true,
          review_approved_by: "alice",
          review_approved_at: "2026-05-03T21:00:00.000Z",
        },
      ],
      cache: { comments: {}, reactions: {} },
    };
    const parsed = TasksFileSchema.parse(data);
    expect(parsed.tasks[0].require_review).toBe(true);
    expect(parsed.tasks[0].review_approved_by).toBe("alice");
    expect(parsed.tasks[0].review_approved_at).toBe("2026-05-03T21:00:00.000Z");
  });

  it("should accept valid tasks file", () => {
    const data = {
      tasks: [validTask],
      cache: { comments: {}, reactions: {} },
    };
    expect(() => TasksFileSchema.parse(data)).not.toThrow();
  });

  it("should accept tasks file with has_conflicts flag", () => {
    const data = {
      tasks: [validTask],
      cache: { comments: {}, reactions: {} },
      has_conflicts: true,
    };
    expect(() => TasksFileSchema.parse(data)).not.toThrow();
  });

  it("[FR-STORE-003-AC1] linked_prs はメタデータ付き PR と legacy number の両方を受理する", () => {
    const data = {
      tasks: [
        {
          ...validTask,
          linked_prs: [
            42,
            {
              number: 100,
              title: "Show linked PR title",
              state: "merged",
              url: "https://github.com/owner/repo/pull/100",
            },
          ],
        },
      ],
      cache: { comments: {}, reactions: {} },
    };

    expect(() => TasksFileSchema.parse(data)).not.toThrow();
  });

  it("should strip unknown keys from tasks (strict mode)", () => {
    const taskWithMarkers = {
      ...validTask,
      state_current: "open",
      state_incoming: "closed",
    };
    const data = {
      tasks: [taskWithMarkers],
      cache: { comments: {}, reactions: {} },
    };
    const result = TasksFileSchema.parse(data);
    const parsed = result.tasks[0] as unknown as Record<string, unknown>;
    expect(parsed.state_current).toBeUndefined();
    expect(parsed.state_incoming).toBeUndefined();
  });
});

describe("TasksFileWithConflictsSchema", () => {
  it("should accept tasks with conflict marker keys", () => {
    const data = {
      tasks: [
        {
          ...validTask,
          state_current: "open",
          state_incoming: "closed",
        },
      ],
      cache: { comments: {}, reactions: {} },
      has_conflicts: true,
    };
    expect(() => TasksFileWithConflictsSchema.parse(data)).not.toThrow();
    const result = TasksFileWithConflictsSchema.parse(data);
    const parsed = result.tasks[0] as unknown as Record<string, unknown>;
    expect(parsed.state_current).toBe("open");
    expect(parsed.state_incoming).toBe("closed");
  });

  it("should preserve multiple conflict marker fields", () => {
    const data = {
      tasks: [
        {
          ...validTask,
          title_current: "Local title",
          title_incoming: "Remote title",
          start_date_current: "2026-01-01",
          start_date_incoming: "2026-02-01",
        },
      ],
      cache: { comments: {}, reactions: {} },
      has_conflicts: true,
    };
    const result = TasksFileWithConflictsSchema.parse(data);
    const parsed = result.tasks[0] as unknown as Record<string, unknown>;
    expect(parsed.title_current).toBe("Local title");
    expect(parsed.title_incoming).toBe("Remote title");
    expect(parsed.start_date_current).toBe("2026-01-01");
    expect(parsed.start_date_incoming).toBe("2026-02-01");
  });

  it("should work without conflict markers too", () => {
    const data = {
      tasks: [validTask],
      cache: { comments: {}, reactions: {} },
    };
    expect(() => TasksFileWithConflictsSchema.parse(data)).not.toThrow();
  });
});
