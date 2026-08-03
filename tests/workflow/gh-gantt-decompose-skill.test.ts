import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("[NFR-STABILITY-014-AC8] gh-gantt-decomposeのmutation checkpoint", () => {
  it("実行中Runの再構成を無承認でIssue化せずproposalへ委譲する", async () => {
    const skill = await readFile("skills/gh-gantt-decompose/SKILL.md", "utf8");

    expect(skill).toContain("origin Runをmutation checkpointへ停止");
    expect(skill).toContain("gh-gantt mutation execute --input");
    expect(skill).toContain("human approval");
    expect(skill).toContain("unknown");
    expect(skill).toContain("自動再送しない");
  });
});
