import { describe, expect, it } from "vitest";
import {
  parseAcceptanceCriteriaBody,
  serializeAcceptanceCriteriaBody,
  renderAcceptanceCriteriaBlock,
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

  it("[NFR-STABILITY-011-AC3] marker の大小文字揺れがあっても body から分離する", () => {
    const body = [
      "説明文",
      "",
      "<!-- GH-GANTT:ACCEPTANCE-CRITERIA:START -->",
      "## 受入基準",
      "",
      "- [ ] 追加できる",
      "<!-- GH-GANTT:ACCEPTANCE-CRITERIA:END -->",
    ].join("\n");

    const parsed = parseAcceptanceCriteriaBody(body);

    expect(parsed.body).toBe("説明文");
    expect(parsed.acceptance_criteria).toEqual([{ description: "追加できる", checked: false }]);
    expect(parsed.has_acceptance_criteria_block).toBe(true);
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

describe("[FR-CLI-012-AC2] 空の受入基準スロット", () => {
  it("テンプレート用の空ブロックを body から分離できる", () => {
    const body = ["説明文", "", renderAcceptanceCriteriaBlock([])].join("\n");
    const parsed = parseAcceptanceCriteriaBody(body);

    expect(body).toContain("## 受入基準");
    expect(parsed.body).toBe("説明文");
    expect(parsed.acceptance_criteria).toEqual([]);
  });

  it("空の管理ブロックを含む body は直列化後も受入基準セクションを保持する", () => {
    const original = ["説明文", "", renderAcceptanceCriteriaBlock([])].join("\n");
    const serialized = serializeAcceptanceCriteriaBody(original, []);

    expect(serialized).toContain("説明文");
    expect(serialized).toContain("## 受入基準");
    expect(serialized).toContain("<!-- gh-gantt:acceptance-criteria:start -->");
    expect(serialized).toContain("<!-- gh-gantt:acceptance-criteria:end -->");
  });

  it("slot メタデータがある body は空の受入基準セクションを再生成する", () => {
    const serialized = serializeAcceptanceCriteriaBody("説明文", [], { includeEmptyBlock: true });

    expect(serialized).toContain("説明文");
    expect(serialized).toContain("## 受入基準");
    expect(serialized).toContain("<!-- gh-gantt:acceptance-criteria:start -->");
    expect(serialized).toContain("<!-- gh-gantt:acceptance-criteria:end -->");
  });
});
