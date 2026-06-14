import { describe, expect, it } from "vitest";
import { extractManagedBlock } from "../managed-block.js";

describe("[NFR-STABILITY-011-AC3] managed block marker の抽出", () => {
  it("小文字化で長さが変わる Unicode が前にあっても元の index で抽出する", () => {
    const body = [
      "İ prefix",
      "",
      "<!-- GH-GANTT:ROLES:START -->",
      "implementer: codex",
      "<!-- GH-GANTT:ROLES:END -->",
      "",
      "tail",
    ].join("\n");

    const block = extractManagedBlock(
      body,
      "<!-- gh-gantt:roles:start -->",
      "<!-- gh-gantt:roles:end -->",
    );

    expect(block?.block).toBe(
      ["<!-- GH-GANTT:ROLES:START -->", "implementer: codex", "<!-- GH-GANTT:ROLES:END -->"].join(
        "\n",
      ),
    );
    expect(block?.content).toBe("\nimplementer: codex\n");
    expect(block?.body).toBe(["İ prefix", "tail"].join("\n"));
  });
});
