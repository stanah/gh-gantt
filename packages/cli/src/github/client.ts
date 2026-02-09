import { graphql } from "@octokit/graphql";
import { getToken } from "./auth.js";

export async function createGraphQLClient() {
  const token = await getToken();
  return graphql.defaults({
    headers: { authorization: `token ${token}` },
  });
}
