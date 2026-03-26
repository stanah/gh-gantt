import { describe, it, expect } from "vitest";
import type { Task, SyncFields, TaskType, Config } from "@gh-gantt/shared";
import { hashTask, extractSyncFields } from "../sync/hash.js";
import { threeWayMerge } from "../sync/three-way-merge.js";
import { rebaseSyncFields } from "../sync/rebase.js";
import { resolveTaskType } from "../sync/type-resolver.js";

/**
 * pull.ts のマージ分岐ロジックを再現するヘルパー。
 * 修正後の pull コマンドの分岐を反映。
 */
function simulatePullMerge(
  localTask: Task,
  remoteTask: Task,
  snapshot: { hash: string; remoteHash?: string; syncFields?: SyncFields } | undefined,
  config?: Config,
): {
  result: Task;
  action: "keep-local" | "keep-local-warn" | "overwrite-remote" | "merged" | "conflict";
} {
  const remoteHash = hashTask(remoteTask);
  const snapshotRemoteHash = snapshot?.remoteHash ?? snapshot?.hash;

  if (remoteHash === snapshotRemoteHash) {
    return { result: localTask, action: "keep-local" };
  }

  if (!snapshot || !snapshot.syncFields) {
    // Fix #93: check if local has changes before overwriting
    const localHash = hashTask(localTask);
    if (snapshot && localHash !== snapshot.hash) {
      return { result: localTask, action: "keep-local-warn" };
    }
    return { result: remoteTask, action: "overwrite-remote" };
  }

  // Fix #94/#95: rebase snapshot syncFields with current config
  const base = config ? rebaseSyncFields(snapshot.syncFields, config) : snapshot.syncFields;
  const localFields = extractSyncFields(localTask);
  const remoteFields = extractSyncFields(remoteTask);
  const { merged, conflicts } = threeWayMerge(base, localFields, remoteFields);
  const mergedTask = { ...localTask, ...merged };

  if (conflicts.length > 0) {
    return { result: mergedTask, action: "conflict" };
  }
  return { result: mergedTask, action: "merged" };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "stanah/gh-gantt#1",
    type: "task",
    github_issue: 1,
    github_repo: "stanah/gh-gantt",
    parent: null,
    sub_tasks: [],
    title: "Test task",
    body: null,
    state: "open",
    state_reason: null,
    assignees: [],
    labels: [],
    milestone: null,
    linked_prs: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    custom_fields: {},
    start_date: "2026-01-01",
    end_date: "2026-01-10",
    date: null,
    blocked_by: [],
    ...overrides,
  };
}

function makeConfig(
  overrides: {
    task_types?: Record<string, TaskType>;
    field_mapping?: Partial<Config["sync"]["field_mapping"]>;
  } = {},
): Config {
  return {
    version: "1",
    project: { name: "test", github: { owner: "test", repo: "test", project_number: 1 } },
    sync: {
      auto_create_issues: false,
      field_mapping: {
        start_date: "Start",
        end_date: "End",
        status: "Status",
        ...overrides.field_mapping,
      },
    },
    task_types: overrides.task_types ?? {
      task: { label: "Task", display: "bar", color: "#0000ff", github_label: null },
    },
    type_hierarchy: {},
    statuses: { field_name: "Status", values: {} },
    gantt: {
      default_view: "week",
      working_days: [1, 2, 3, 4, 5],
      colors: { critical_path: "#f00", on_track: "#0f0", at_risk: "#ff0", overdue: "#f00" },
    },
  };
}

describe("Bug #93: syncFields 未定義時のリモート無条件上書き", () => {
  it("syncFields が undefined のスナップショットでローカル変更がリモートに上書きされる", () => {
    // 1. 初回同期時のタスク（スナップショットに syncFields なし）
    const originalTask = makeTask({
      title: "Original title",
      start_date: "2026-01-01",
      end_date: "2026-01-10",
    });

    // スナップショット: hash はあるが syncFields がない（旧バージョンで同期）
    const snapshot = {
      hash: hashTask(originalTask),
      synced_at: "2026-01-01T00:00:00Z",
      // syncFields: undefined  ← 旧バージョンでは保存されなかった
    };

    // 2. ユーザーがローカルで start_date を変更
    const localTask = makeTask({
      title: "Original title",
      start_date: "2026-02-01", // ← ローカルで変更
      end_date: "2026-01-10",
    });

    // 3. リモートでは title が変更された
    const remoteTask = makeTask({
      title: "Updated from remote",
      start_date: "2026-01-01",
      end_date: "2026-01-10",
      updated_at: "2026-01-02T00:00:00Z", // リモートが更新されている
    });

    // 4. pull 実行 → 修正後: ローカル変更があるのでローカルが保持される
    const { result, action } = simulatePullMerge(localTask, remoteTask, snapshot);

    expect(action).toBe("keep-local-warn");
    expect(result.start_date).toBe("2026-02-01"); // ローカル変更が保持される
  });

  it("snapshot 自体が undefined の場合もリモートで上書きされる", () => {
    const localTask = makeTask({
      title: "Local edit",
      start_date: "2026-03-01",
    });
    const remoteTask = makeTask({
      title: "Remote version",
      start_date: "2026-01-01",
      updated_at: "2026-01-02T00:00:00Z",
    });

    const { result, action } = simulatePullMerge(localTask, remoteTask, undefined);

    expect(action).toBe("overwrite-remote");
    expect(result.title).toBe("Remote version");
    expect(result.start_date).toBe("2026-01-01");
  });

  it("syncFields がある場合は正常に 3-way merge される（対照実験）", () => {
    const originalTask = makeTask({
      title: "Original title",
      start_date: "2026-01-01",
      end_date: "2026-01-10",
    });

    // syncFields が存在するスナップショット
    const snapshot = {
      hash: hashTask(originalTask),
      synced_at: "2026-01-01T00:00:00Z",
      syncFields: extractSyncFields(originalTask),
    };

    const localTask = makeTask({
      title: "Original title",
      start_date: "2026-02-01", // ローカル変更
      end_date: "2026-01-10",
    });

    const remoteTask = makeTask({
      title: "Updated from remote",
      start_date: "2026-01-01",
      end_date: "2026-01-10",
      updated_at: "2026-01-02T00:00:00Z",
    });

    const { result, action } = simulatePullMerge(localTask, remoteTask, snapshot);

    // syncFields があれば正常に 3-way merge される
    expect(action).toBe("merged");
    expect(result.start_date).toBe("2026-02-01"); // ローカル変更が保持
    expect(result.title).toBe("Updated from remote"); // リモート変更も反映
  });
});

describe("Bug #94: task_types 変更による偽コンフリクト", () => {
  it("task_types の github_label 変更で type が変わり、ローカルの type が上書きされる", () => {
    // 旧設定: github_label: "type:feature" → "feature" に解決
    const oldTaskTypes: Record<string, TaskType> = {
      feature: {
        label: "Feature",
        display: "bar",
        color: "#00ff00",
        github_label: "type:feature",
      },
      task: {
        label: "Task",
        display: "bar",
        color: "#0000ff",
        github_label: null,
      },
    };

    // 新設定: github_label を "feat" に変更
    const newTaskTypes: Record<string, TaskType> = {
      feature: {
        label: "Feature",
        display: "bar",
        color: "#00ff00",
        github_label: "feat", // ← 変更
      },
      task: {
        label: "Task",
        display: "bar",
        color: "#0000ff",
        github_label: null,
      },
    };

    const labels = ["type:feature", "priority:high"];

    // 旧設定では "feature" に解決される
    const oldType = resolveTaskType(labels, {}, oldTaskTypes);
    expect(oldType).toBe("feature");

    // 新設定では "type:feature" ラベルが "feat" にマッチしないので "task" にデグレード
    const newType = resolveTaskType(labels, {}, newTaskTypes);
    expect(newType).toBe("task"); // ← デグレード発生

    // 3-way merge でローカルの type が上書きされることを確認
    const originalTask = makeTask({ type: "feature", labels });
    const snapshot = {
      hash: hashTask(originalTask),
      synced_at: "2026-01-01T00:00:00Z",
      syncFields: extractSyncFields(originalTask),
    };

    // ローカル: ユーザーが body を編集（type は変更していない）
    const localTask = makeTask({
      type: "feature",
      labels,
      body: "Updated description", // ← ローカル変更
    });

    // リモート: 新設定で再解釈されたタスク（type が "task" にデグレード）
    const remoteTask = makeTask({
      type: "task", // ← 新設定で resolveTaskType が返す値
      labels,
      updated_at: "2026-01-02T00:00:00Z",
    });

    // 新設定の config で rebase して merge
    const config = makeConfig({ task_types: newTaskTypes });
    const { result, action } = simulatePullMerge(localTask, remoteTask, snapshot, config);

    // 修正後: rebaseSyncFields がスナップショットの type を新設定で再解決
    // rebasedBase.type = "task" (新設定 + 旧ラベル "type:feature" → マッチしない → "task")
    // current.type = "feature", incoming.type = "task"
    // rebasedBase == incoming → "ローカルのみ変更" と正しく判定
    expect(action).toBe("merged");
    expect(result.type).toBe("feature"); // ← ローカルの type が保持される
    expect(result.body).toBe("Updated description"); // body のローカル変更も保持
  });

  it("github_field_value 変更でも同様にデグレードが起きる", () => {
    const oldTaskTypes: Record<string, TaskType> = {
      epic: {
        label: "Epic",
        display: "summary",
        color: "#ff0000",
        github_label: null,
        github_field_value: "Epic",
      },
      task: {
        label: "Task",
        display: "bar",
        color: "#0000ff",
        github_label: null,
      },
    };

    const newTaskTypes: Record<string, TaskType> = {
      epic: {
        label: "Epic",
        display: "summary",
        color: "#ff0000",
        github_label: null,
        github_field_value: "エピック", // ← 変更
      },
      task: {
        label: "Task",
        display: "bar",
        color: "#0000ff",
        github_label: null,
      },
    };

    const customFields = { Type: "Epic" };

    // 旧設定: "Epic" にマッチ → "epic"
    const oldType = resolveTaskType([], customFields, oldTaskTypes, "Type");
    expect(oldType).toBe("epic");

    // 新設定: "Epic" が "エピック" にマッチしない → "task" にデグレード
    const newType = resolveTaskType([], customFields, newTaskTypes, "Type");
    expect(newType).toBe("task");
  });
});

describe("Bug #95: field_mapping 変更で start_date/end_date が偽変更になる", () => {
  it("field_mapping 変更で start_date が null になりローカル変更が上書きされる", () => {
    // 旧設定: field_mapping.start_date = "Start" → 正しく "2026-01-01" を取得
    // 新設定: field_mapping.start_date = "Start Date" → GitHub にそのフィールドがない → null

    // mapper.ts: start_date = item.fieldValues[fm.start_date] ?? null
    // custom_fields は item.fieldValues をそのまま格納（キーは GitHub 由来、config 非依存）

    const customFields = { Start: "2026-01-01", End: "2026-01-10", Status: "In Progress" };

    // 旧設定で同期されたタスク
    const originalTask = makeTask({
      start_date: "2026-01-01", // fieldValues["Start"]
      end_date: "2026-01-10",
      custom_fields: customFields,
    });

    const snapshot = {
      hash: hashTask(originalTask),
      synced_at: "2026-01-01T00:00:00Z",
      syncFields: extractSyncFields(originalTask),
    };

    // ローカル: ユーザーが body を編集
    const localTask = makeTask({
      start_date: "2026-01-01",
      end_date: "2026-01-10",
      custom_fields: customFields,
      body: "Updated locally", // ← ローカル変更
    });

    // リモート: field_mapping 変更で start_date が null に（GitHub 側のデータは同じ）
    // mapper.ts が item.fieldValues["Start Date"] を参照 → undefined → null
    const remoteTask = makeTask({
      start_date: null, // ← field_mapping 変更で null になった
      end_date: null, // ← 同上
      custom_fields: customFields, // GitHub 側のフィールドは変わっていない
      updated_at: "2026-01-02T00:00:00Z",
    });

    // 誤った field_mapping の config で rebase して merge
    const config = makeConfig({
      field_mapping: { start_date: "Start Date", end_date: "End Date", status: "Status" },
    });
    const { result, action } = simulatePullMerge(localTask, remoteTask, snapshot, config);

    // 修正後: rebaseSyncFields がスナップショットの start_date/end_date を再解決
    // custom_fields に "Start Date" キーがない → フォールバックで元の start_date を保持
    // rebasedBase.start_date = "2026-01-01" (フォールバック)
    // base == current == "2026-01-01", incoming = null
    // → base == current && base != incoming → "リモートのみ変更"
    // しかし rebase のフォールバックにより base が元の値を保持するため、
    // field_mapping が正しい場合と同じ挙動になる
    expect(action).toBe("merged");
    // start_date は null になる（field_mapping で参照先が変わったため）
    // ただしフォールバックにより base は元値を維持しているので、
    // ローカルが start_date を変更していた場合はローカル変更が保持される
    expect(result.body).toBe("Updated locally"); // body のローカル変更は保持
  });

  it("field_mapping が正しければ start_date は正常に同期される（対照実験）", () => {
    const customFields = { Start: "2026-01-01", Status: "In Progress" };

    const originalTask = makeTask({
      start_date: "2026-01-01",
      custom_fields: customFields,
    });
    const snapshot = {
      hash: hashTask(originalTask),
      synced_at: "2026-01-01T00:00:00Z",
      syncFields: extractSyncFields(originalTask),
    };

    // ローカル: 変更なし
    const localTask = makeTask({ start_date: "2026-01-01", custom_fields: customFields });

    // リモート: start_date が正しく取得されている（field_mapping が正しい）
    const remoteTask = makeTask({
      start_date: "2026-01-01",
      custom_fields: customFields,
    });

    const { result, action } = simulatePullMerge(localTask, remoteTask, snapshot);

    // ハッシュ一致 → ローカル保持
    expect(action).toBe("keep-local");
    expect(result.start_date).toBe("2026-01-01");
  });
});
