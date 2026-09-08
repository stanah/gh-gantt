import { describe, it, expect } from "vitest";
import {
  linkedPullRequestObjects,
  linkedPullRequestStatus,
  summarizeLinkedPullRequests,
} from "../linked-pr.js";
import type { LinkedPullRequest } from "../types.js";

const pr = (overrides: Partial<LinkedPullRequest>): LinkedPullRequest => ({
  number: 1,
  title: "pr",
  state: "open",
  url: "https://github.com/owner/repo/pull/1",
  ...overrides,
});

describe("[FR-STORE-003-AC2] linked_prs の is_draft は省略可で、Draft PR は state が open でも draft として判別できる", () => {
  it("is_draft が true で open なら draft、無ければ open として扱う", () => {
    expect(linkedPullRequestStatus(pr({ state: "open", is_draft: true }))).toBe("draft");
    expect(linkedPullRequestStatus(pr({ state: "open", is_draft: false }))).toBe("open");
    expect(linkedPullRequestStatus(pr({ state: "open" }))).toBe("open");
  });

  it("merged / closed は is_draft にかかわらずその状態になり、大文字の state も受理する", () => {
    expect(linkedPullRequestStatus(pr({ state: "merged", is_draft: true }))).toBe("merged");
    expect(linkedPullRequestStatus(pr({ state: "MERGED" }))).toBe("merged");
    expect(linkedPullRequestStatus(pr({ state: "closed", is_draft: true }))).toBe("closed");
  });

  it("legacy の number 参照は状態を持たないため要約から除外する", () => {
    expect(linkedPullRequestObjects([42, pr({ number: 7 })])).toEqual([pr({ number: 7 })]);
    expect(summarizeLinkedPullRequests([42])).toBeNull();
    expect(summarizeLinkedPullRequests([])).toBeNull();
  });
});

describe("[FR-VIS-027-AC10] 関連 PR の代表は最も進んだ状態 (merged > open > draft > closed) で、件数を添える", () => {
  it("merged が open や draft より優先され、件数は状態を持つ PR の総数になる", () => {
    const summary = summarizeLinkedPullRequests([
      pr({ number: 10, state: "open", is_draft: true }),
      pr({ number: 11, state: "merged", url: "https://github.com/owner/repo/pull/11" }),
      pr({ number: 12, state: "open" }),
      42,
    ]);
    expect(summary).toEqual({
      status: "merged",
      number: 11,
      url: "https://github.com/owner/repo/pull/11",
      count: 3,
    });
  });

  it("open は draft より、draft は closed より進んだ状態として代表になる", () => {
    expect(
      summarizeLinkedPullRequests([
        pr({ number: 1, state: "closed" }),
        pr({ number: 2, state: "open", is_draft: true }),
      ])?.status,
    ).toBe("draft");
    expect(
      summarizeLinkedPullRequests([
        pr({ number: 1, state: "open", is_draft: true }),
        pr({ number: 2, state: "open" }),
      ])?.status,
    ).toBe("open");
  });

  it("同じ状態なら番号の大きい (新しい) PR を代表にする", () => {
    const summary = summarizeLinkedPullRequests([
      pr({ number: 3, state: "open" }),
      pr({ number: 5, state: "open", url: "https://github.com/owner/repo/pull/5" }),
      pr({ number: 4, state: "open" }),
    ]);
    expect(summary?.number).toBe(5);
    expect(summary?.url).toBe("https://github.com/owner/repo/pull/5");
    expect(summary?.count).toBe(3);
  });
});
