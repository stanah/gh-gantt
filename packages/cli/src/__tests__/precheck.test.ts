import { describe, it, expect, vi } from "vitest";
import { checkRemoteChanges } from "../github/projects.js";

describe("[Issue #157] checkRemoteChanges", () => {
  it("[Issue #157] totalCount > 0 のとき true を返す", async () => {
    const gql = vi.fn().mockResolvedValue({
      repository: { issues: { totalCount: 3 } },
    });
    const result = await checkRemoteChanges(
      gql as any,
      "stanah",
      "gh-gantt",
      "2026-04-01T00:00:00Z",
    );
    expect(result).toBe(true);
    expect(gql).toHaveBeenCalledOnce();
  });

  it("[Issue #157] totalCount === 0 のとき false を返す", async () => {
    const gql = vi.fn().mockResolvedValue({
      repository: { issues: { totalCount: 0 } },
    });
    const result = await checkRemoteChanges(
      gql as any,
      "stanah",
      "gh-gantt",
      "2026-04-01T00:00:00Z",
    );
    expect(result).toBe(false);
  });
});
