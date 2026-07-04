import { Command } from "commander";
import { buildNextActions, buildProjectMapViewModel, resolveLoopConfig } from "@gh-gantt/shared";
import type {
  Config,
  LoopIteration,
  LoopState,
  NextActionCategory,
  ResolvedLoopConfig,
  Task,
} from "@gh-gantt/shared";
import { ConfigStore } from "../store/config.js";
import { TasksStore } from "../store/tasks.js";
import { LoopStateStore } from "../store/loop-state.js";

/** ready 候補として表示する件数。 */
const READY_CANDIDATE_LIMIT = 3;

export interface LoopReadyCandidate {
  taskId: string;
  title: string;
  score: number;
  category: NextActionCategory;
  reason: string;
}

export interface LoopStatusReport {
  /** loop-state.json が存在するか。 */
  initialized: boolean;
  iterationCount: number;
  lastIteration: LoopIteration | null;
  stop: ResolvedLoopConfig;
  /** tasks.json に未解決コンフリクトがあるか（conflicts_present 相当）。 */
  hasConflicts: boolean;
  readyCount: number;
  /**
   * 次の着手候補。ADR-017 に従い、候補集合を ready に限定した上で
   * Next Actions のスコアリングを適用した順で並ぶ。
   * コンフリクト検出中は HARD-GATE（解決まで他作業禁止）に従い空になる。
   */
  readyCandidates: LoopReadyCandidate[];
}

/** ループの現在地レポートを組み立てる（純粋関数・ネットワーク不要）。 */
export function buildLoopStatusReport(
  state: LoopState | null,
  config: Config,
  tasks: Task[],
  hasConflicts = false,
): LoopStatusReport {
  const vm = buildProjectMapViewModel(tasks, config);

  // ADR-017: decide は候補集合を ready に限定してからスコアリング関数を再利用する。
  // readiness マップを ready のみに絞って渡すことで blocked の高スコア候補を排除する。
  // 子タスクを持つ親（コンテナ）は直接の着手対象ではないため、
  // buildNextActions と同じ基準（leaf のみ）で件数・候補を揃える。
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const readyOnly = Object.fromEntries(
    Object.entries(vm.readinessById).filter(
      ([id, r]) => r.isReady && (taskById.get(id)?.sub_tasks.length ?? 0) === 0,
    ),
  );
  const readyActions = buildNextActions(tasks, config, readyOnly, READY_CANDIDATE_LIMIT);

  const iterations = state?.iterations ?? [];
  return {
    initialized: state !== null,
    iterationCount: iterations.length,
    lastIteration: iterations.length > 0 ? iterations[iterations.length - 1] : null,
    stop: resolveLoopConfig(config.loop),
    hasConflicts,
    readyCount: Object.keys(readyOnly).length,
    // コンフリクト解決が最優先（HARD-GATE）。解決まで次の着手候補は提示しない。
    readyCandidates: hasConflicts
      ? []
      : readyActions.map((a) => ({
          taskId: a.task.id,
          title: a.task.title,
          score: a.score,
          category: a.category,
          reason: a.reason,
        })),
  };
}

/** レポートを人間向けテキストに整形する。 */
export function formatLoopStatus(report: LoopStatusReport): string {
  const lines: string[] = [];

  if (!report.initialized) {
    lines.push("Loop state: 未初期化 (.gantt-sync/loop-state.json がありません)");
    lines.push("  外側ループのジャーナルは gh-gantt loop コマンドが作成・管理します。");
  } else if (report.lastIteration) {
    const it = report.lastIteration;
    lines.push(`Iterations: ${report.iterationCount}`);
    lines.push(`Last iteration: #${it.id} ${it.selectedTask ?? "(タスク選定なし)"}`);
    lines.push(`  decision: ${it.decision}`);
    const span = it.completedAt ? `${it.startedAt} -> ${it.completedAt}` : `${it.startedAt} ->`;
    lines.push(`  outcome: ${it.outcome ?? "(未記録)"} (${span})`);
    if (it.stopReason) lines.push(`  stopReason: ${it.stopReason}`);
  } else {
    lines.push("Iterations: 0 (ジャーナルは初期化済み)");
  }

  lines.push("");
  const max = report.stop.maxIterations === null ? "unlimited" : String(report.stop.maxIterations);
  lines.push(`Stop conditions: ${report.stop.stopWhen.join(", ")}`);
  lines.push(`  maxIterations: ${max} / onVerifyFailure: ${report.stop.onVerifyFailure}`);

  lines.push("");
  if (report.hasConflicts) {
    lines.push("!! Conflicts detected (conflicts_present)");
    lines.push(
      "   未解決コンフリクトがあります。gh-gantt conflicts / resolve で解決するまで次の着手候補は提示しません。",
    );
    return lines.join("\n");
  }
  lines.push(`Ready tasks: ${report.readyCount}`);
  if (report.readyCandidates.length > 0) {
    lines.push("Next candidates (ready のみ, Next Actions スコア順):");
    report.readyCandidates.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c.taskId}: ${c.title}`);
      lines.push(`     score=${c.score} [${c.category}] ${c.reason}`);
    });
  } else {
    lines.push("Next candidates: なし (ready なタスクがありません)");
  }

  return lines.join("\n");
}

export const loopCommand = new Command("loop")
  .description("Outer-loop journal and status (ADR-016 / ADR-017)")
  .addCommand(
    new Command("status")
      .description("Show outer-loop status: last iteration, stop conditions, ready candidates")
      .option("--json", "Output as JSON")
      .action(async (opts: { json?: boolean }) => {
        // エントリポイントは program.parse() のため、reject をここで処理しないと
        // 未処理 rejection としてスタックトレースがそのまま表に出る
        try {
          const projectRoot = process.cwd();
          const config = await new ConfigStore(projectRoot).read();
          const tasksFile = await new TasksStore(projectRoot).read();
          const state = await new LoopStateStore(projectRoot).readOrNull();

          const report = buildLoopStatusReport(
            state,
            config,
            tasksFile.tasks,
            tasksFile.has_conflicts === true,
          );
          if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatLoopStatus(report));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`loop status の実行に失敗しました: ${message}`);
          console.error(
            "  .gantt-sync/ の設定・同期データ、または loop-state.json が破損している可能性があります。",
          );
          process.exitCode = 1;
        }
      }),
  );
