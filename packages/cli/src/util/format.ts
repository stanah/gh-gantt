export function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "-";
  if (typeof val === "string") return `"${val}"`;
  if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
    return val.length === 0 ? "[]" : val.join(", ");
  }
  return JSON.stringify(val);
}
