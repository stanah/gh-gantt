import { z } from "zod";
import type { NextActionCategory } from "./project-map.js";

// ---------------------------------------------------------------------------
// 外側ループの実行ジャーナル (.gantt-sync/loop-state.json) — ADR-016 / ADR-017
// ---------------------------------------------------------------------------

/**
 * 外側ループの停止理由（ADR-017 の分類）。
 *
 * 先頭 3 つは ADR-016 の `no_ready_tasks` を置き換える ready 枯渇の 3 分類、
 * 残りは ADR-016 から変更なしで引き継ぐ停止条件。
 */
export const LOOP_STOP_REASONS = [
  "all_done",
  "all_blocked",
  "backlog_needs_decomposition",
  "conflicts_present",
  "human_gate_required",
  "budget_exhausted",
] as const;

export type LoopStopReason = (typeof LOOP_STOP_REASONS)[number];

/** イテレーションの結末。 */
export const LOOP_ITERATION_OUTCOMES = [
  "completed",
  "verify_failed",
  "abandoned",
  "stopped",
] as const;

export type LoopIterationOutcome = (typeof LOOP_ITERATION_OUTCOMES)[number];

/** 検証コマンド 1 回分の実行結果（ADR-017 の予実記録の一部）。 */
export interface LoopVerifyResult {
  command: string;
  passed: boolean;
  /** 何回目の試行か（1 始まり）。リトライ予算は dev-role の maxExecutorRetries に従う。 */
  attempt: number;
}

/**
 * decide が選定したタスクの選定根拠。
 *
 * ADR-017 に従い、既存 `NextAction`（score / category / reason）のスナップショットを
 * そのまま埋め込む。独自の理由列挙は導入しない。
 */
export interface LoopSelection {
  taskId: string;
  score: number;
  category: NextActionCategory;
  /** 推薦理由の 1 行日本語ラベル（NextAction.reason）。 */
  reason: string;
}

/** 外側ループ 1 イテレーションの記録。 */
export interface LoopIteration {
  /** 連番（1 始まり）。 */
  id: number;
  startedAt: string;
  /** ADR-017 の予実記録。完了時に記録し、所要は startedAt との差分で導出する。 */
  completedAt?: string;
  /** 選定タスク ID。停止のみを記録するイテレーションでは null。 */
  selectedTask: string | null;
  /** 選定根拠（NextAction スナップショット）。 */
  selection?: LoopSelection;
  /** このイテレーションでやることの要約。 */
  decision: string;
  outcome?: LoopIterationOutcome;
  verifyResults?: LoopVerifyResult[];
  reviewOutcome?: string | null;
  stopReason?: LoopStopReason;
}

/** `.gantt-sync/loop-state.json` の全体構造。 */
export interface LoopState {
  version: string;
  iterations: LoopIteration[];
}

const LoopVerifyResultSchema: z.ZodType<LoopVerifyResult> = z.object({
  command: z.string().min(1),
  passed: z.boolean(),
  attempt: z.number().int().positive(),
});

// NextActionCategory の全メンバー。ZodType<LoopSelection> への代入で
// メンバーの正当性は型検査される（値の増減時はここも更新する）。
const NEXT_ACTION_CATEGORIES = [
  "unlocker",
  "critical",
  "risk",
  "review_waiting",
  "quick_win",
  "ready",
] as const satisfies readonly NextActionCategory[];

const LoopSelectionSchema: z.ZodType<LoopSelection> = z.object({
  taskId: z.string().min(1),
  score: z.number(),
  category: z.enum(NEXT_ACTION_CATEGORIES),
  reason: z.string().min(1),
});

export const LoopIterationSchema: z.ZodType<LoopIteration> = z
  .object({
    id: z.number().int().positive(),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
    selectedTask: z.string().nullable(),
    selection: LoopSelectionSchema.optional(),
    decision: z.string().min(1),
    outcome: z.enum(LOOP_ITERATION_OUTCOMES).optional(),
    verifyResults: z.array(LoopVerifyResultSchema).optional(),
    reviewOutcome: z.string().nullable().optional(),
    stopReason: z.enum(LOOP_STOP_REASONS).optional(),
  })
  .superRefine((it, ctx) => {
    // フィールド間の不整合はジャーナルの直接編集破損とみなす
    if (it.selection && it.selectedTask !== it.selection.taskId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selection", "taskId"],
        message: "selection.taskId と selectedTask が一致しません",
      });
    }
    if (it.outcome === "stopped" && !it.stopReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stopReason"],
        message: "outcome が stopped のイテレーションには stopReason が必要です",
      });
    }
  });

export const LoopStateSchema: z.ZodType<LoopState> = z.object({
  version: z.string(),
  iterations: z.array(LoopIterationSchema),
});

/** 空のループ状態を生成する。 */
export function createEmptyLoopState(): LoopState {
  return { version: "1", iterations: [] };
}

// ---------------------------------------------------------------------------
// Config.loop セクション（ADR-016 案C / ADR-017）と実効値の解決
// ---------------------------------------------------------------------------

/** `gantt.config.json` の loop セクション。後方互換のためすべて optional。 */
export interface LoopConfig {
  /** 外側ループの最大イテレーション数。未指定は無制限。 */
  maxIterations?: number;
  /** 有効にする停止条件。未指定は全条件が有効。 */
  stopWhen?: LoopStopReason[];
  /**
   * 検証失敗時の扱い。retry のリトライ予算は dev-role の maxExecutorRetries に
   * 従う（ADR-017）。値の拡張は案D で行う。
   */
  onVerifyFailure?: "retry";
}

export const LoopConfigSchema: z.ZodType<LoopConfig> = z.object({
  maxIterations: z.number().int().positive().optional(),
  stopWhen: z.array(z.enum(LOOP_STOP_REASONS)).optional(),
  onVerifyFailure: z.enum(["retry"]).optional(),
});

/** stopWhen 未指定時のデフォルト（全停止条件を有効にする）。 */
export const DEFAULT_LOOP_STOP_CONDITIONS: readonly LoopStopReason[] = LOOP_STOP_REASONS;

export interface ResolvedLoopConfig {
  maxIterations: number | null;
  stopWhen: readonly LoopStopReason[];
  onVerifyFailure: "retry";
}

/**
 * `Config.loop` にデフォルトを適用した実効値を返す。
 * loop 未設定でも安全に動作する（後方互換）。
 */
export function resolveLoopConfig(loop: LoopConfig | undefined): ResolvedLoopConfig {
  return {
    maxIterations: loop?.maxIterations ?? null,
    stopWhen: loop?.stopWhen ?? DEFAULT_LOOP_STOP_CONDITIONS,
    onVerifyFailure: loop?.onVerifyFailure ?? "retry",
  };
}
