import { describe, expect, it } from "vitest";
import {
  parseAcceptanceCriteriaBody,
  serializeAcceptanceCriteriaBody,
} from "../acceptance-criteria.js";

describe("[FR-CLI-011-AC3] Issue body の受入基準管理ブロック", () => {
  it("body から受入基準を first-class フィールドとして分離する", () => {
    const body = [
      "説明文",
      "",
      "<!-- gh-gantt:acceptance-criteria:start -->",
      "## 受入基準",
      "",
      "- [ ] 追加できる",
      "- [x] 完了にできる",
      "<!-- gh-gantt:acceptance-criteria:end -->",
    ].join("\n");

    const parsed = parseAcceptanceCriteriaBody(body);

    expect(parsed.body).toBe("説明文");
    expect(parsed.acceptance_criteria).toEqual([
      { description: "追加できる", checked: false },
      { description: "完了にできる", checked: true },
    ]);
  });

  it("受入基準を GitHub Issue body の管理ブロックとして直列化する", () => {
    const body = serializeAcceptanceCriteriaBody("説明文", [
      { description: "追加できる", checked: false },
      { description: "完了にできる", checked: true },
    ]);

    expect(body).toContain("説明文");
    expect(body).toContain("<!-- gh-gantt:acceptance-criteria:start -->");
    expect(body).toContain("- [ ] 追加できる");
    expect(body).toContain("- [x] 完了にできる");
    expect(body).toContain("<!-- gh-gantt:acceptance-criteria:end -->");
  });
});
