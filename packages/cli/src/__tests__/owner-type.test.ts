import { describe, it, expect, vi } from "vitest";
import { detectOwnerType } from "../github/projects.js";

function mockGql(response: any) {
  return vi.fn().mockResolvedValue(response) as any;
}

describe("detectOwnerType", () => {
  it("returns 'user' when repositoryOwner.__typename is User", async () => {
    const gql = mockGql({ repositoryOwner: { __typename: "User" } });
    const result = await detectOwnerType(gql, "stanah");
    expect(result).toBe("user");
    expect(gql).toHaveBeenCalledWith(expect.any(String), { login: "stanah" });
  });

  it("returns 'organization' when repositoryOwner.__typename is Organization", async () => {
    const gql = mockGql({ repositoryOwner: { __typename: "Organization" } });
    const result = await detectOwnerType(gql, "my-org");
    expect(result).toBe("organization");
  });

  it("throws when repositoryOwner is null", async () => {
    const gql = mockGql({ repositoryOwner: null });
    await expect(detectOwnerType(gql, "nonexistent")).rejects.toThrow(
      'Could not resolve "nonexistent" as a GitHub user or organization',
    );
  });

  it("throws when gql call fails", async () => {
    const gql = vi.fn().mockRejectedValue(new Error("GraphQL error")) as any;
    await expect(detectOwnerType(gql, "bad-login")).rejects.toThrow("GraphQL error");
  });
});
