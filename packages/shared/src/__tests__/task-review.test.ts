import { describe, it, expect } from "vitest";
import {
  parseTaskReviewBody,
  renderTaskReviewBlock,
  serializeTaskReviewBody,
} from "../task-review.js";

describe("[FR-CLI-014-AC3] タスクレビューの Issue body 管理ブロック", () => {
  it("review requirement と approval を body から first-class フィールドへ抽出する", () => {
    const body = [
      "説明文",
      "",
      "<!-- gh-gantt:review:start -->",
      "Require-Review: true",
      "Review-Approved-By: @alice",
      "Review-Approved-At: 2026-05-03T21:00:00.000Z",
      "<!-- gh-gantt:review:end -->",
    ].join("\n");

    const parsed = parseTaskReviewBody(body);

    expect(parsed.body).toBe("説明文");
    expect(parsed.require_review).toBe(true);
    expect(parsed.review_approved_by).toBe("alice");
    expect(parsed.review_approved_at).toBe("2026-05-03T21:00:00.000Z");
  });

  it("未設定なら body を変更せず default 値を返す", () => {
    const parsed = parseTaskReviewBody("説明文");

    expect(parsed.body).toBe("説明文");
    expect(parsed.require_review).toBe(false);
    expect(parsed.review_approved_by).toBeNull();
    expect(parsed.review_approved_at).toBeNull();
  });

  it("設定済み項目だけを GitHub Issue body 用に直列化する", () => {
    const serialized = serializeTaskReviewBody("説明文", {
      require_review: true,
      review_approved_by: null,
      review_approved_at: null,
    });

    expect(serialized).toBe(
      [
        "説明文",
        "",
        "<!-- gh-gantt:review:start -->",
        "Require-Review: true",
        "<!-- gh-gantt:review:end -->",
      ].join("\n"),
    );
  });

  it("既存の review ブロックを置き換えて二重化しない", () => {
    const body = serializeTaskReviewBody("説明文", {
      require_review: true,
      review_approved_by: "alice",
      review_approved_at: "2026-05-03T21:00:00.000Z",
    });

    const serialized = serializeTaskReviewBody(body, {
      require_review: true,
      review_approved_by: "bob",
      review_approved_at: "2026-05-03T21:10:00.000Z",
    });

    expect(serialized?.match(/gh-gantt:review:start/g)).toHaveLength(1);
    expect(parseTaskReviewBody(serialized).review_approved_by).toBe("bob");
  });

  it("全項目が未設定なら管理ブロックを出力しない", () => {
    expect(
      renderTaskReviewBlock({
        require_review: false,
        review_approved_by: null,
        review_approved_at: null,
      }),
    ).toBeNull();
    expect(
      serializeTaskReviewBody("説明文", {
        require_review: false,
        review_approved_by: null,
        review_approved_at: null,
      }),
    ).toBe("説明文");
  });
});
