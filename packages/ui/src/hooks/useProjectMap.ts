import { useMemo } from "react";
import { buildProjectMapViewModel, type ProjectMapViewModel } from "@gh-gantt/shared";
import type { Config, Task } from "../types/index.js";

/**
 * Project Map UI 用の派生ビュー（{@link ProjectMapViewModel}）を構築する hook。
 *
 * 既存の `Task[]` と `Config` から shared の {@link buildProjectMapViewModel} を呼び、
 * 入力が変化したときのみ再計算する。`config` が未取得の間は null を返す。
 *
 * @param tasks - 全タスク
 * @param config - gantt 設定（未取得なら null）
 * @param nextActionsLimit - Next Actions の最大件数（既定 5）
 * @returns ViewModel、または config 未取得時は null
 */
export function useProjectMap(
  tasks: Task[],
  config: Config | null,
  nextActionsLimit = 5,
): ProjectMapViewModel | null {
  return useMemo(() => {
    if (!config) return null;
    return buildProjectMapViewModel(tasks, config, { nextActionsLimit });
  }, [tasks, config, nextActionsLimit]);
}
