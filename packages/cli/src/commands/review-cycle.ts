import { Command } from "commander";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createGraphQLClient } from "../github/client.js";
import {
  buildResolveReviewThreadsMutation,
  buildResolveThreadVariables,
  buildThreadRepliesMutation,
  buildThreadReplyVariables,
  CREATE_PENDING_REVIEW_MUTATION,
  formatReviewCycleSummary,
  hasPendingReviewWork,
  parseRepo,
  REVIEW_CYCLE_QUERY,
  ReviewCyclePlanSchema,
  selectPullRequest,
  SUBMIT_PENDING_REVIEW_MUTATION,
  summarizeReviewCycle,
  type ReviewCyclePlan,
  type ReviewCycleQueryResponse,
  type ReviewCycleSummary,
} from "../github/review-cycle.js";
import { ConfigStore } from "../store/config.js";

const execFileAsync = promisify(execFile);

interface CheckOptions {
  repo?: string;
  pr?: string;
  currentBranch?: boolean;
  maxAgeSeconds?: string;
  hook?: boolean;
  quiet?: boolean;
}

interface SubmitOptions {
  repo?: string;
  plan: string;
  dryRun?: boolean;
}

interface ReviewCycleCache {
  repo: string;
  branch: string | null;
  pr: number | null;
  checkedAt: number;
  summary: ReviewCycleSummary | null;
}

export const reviewCycleCommand = new Command("review-cycle").description(
  "Detect and standardize PR review feedback cycles",
);

reviewCycleCommand
  .command("check")
  .description("Check the current PR for unresolved review feedback")
  .option("--repo <owner/name>", "Repository to inspect")
  .option("--pr <number>", "Pull request number")
  .option("--current-branch", "Find the open PR for the current branch", true)
  .option("--max-age-seconds <seconds>", "Reuse hook cache while fresh", "0")
  .option("--hook", "Hook mode: never block the caller")
  .option("--quiet", "Do not print anything when no review work is pending")
  .action(async (opts: CheckOptions) => {
    try {
      const summary = await checkReviewCycle(opts);
      if (!summary) {
        if (!opts.hook && !opts.quiet) {
          console.log("対象 PR が見つかりません。");
        }
        return;
      }
      if (opts.quiet && !hasPendingReviewWork(summary)) return;
      if (opts.hook && !hasPendingReviewWork(summary)) return;
      console.log(formatReviewCycleSummary(summary));
    } catch (err) {
      if (opts.hook) {
        console.error(`[gh-gantt review-cycle] skipped: ${formatError(err)}`);
        return;
      }
      throw err;
    }
  });

reviewCycleCommand
  .command("submit")
  .description("Submit review replies as one pending review, then bulk-resolve threads")
  .requiredOption("--plan <path>", "JSON plan with replies and resolveThreadIds")
  .option("--repo <owner/name>", "Repository to update")
  .option("--dry-run", "Validate and print planned operations without writing to GitHub")
  .action(async (opts: SubmitOptions) => {
    const plan = await readReviewCyclePlan(opts.plan);
    const repo = opts.repo ?? plan.repo ?? (await repoFromConfig());
    const { owner, name } = parseRepo(repo);

    if (opts.dryRun) {
      console.log(`PR #${plan.pr} (${repo})`);
      console.log(`pending review replies: ${plan.replies.length}`);
      console.log(`resolve threads: ${plan.resolveThreadIds.length}`);
      if (plan.replies.length > 0) {
        console.log(buildThreadRepliesMutation(plan.replies.length));
      }
      if (plan.resolveThreadIds.length > 0) {
        console.log(buildResolveReviewThreadsMutation(plan.resolveThreadIds.length));
      }
      return;
    }

    const gql = await createGraphQLClient();
    const pr = await fetchPullRequestForSubmit(gql, owner, name, plan.pr);

    let reviewId: string | null = null;
    if (plan.replies.length > 0) {
      const created = await gql<{
        addPullRequestReview: { pullRequestReview: { id: string } };
      }>(CREATE_PENDING_REVIEW_MUTATION, {
        pullRequestId: pr.id,
        commitOID: pr.headRefOid,
        body: plan.reviewBody,
      });
      reviewId = created.addPullRequestReview.pullRequestReview.id;

      const repliesMutation = buildThreadRepliesMutation(plan.replies.length);
      if (repliesMutation) {
        await gql(repliesMutation, buildThreadReplyVariables(reviewId, plan.replies));
      }

      await gql(SUBMIT_PENDING_REVIEW_MUTATION, {
        pullRequestReviewId: reviewId,
        body: plan.reviewBody,
      });
    }

    const resolveMutation = buildResolveReviewThreadsMutation(plan.resolveThreadIds.length);
    if (resolveMutation) {
      await gql(resolveMutation, buildResolveThreadVariables(plan.resolveThreadIds));
    }

    console.log(
      `Review cycle submitted: replies=${plan.replies.length}, resolved=${plan.resolveThreadIds.length}`,
    );
  });

async function checkReviewCycle(opts: CheckOptions): Promise<ReviewCycleSummary | null> {
  const repo = opts.repo ?? (await repoFromConfig());
  let prNumber: number | null = null;
  if (opts.pr) {
    const parsedPrNumber = Number.parseInt(opts.pr, 10);
    if (!Number.isInteger(parsedPrNumber) || parsedPrNumber <= 0) {
      throw new Error(`Invalid PR number: ${opts.pr}`);
    }
    prNumber = parsedPrNumber;
  }

  const branch = prNumber ? null : await currentBranch();
  const maxAgeSeconds = Number.parseInt(opts.maxAgeSeconds ?? "0", 10);
  const cached = await readFreshCache(repo, branch, prNumber, maxAgeSeconds);
  if (cached) {
    return cached.summary;
  }

  const { owner, name } = parseRepo(repo);
  const gql = await createGraphQLClient();
  const data = await gql<ReviewCycleQueryResponse>(REVIEW_CYCLE_QUERY, {
    owner,
    name,
    prNumber: prNumber ?? 0,
    headRefName: branch ?? "",
    byNumber: prNumber != null,
    byHead: prNumber == null,
  });

  const pr = selectPullRequest(data);
  const summary = pr ? summarizeReviewCycle(pr) : null;
  await writeCache({ repo, branch, pr: prNumber, checkedAt: Date.now(), summary });
  return summary;
}

async function fetchPullRequestForSubmit(
  gql: Awaited<ReturnType<typeof createGraphQLClient>>,
  owner: string,
  name: string,
  prNumber: number,
): Promise<{ id: string; headRefOid: string }> {
  const data = await gql<ReviewCycleQueryResponse>(REVIEW_CYCLE_QUERY, {
    owner,
    name,
    prNumber,
    headRefName: "",
    byNumber: true,
    byHead: false,
  });
  const pr = selectPullRequest(data);
  if (!pr) throw new Error(`PR #${prNumber} was not found`);
  return { id: pr.id, headRefOid: pr.headRefOid };
}

async function readReviewCyclePlan(path: string): Promise<ReviewCyclePlan> {
  const raw = await readFile(path, "utf-8");
  return ReviewCyclePlanSchema.parse(JSON.parse(raw));
}

async function repoFromConfig(): Promise<string> {
  const config = await new ConfigStore(process.cwd()).read();
  const { owner, repo } = config.project.github;
  return `${owner}/${repo}`;
}

async function currentBranch(): Promise<string | null> {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"]);
  const branch = stdout.trim();
  return branch || null;
}

async function gitDir(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-dir"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function cachePath(): Promise<string | null> {
  const dir = await gitDir();
  return dir ? join(dir, "gh-gantt-review-cycle.json") : null;
}

async function readFreshCache(
  repo: string,
  branch: string | null,
  pr: number | null,
  maxAgeSeconds: number,
): Promise<ReviewCycleCache | null> {
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
  const path = await cachePath();
  if (!path) return null;
  try {
    const [cacheStat, raw] = await Promise.all([stat(path), readFile(path, "utf-8")]);
    if (Date.now() - cacheStat.mtimeMs > maxAgeSeconds * 1000) return null;
    const cache = JSON.parse(raw) as ReviewCycleCache;
    if (cache.repo !== repo || cache.branch !== branch || cache.pr !== pr) return null;
    return cache;
  } catch {
    return null;
  }
}

async function writeCache(cache: ReviewCycleCache): Promise<void> {
  const path = await cachePath();
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2) + "\n");
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
