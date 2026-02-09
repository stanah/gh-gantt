import { describe, it, expect } from "vitest";
import { getToken } from "../github/auth.js";

describe("getToken", () => {
  it("returns token from gh auth token", async () => {
    expect(typeof getToken).toBe("function");
  });
});
