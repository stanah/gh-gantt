export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err);
}

export function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "-";
  if (typeof val === "string") return `"${val}"`;
  if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
    return val.length === 0 ? "[]" : "[" + val.join(", ") + "]";
  }
  return JSON.stringify(val);
}
