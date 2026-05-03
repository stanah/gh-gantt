import { describe, expect, it } from "vitest";
import {
  parseTaskCloseEvidenceBody,
  serializeTaskCloseEvidenceBody,
  TASK_CLOSE_EVIDENCE_END_MARKER,
  TASK_CLOSE_EVIDENCE_START_MARKER,
} from "../index.js";

describe("[FR-CLI-016-AC4] close evidence の Issue body 往復", () => {
  it("close evidence block を body に追加して parse できる", () => {
    const body = serializeTaskCloseEvidenceBody(
      "本文",
      "pnpm test:json と PR #222 merge を確認",
      "2026-05-03T22:30:00.000Z",
    );

    expect(body).toContain(TASK_CLOSE_EVIDENCE_START_MARKER);
    expect(body).toContain("Recorded-At: 2026-05-03T22:30:00.000Z");
    expect(body).toContain("pnpm test:json と PR #222 merge を確認");
    expect(body).toContain(TASK_CLOSE_EVIDENCE_END_MARKER);

    const parsed = parseTaskCloseEvidenceBody(body);
    expect(parsed.body).toBe("本文");
    expect(parsed.evidence).toBe("pnpm test:json と PR #222 merge を確認");
    expect(parsed.recorded_at).toBe("2026-05-03T22:30:00.000Z");
    expect(parsed.has_close_evidence_block).toBe(true);
  });

  it("既存の close evidence block を置き換える", () => {
    const first = serializeTaskCloseEvidenceBody("本文", "古い証跡", "2026-05-03T22:00:00.000Z");
    const second = serializeTaskCloseEvidenceBody(first, "新しい証跡", "2026-05-03T22:30:00.000Z");

    expect(second).not.toContain("古い証跡");
    expect(parseTaskCloseEvidenceBody(second).evidence).toBe("新しい証跡");
  });

  it("手編集された大小文字違いの管理ブロックを parse できる", () => {
    const body = [
      "本文",
      TASK_CLOSE_EVIDENCE_START_MARKER.toUpperCase(),
      "## 完了証跡",
      "",
      "recorded-at: 2026-05-03T22:30:00.000Z",
      "evidence:",
      "pnpm test:json pass",
      TASK_CLOSE_EVIDENCE_END_MARKER.toUpperCase(),
    ].join("\n");

    const parsed = parseTaskCloseEvidenceBody(body);

    expect(parsed.body).toBe("本文");
    expect(parsed.recorded_at).toBe("2026-05-03T22:30:00.000Z");
    expect(parsed.evidence).toBe("pnpm test:json pass");
    expect(parsed.has_close_evidence_block).toBe(true);
  });
});
