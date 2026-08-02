/** JavaScript の文字列 code unit 順で比較する。locale や実行環境には依存しない。 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** object key を code unit 順に再帰整列した JSON 互換値を返す。 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  return value;
}

/** key の挿入順序と locale に依存しない canonical JSON を返す。 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}
