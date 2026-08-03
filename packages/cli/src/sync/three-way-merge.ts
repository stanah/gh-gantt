import { SYNC_FIELD_KEYS } from "@gh-gantt/shared";
import type { SyncFields } from "@gh-gantt/shared";

export { SYNC_FIELD_KEYS };

export interface FieldConflict {
  field: string;
  base: unknown;
  current: unknown;
  incoming: unknown;
}

export interface MergeResult {
  merged: SyncFields;
  conflicts: FieldConflict[];
}

/**
 * フィールド値を比較用の正準JSON文字列へ正規化する。
 * - 配列: 直列化前に並べ替える。`blocked_by`は`.task`順、その他は文字列値順とする。
 * - オブジェクト（custom_fields）: 直列化前にキーを並べ替える。
 */
function normalizeForCompare(field: keyof SyncFields, value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (field === "acceptance_criteria" || field === "sub_tasks") {
      return JSON.stringify(value);
    }

    const sorted = [...value].sort((a, b) => {
      // blocked_byは.taskプロパティ順に並べ替える。
      if (typeof a === "object" && a !== null && "task" in a) {
        return String((a as { task: string }).task).localeCompare(
          String((b as { task: string }).task),
        );
      }
      // 文字列配列（assignees、labels）は文字列値順に並べ替える。
      return String(a).localeCompare(String(b));
    });
    return JSON.stringify(sorted);
  }

  if (typeof value === "object" && value !== null) {
    // custom_fieldsはキー順に並べ替える。
    const sorted = Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (value as Record<string, unknown>)[key];
        return acc;
      }, {});
    return JSON.stringify(sorted);
  }

  return JSON.stringify(value);
}

/**
 * SyncFieldsをthree-way mergeする。
 *
 * 各フィールドを次の規則で処理する。
 * - base == current && base == incoming → 変更なし（baseを維持）
 * - base == current && base != incoming → incomingを採用（remoteのみ変更）
 * - base != current && base == incoming → currentを維持（localのみ変更）
 * - 両方が同じ値へ変更 → currentを維持
 * - 両方が異なる値へ変更 → conflict（merge結果ではcurrentを維持）
 */
export function threeWayMerge(
  base: SyncFields,
  current: SyncFields,
  incoming: SyncFields,
): MergeResult {
  const merged = { ...current };
  const conflicts: FieldConflict[] = [];

  for (const field of SYNC_FIELD_KEYS) {
    const baseStr = normalizeForCompare(field, base[field]);
    const currentStr = normalizeForCompare(field, current[field]);
    const incomingStr = normalizeForCompare(field, incoming[field]);

    if (baseStr === currentStr && baseStr === incomingStr) {
      // 変更なし。
      continue;
    }

    if (baseStr === currentStr && baseStr !== incomingStr) {
      // remoteのみの変更なのでincomingを採用する。
      (merged as Record<string, unknown>)[field] = incoming[field];
      continue;
    }

    if (baseStr !== currentStr && baseStr === incomingStr) {
      // localのみの変更なので、merge済みのcurrentを維持する。
      continue;
    }

    if (currentStr === incomingStr) {
      // 両方が同じ値へ変更されたため、merge済みのcurrentを維持する。
      continue;
    }

    // 両方が異なる値へ変更されたためconflictとし、merge結果ではcurrentを維持する。
    conflicts.push({
      field,
      base: base[field],
      current: current[field],
      incoming: incoming[field],
    });
  }

  return { merged, conflicts };
}
