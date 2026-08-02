import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

async function readRepoFile(path: string): Promise<string> {
  const content = await readFile(resolve(repoRoot, path), "utf-8");
  return z.string().min(1).parse(content);
}

function expectOrdered(content: string, fragments: string[]): void {
  let previousIndex = -1;
  for (const fragment of fragments) {
    const currentIndex = content.indexOf(fragment);
    expect(currentIndex, `${fragment} が見つからない`).toBeGreaterThan(previousIndex);
    previousIndex = currentIndex;
  }
}

describe("[NFR-STABILITY-014-AC9] ready frontier は global/state/repository 上限内で isolated workspace を claim/lease し、heartbeat、release/reclaim、completion fencing、停止 gate、Run Graph audit、fan-in 再評価を持つ", () => {
  it("汎用 skill と repository workflow が同じ公開 CLI lifecycle を順序付きで定義する", async () => {
    const [skill, workflow] = await Promise.all([
      readRepoFile("skills/gh-gantt-workflow/SKILL.md"),
      readRepoFile(".gantt-sync/workflow.md"),
    ]);
    const lifecycle = [
      "gh-gantt pull",
      "gh-gantt run dispatch",
      "gh-gantt run claim",
      "isolated workspace",
      "gh-gantt run heartbeat",
      "completion fencing",
      "gh-gantt run release",
      "gh-gantt run reclaim",
      "fan-in",
    ];

    expectOrdered(skill, lifecycle);
    expectOrdered(workflow, lifecycle);
  });

  it("dispatch は sync conflict、open iteration、review gate、human gate で停止する", async () => {
    const documents = await Promise.all([
      readRepoFile("skills/gh-gantt-workflow/SKILL.md"),
      readRepoFile(".gantt-sync/workflow.md"),
    ]);

    for (const document of documents) {
      expect(document).toContain("sync conflict");
      expect(document).toContain("open iteration");
      expect(document).toContain("review gate");
      expect(document).toContain("human gate");
      expect(document).toContain("dispatch しない");
    }
  });

  it("gh-gantt は dispatch plan と event contract だけを提供し runner や workspace を起動しない", async () => {
    const documents = await Promise.all([
      readRepoFile("skills/gh-gantt-workflow/SKILL.md"),
      readRepoFile(".gantt-sync/workflow.md"),
    ]);

    for (const document of documents) {
      expect(document).toContain("dispatch plan");
      expect(document).toContain("event contract");
      expect(document).toContain("runner を内蔵しない");
      expect(document).toContain("workspace を作成しない");
    }
  });

  it("claim lifecycle は Run Graph audit へ記録し receipt 確定後の中断を同じ event ID で reconciliation する", async () => {
    const documents = await Promise.all([
      readRepoFile("skills/gh-gantt-workflow/SKILL.md"),
      readRepoFile(".gantt-sync/workflow.md"),
    ]);

    for (const document of documents) {
      expect(document).toContain("Run Graph audit");
      expect(document).toContain("claim_event_authorized");
      expect(document).toContain("domain validation");
      expect(document).toContain("--gate-snapshot <path>");
      expect(document).toContain("sourceRevision");
      expect(document).toContain("combined fingerprint");
      expect(document).toContain("pending authorization");
      expect(document).toContain("authorization_pending");
      expect(document).toContain("historical audit");
      expect(document).toContain("audit:${receipt.eventId}");
      expect(document).toContain("claim を維持したまま更新 proof");
      expect(document).toContain("中間 event の認可は release ではない");
      expect(document).toContain("同じ event ID");
      expect(document).toContain("reconciliation");
    }
  });
});
