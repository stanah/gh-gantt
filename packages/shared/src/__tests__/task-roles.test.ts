import { describe, it, expect } from "vitest";
import { parseTaskRolesBody, renderTaskRolesBlock, serializeTaskRolesBody } from "../task-roles.js";

describe("[FR-CLI-013-AC3] タスクロールの Issue body 管理ブロック", () => {
  it("implementer と reviewer を body から first-class フィールドへ抽出する", () => {
    const body = [
      "説明文",
      "",
      "<!-- gh-gantt:roles:start -->",
      "Implementer: @alice",
      "Reviewer: bob",
      "<!-- gh-gantt:roles:end -->",
    ].join("\n");

    const parsed = parseTaskRolesBody(body);

    expect(parsed.body).toBe("説明文");
    expect(parsed.implementer).toBe("alice");
    expect(parsed.reviewer).toBe("bob");
    expect(parsed.has_roles_block).toBe(true);
  });

  it("ロールが未設定なら body を変更せず null として返す", () => {
    const parsed = parseTaskRolesBody("説明文");

    expect(parsed.body).toBe("説明文");
    expect(parsed.implementer).toBeNull();
    expect(parsed.reviewer).toBeNull();
    expect(parsed.has_roles_block).toBe(false);
  });

  it("設定済みロールだけを GitHub Issue body 用に直列化する", () => {
    const serialized = serializeTaskRolesBody("説明文", {
      implementer: "alice",
      reviewer: null,
    });

    expect(serialized).toBe(
      [
        "説明文",
        "",
        "<!-- gh-gantt:roles:start -->",
        "Implementer: @alice",
        "<!-- gh-gantt:roles:end -->",
      ].join("\n"),
    );
  });

  it("既存のロールブロックを置き換えて二重化しない", () => {
    const body = serializeTaskRolesBody("説明文", {
      implementer: "alice",
      reviewer: "bob",
    });

    const serialized = serializeTaskRolesBody(body, {
      implementer: "carol",
      reviewer: "dave",
    });

    expect(serialized?.match(/gh-gantt:roles:start/g)).toHaveLength(1);
    expect(parseTaskRolesBody(serialized).implementer).toBe("carol");
    expect(parseTaskRolesBody(serialized).reviewer).toBe("dave");
  });

  it("両方未設定なら管理ブロックを出力しない", () => {
    expect(renderTaskRolesBlock({ implementer: null, reviewer: null })).toBeNull();
    expect(serializeTaskRolesBody("説明文", { implementer: null, reviewer: null })).toBe("説明文");
  });
});
