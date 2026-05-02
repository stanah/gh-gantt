#!/usr/bin/env bash
set -euo pipefail

mode="current-branch"
pr_number=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --current-branch)
      mode="current-branch"
      ;;
    --all-open)
      mode="all-open"
      ;;
    --pr)
      mode="pr"
      pr_number="${2:-}"
      shift
      ;;
    *)
      echo "[gh-gantt workflow] unknown option: $1" >&2
      exit 0
      ;;
  esac
  shift
done

if ! command -v gh >/dev/null 2>&1; then
  exit 0
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  exit 0
fi

repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
if [ -z "$repo" ] || [ "$repo" = "null" ]; then
  exit 0
fi

owner="${repo%%/*}"
name="${repo#*/}"

query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated path line startLine comments(first: 1) { nodes { author { login } body } } } } } } }'

check_pr() {
  local number="$1"
  local state is_draft review_decision url
  state=$(gh pr view "$number" --json state --jq '.state' 2>/dev/null || echo "")
  is_draft=$(gh pr view "$number" --json isDraft --jq '.isDraft' 2>/dev/null || echo "true")
  review_decision=$(gh pr view "$number" --json reviewDecision --jq '.reviewDecision // "UNKNOWN"' 2>/dev/null || echo "UNKNOWN")
  url=$(gh pr view "$number" --json url --jq '.url' 2>/dev/null || echo "")
  review_decision="${review_decision:-UNKNOWN}"

  if [ "$state" != "OPEN" ] || [ "$is_draft" = "true" ]; then
    return 0
  fi

  local unresolved_count non_pass_count
  unresolved_count=$(
    gh api graphql \
      -F owner="$owner" \
      -F name="$name" \
      -F number="$number" \
      -f query="$query" \
      --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' \
      2>/dev/null || true
  )
  unresolved_count="${unresolved_count:-0}"
  non_pass_count=$(
    gh pr checks "$number" \
      --json bucket \
      --jq '[.[] | select(.bucket != "pass" and .bucket != "skipping")] | length' \
      2>/dev/null || true
  )
  non_pass_count="${non_pass_count:-0}"

  if [ "$unresolved_count" = "0" ] && [ "$review_decision" != "CHANGES_REQUESTED" ] && [ "$non_pass_count" = "0" ]; then
    return 0
  fi

  echo "[gh-gantt workflow] PR #$number needs follow-up"
  echo "$url"
  echo "- reviewDecision: $review_decision"
  echo "- unresolved review threads: $unresolved_count"
  echo "- non-passing checks: $non_pass_count"
  echo "Run: gh pr checks $number"
  echo "Then follow: skills/gh-gantt-workflow/references/pr-review-cycle.md"
}

case "$mode" in
  current-branch)
    number=$(gh pr view --json number --jq '.number' 2>/dev/null || true)
    if [ -n "$number" ]; then
      check_pr "$number"
    fi
    ;;
  all-open)
    gh pr list --author @me --state open --json number --jq '.[].number' 2>/dev/null |
      while read -r number; do
        [ -n "$number" ] && check_pr "$number"
      done
    ;;
  pr)
    if [ -n "$pr_number" ]; then
      check_pr "$pr_number"
    fi
    ;;
esac
